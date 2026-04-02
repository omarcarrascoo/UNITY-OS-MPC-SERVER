import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonInteraction,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Interaction,
  Message,
} from 'discord.js';
import { approveSession } from '../../application/approve-session.js';
import { createAutonomousRunPlan } from '../../application/run-autonomous-agent.js';
import { runDevelopmentTask } from '../../application/run-development-task.js';
import { initProject } from '../../application/projects/init-project.js';
import { rejectSession } from '../../application/reject-session.js';
import { getProjectByName, getRuntimeConfig } from '../../config.js';
import { RuntimeState } from '../../runtime/state.js';
import { unityStore } from '../../runtime/services.js';
import { getRepositoryStatus, prepareWorkspace } from '../../git.js';
import { getProjectPolicy, normalizePolicy } from '../../services/orchestration/policy-engine.js';

const runtimeConfig = getRuntimeConfig();
const DISCORD_CONTENT_LIMIT = 3800;

function formatAgentStatus(statusMsg: string, thought?: string): string {
  let logMessage = `**${statusMsg}**`;

  if (thought && thought !== '') {
    logMessage += `\n> 💭 *${thought.replace(/\n/g, '\n> ')}*`;
  }

  return logMessage;
}

function chunkDiscordContent(content: string, limit = DISCORD_CONTENT_LIMIT): string[] {
  if (content.length <= limit) {
    return [content];
  }

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit);
    const breakIndex = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));

    if (breakIndex > Math.floor(limit * 0.6)) {
      chunks.push(remaining.slice(0, breakIndex).trimEnd());
      remaining = remaining.slice(breakIndex + 1);
    } else {
      chunks.push(remaining.slice(0, limit).trimEnd());
      remaining = remaining.slice(limit);
    }
  }

  if (remaining.trim()) {
    chunks.push(remaining.trim());
  }

  return chunks;
}

async function sendChunkedThreadMessages(thread: any, content: string): Promise<void> {
  for (const chunk of chunkDiscordContent(content)) {
    await thread.send(chunk).catch(() => {});
  }
}

function buildSessionButtonId(
  action: 'approve' | 'reject',
  projectName: string,
  sessionId: string,
): string {
  return `${action}:${encodeURIComponent(projectName)}:${sessionId}`;
}

function parseButtonContext(customId: string): {
  action: string;
  projectName?: string;
  sessionId?: string;
} {
  if (customId === 'cancel_task') {
    return {
      action: 'cancel',
      sessionId: 'task',
    };
  }

  if (customId.includes(':')) {
    const [action, encodedProjectName, sessionId] = customId.split(':');

    return {
      action,
      projectName: encodedProjectName ? decodeURIComponent(encodedProjectName) : undefined,
      sessionId,
    };
  }

  const [action, sessionId] = customId.split('_');
  return { action, sessionId };
}

async function cleanupLostSession(
  interaction: ButtonInteraction,
  runtime: RuntimeState,
  projectName?: string,
): Promise<void> {
  const project = projectName ? getProjectByName(projectName) : runtime.getActiveProject();

  await rejectSession(project).catch(() => {});

  await interaction.update({
    content:
      `⚠️ No pude encontrar el contexto de esta sesión.\n` +
      `🧹 Limpié el workspace de \`${project.name}\` para destrabarte. Ya puedes empezar otra solicitud.`,
    components: [],
    files: [],
  });
}

export function registerDiscordHandlers(client: Client, runtime: RuntimeState): void {
  client.on('messageCreate', async (message: Message) => {
    if (message.author.bot) return;

    const channelName = (message.channel as any).name;
    if (![runtimeConfig.manualChannelName, runtimeConfig.autonomousChannelName].includes(channelName)) {
      return;
    }

    if (channelName === runtimeConfig.autonomousChannelName) {
      if (runtime.isProcessing()) {
        const warningMsg = await message.reply(
          '⏳ Unity Agent ya está ejecutando otro run. Espera a que termine o cancélalo.',
        );
        setTimeout(() => warningMsg.delete().catch(() => {}), 5000);
        return;
      }

      const project = runtime.getActiveProject();
      const abortController = runtime.startProcessing();
      const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('cancel_task')
          .setLabel('🛑 Cancelar Run')
          .setStyle(ButtonStyle.Secondary),
      );

      const replyMessage = await message.reply({
        content: '🤖 Unity Agent received the request. Planning autonomous execution...',
        components: [cancelRow],
      });

      const thread = await message.startThread({
        name:
          message.content.length > 20
            ? `⚙️ Unity Agent - ${message.content.substring(0, 20)}...`
            : `⚙️ Unity Agent - ${message.content}`,
        autoArchiveDuration: 60,
      });

      try {
        const result = await createAutonomousRunPlan({
          project,
          prompt: message.content,
          channelName,
          mode: 'interactive',
          signal: abortController.signal,
          onProgress: async (progressMessage) => {
            await thread.send(progressMessage).catch(() => {});
          },
        });

        const taskLines = result.tasks
          .map(
            (task) =>
              `- ${task.title}\n  scope: ${task.writeScope.join(', ')}${
                task.dependencies.length ? `\n  deps: ${task.dependencies.join(', ')}` : ''
              }`,
          )
          .join('\n');

        await replyMessage.edit({
          content: [
            '🗺️ **Unity Agent Plan Ready**',
            `🆔 Run: \`${result.runId}\``,
            `🌿 Branch: \`${result.branchName}\``,
            `🔀 Merge target later: \`${result.defaultBranch}\``,
            `🧠 Approval required: \`${result.requiresApproval ? 'yes' : 'no'}\``,
            `🌐 Review plan: ${result.consoleUrl}`,
            '',
            'Approve or reject the plan from the local console.',
          ].join('\n'),
          components: [],
        });

        await sendChunkedThreadMessages(
          thread,
          `**Plan Summary**\n${result.planSummary}\n\n**Review in console**\n${result.consoleUrl}`,
        );

        if (taskLines) {
          await sendChunkedThreadMessages(thread, `**Planned Tasks**\n${taskLines}`);
        }

        await thread.setArchived(true);
      } catch (error: any) {
        if (error.message === 'AbortError' || error.name === 'AbortError') {
          await replyMessage.edit({
            content: '🛑 **Unity Agent Run Cancelled.**',
            components: [],
          });
          await thread.send('🛑 Autonomous run cancelled by the user.');
          await thread.setArchived(true);
        } else {
          console.error(error);
          const safeError =
            error.message.length > 1500 ? `${error.message.substring(0, 1500)}...` : error.message;
          await thread.send(`❌ **AUTONOMOUS RUN ERROR:**\n\`\`\`bash\n${safeError}\n\`\`\``);
          await replyMessage.edit({
            content: '❌ Unity Agent encountered an error. Check the thread for logs.',
            components: [],
          });
        }
      } finally {
        runtime.finishProcessing();
      }

      return;
    }

    if (runtime.isProcessing()) {
      const warningMsg = await message.reply(
        '⏳ **¡Paciencia!** Jarvis está procesando otra solicitud en este momento. Espera a que termine o cancélala.',
      );
      setTimeout(() => warningMsg.delete().catch(() => {}), 5000);
      return;
    }

    const project = runtime.getActiveProject();
    const isIteration = !!message.reference;

    if (!isIteration) {
      const gitStatus = await getRepositoryStatus(project);

      if (gitStatus.trim() !== '') {
        await message.reply(
          '⚠️ **¡Seguro Activado!** Tienes trabajo en progreso sin guardar.\n\n👉 Para iterar sobre el código actual, debes darle a **"Responder"** (Reply) al mensaje anterior.\n👉 Si realmente quieres empezar una tarea nueva, presiona el botón rojo `🗑️ Revert` del mensaje anterior para limpiar el entorno.',
        );
        return;
      }
    }

    const abortController = runtime.startProcessing();
    const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('cancel_task')
        .setLabel('🛑 Cancelar Tarea')
        .setStyle(ButtonStyle.Secondary),
    );

    const replyMessage = await message.reply({
      content: isIteration
        ? '🤖 Acknowledged. Agent waking up for iteration...'
        : '🤖 Acknowledged. Preparing a fresh workspace...',
      components: [cancelRow],
    });

    const thread = await message.startThread({
      name:
        message.content.length > 20
          ? `🧠 Jarvis Logs - ${message.content.substring(0, 20)}...`
          : `🧠 Jarvis Logs - ${message.content}`,
      autoArchiveDuration: 60,
    });

    try {
      const result = await runDevelopmentTask({
        project,
        prompt: message.content,
        isIteration,
        signal: abortController.signal,
        onProgress: async (progressMessage) => {
          await thread.send(progressMessage).catch(() => {});
        },
        onAgentStatusUpdate: async (status, thought) => {
          await thread.send(formatAgentStatus(status, thought)).catch(() => {});
        },
      });

      runtime.rememberSession(result.sessionId, result.commitMessage, project.name);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildSessionButtonId('approve', project.name, result.sessionId))
          .setLabel('✅ Approve & PR')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(buildSessionButtonId('reject', project.name, result.sessionId))
          .setLabel('🗑️ Revert (Start Over)')
          .setStyle(ButtonStyle.Danger),
      );

      const finalContent = `✨ **Ready!**\n📝 **Commit:** \`${result.commitMessage}\`\n💰 **Tokens Used:** \`${result.tokenUsage.toLocaleString()}\`\n🏠 **Local:** ${result.localUrl}\n📱 **Mobile (Wi-Fi):** ${result.publicUrl ? result.publicUrl : 'Unavailable'}\n\n👉 **¿Quieres iterar?** Simplemente RESPONDE a este mensaje con tus correcciones.\n${result.warning ? `\n⚠️ *${result.warning}*` : ''}`;

      const filesToAttach = [];
      if (result.snapshotPath) filesToAttach.push(new AttachmentBuilder(result.snapshotPath));
      if (result.diffPath) filesToAttach.push(new AttachmentBuilder(result.diffPath));

      if (filesToAttach.length > 0) {
        await replyMessage.edit({ content: finalContent, files: filesToAttach, components: [row] });
      } else {
        await replyMessage.edit({ content: finalContent, components: [row] });
      }

      await thread.send('✅ Task completed. Archiving thread.');
      await thread.setArchived(true);
    } catch (error: any) {
      if (error.message === 'AbortError' || error.name === 'AbortError') {
        await rejectSession(project).catch(() => {});
        await thread.send('🛑 **Misión Abortada:** El usuario canceló la tarea. El repositorio ha sido restaurado.');
        await replyMessage.edit({
          content: '🛑 **Tarea Cancelada.** El entorno está limpio y listo para otra solicitud.',
          components: [],
        });
        await thread.setArchived(true);
      } else {
        console.error(error);
        const safeError =
          error.message.length > 1500 ? `${error.message.substring(0, 1500)}...` : error.message;
        await thread.send(`❌ **CRITICAL ERROR:**\n\`\`\`bash\n${safeError}\n\`\`\``);
        await replyMessage.edit({
          content: '❌ Error encountered. Please check the thread logs for details.',
          components: [],
        });
      }
    } finally {
      runtime.finishProcessing();
    }
  });

  client.on('interactionCreate', async (interaction: Interaction) => {
    if (interaction.isButton()) {
      const { action, projectName, sessionId } = parseButtonContext(interaction.customId);

      if (action === 'cancel' && sessionId === 'task') {
        if (runtime.abortCurrentTask()) {
          await interaction.update({
            content: '🛑 Interceptando a Jarvis... abortando procesos.',
            components: [],
          });
        } else {
          await interaction.update({ content: '⚠️ No hay ninguna tarea corriendo.', components: [] });
        }
        return;
      }

      if (runtime.isProcessing()) {
        await interaction.reply({
          content: '⏳ Jarvis está ocupado en otra tarea. Espera a que termine.',
          ephemeral: true,
        });
        return;
      }

      runtime.startProcessing();

      try {
        if (!sessionId) {
          await cleanupLostSession(interaction, runtime, projectName);
          return;
        }

        const sessionRecord = runtime.getSessionRecord(sessionId);

        if (!sessionRecord) {
          await cleanupLostSession(interaction, runtime, projectName);
          return;
        }

        const project = getProjectByName(sessionRecord.projectName);

        if (action === 'approve') {
          await interaction.update({
            content: '🚀 Analyzing all session changes to generate a Smart PR...',
            components: [],
            files: [],
          });

          const prUrl = await approveSession({
            project,
            sessionId,
            fallbackCommitMessage: sessionRecord.commitMessage,
          });

          await interaction.followUp(`✅ **Smart Pull Request successfully created!**\n🔗 Review here: ${prUrl}`);
          runtime.deleteSession(sessionId);
          return;
        }

        if (action === 'reject') {
          await rejectSession(project);
          await interaction.update({
            content: '🗑️ **Cambios revertidos.** El repositorio ha vuelto a su estado original limpio.',
            components: [],
            files: [],
          });
          runtime.deleteSession(sessionId);
        }
      } catch (error) {
        console.error(error);

        if (interaction.isRepliable()) {
          await interaction.followUp('❌ Failed to process the session action.').catch(() => {});
        }
      } finally {
        runtime.finishProcessing();
      }

      return;
    }

    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === 'status') {
        const projectPolicy = getProjectPolicy(unityStore, runtime.getActiveProjectName());
        await interaction.reply(
          `🤖 **Estado Actual:**\nJarvis está enfocado en el repositorio: \`${runtime.getActiveProjectName()}\`\nProcesando tarea: ${runtime.isProcessing() ? 'Sí 🔴' : 'No 🟢'}\nCanal manual: \`#${runtimeConfig.manualChannelName}\`\nCanal autónomo: \`#${runtimeConfig.autonomousChannelName}\`\nConsola local: \`http://localhost:${runtimeConfig.localConsolePort}\`\nBranch autónoma: \`${projectPolicy.integrationBranchName}\`\nAutoapprove nightly plan: \`${projectPolicy.autoApprovePlan ? 'on' : 'off'}\`\nParalelismo: \`${projectPolicy.maxParallelTasks}\` | Retries: \`${projectPolicy.maxRetriesPerTask}\` | Horas: \`${projectPolicy.maxHours}\` | Commits: \`${projectPolicy.maxCommits}\``,
        );
        return;
      }

      if (commandName === 'policy') {
        const projectName = runtime.getActiveProjectName();
        const currentPolicy = getProjectPolicy(unityStore, projectName);
        const updatedPolicy = normalizePolicy({
          ...currentPolicy,
          maxHours: interaction.options.getInteger('hours') ?? currentPolicy.maxHours,
          maxCommits: interaction.options.getInteger('commits') ?? currentPolicy.maxCommits,
          maxParallelTasks: interaction.options.getInteger('parallel') ?? currentPolicy.maxParallelTasks,
          maxRetriesPerTask: interaction.options.getInteger('retries') ?? currentPolicy.maxRetriesPerTask,
          maxImprovementCycles:
            interaction.options.getInteger('improvements') ?? currentPolicy.maxImprovementCycles,
          autoApprovePlan:
            interaction.options.getBoolean('autoapproveplan') ?? currentPolicy.autoApprovePlan,
        });

        unityStore.upsertPolicy(projectName, updatedPolicy);

        await interaction.reply(
          `⚙️ **Política actualizada para \`${projectName}\`**\nBranch: \`${updatedPolicy.integrationBranchName}\`\nAutoapprove nightly plan: \`${updatedPolicy.autoApprovePlan ? 'on' : 'off'}\`\nHoras: \`${updatedPolicy.maxHours}\`\nCommits: \`${updatedPolicy.maxCommits}\`\nParalelismo: \`${updatedPolicy.maxParallelTasks}\`\nRetries: \`${updatedPolicy.maxRetriesPerTask}\`\nSelf-improvement cycles: \`${updatedPolicy.maxImprovementCycles}\``,
        );
        return;
      }

      if (runtime.isProcessing()) {
        await interaction.reply({
          content: '⏳ Jarvis está ocupado en una tarea. Espera antes de cambiar el contexto.',
          ephemeral: true,
        });
        return;
      }

      if (commandName === 'workon') {
        const repoName = interaction.options.getString('repo', true);
        const project = runtime.setActiveProject(repoName);

        await interaction.reply(
          `🔄 **Cambio de Contexto:**\nJarvis ha movido su atención a \`${repoName}\`.\nEscaneando arquitectura...`,
        );

        try {
          await prepareWorkspace(project);
          await interaction.followUp(`✅ Arquitectura de \`${repoName}\` lista para trabajar.`);
        } catch (error: any) {
          await interaction.followUp(`⚠️ Error al preparar el workspace: ${error.message}`);
        }

        return;
      }

      if (commandName === 'init') {
        const type = interaction.options.getString('type', true);
        const name = interaction.options.getString('name', true);

        await interaction.reply(
          `🏗️ **Construyendo Base:** Iniciando scaffold de \`${name}\` (${type})...\n*Por favor espera, esto puede tomar 1 o 2 minutos.*`,
        );

        try {
          await initProject(type, name);
          await interaction.followUp(
            `✅ **Proyecto \`${name}\` creado exitosamente.**\n👉 Usa \`/workon repo:${name}\` para decirle a Jarvis que empiece a trabajar en él.`,
          );
        } catch (error: any) {
          await interaction.followUp(`❌ Error al crear el proyecto: ${error.message}`);
        }
      }
    }
  });
}
