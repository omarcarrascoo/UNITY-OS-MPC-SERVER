import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, Message, Interaction } from 'discord.js';
import 'dotenv/config';

import { TARGET_REPO_PATH } from './src/config.js';
import { prepareWorkspace, createPullRequest } from './src/git.js';
import { getProjectTree } from './src/scanner.js'; // 🗺️ Ahora importamos el árbol
import { getFigmaContext } from './src/figma.js';
import { takeSnapshot } from './src/snapshot.js';
import { generateAndWriteCode } from './src/ai.js';

const client = new Client({ intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent ]});

const sessionStore = new Map<string, string>();

client.on('messageCreate', async (message: Message) => {
    if (message.author.bot || (message.channel as any).name !== 'jarvis-dev') return;

    const isIteration = !!message.reference;

    const replyMessage = await message.reply(
        isIteration 
        ? '🤖 Acknowledged. Agent iterating over current modifications...' 
        : '🤖 Acknowledged. Preparing a fresh workspace...'
    );

    try {
        if (!isIteration) {
            await prepareWorkspace();
        }
        
        const figmaData = await getFigmaContext(message.content);
        if (figmaData) await replyMessage.edit('🎨 Figma link detected. Analyzing design...');
        
        // 🗺️ Generamos el mapa ligero del proyecto
        const projectTree = getProjectTree(TARGET_REPO_PATH);
        
        const finalPrompt = isIteration 
            ? `We are iterating on the current code. Keep the recent changes but apply this correction: "${message.content}"` 
            : message.content;

        // Pasamos el árbol al Agente
        const { targetRoute, commitMessage } = await generateAndWriteCode(finalPrompt, figmaData, projectTree);
        
        const sessionId = Date.now().toString().slice(-6);
        sessionStore.set(sessionId, commitMessage);
        
        await replyMessage.edit(`📸 Code generated. Navigating to \`${targetRoute}\`...`);
        const actualSnapshotPath = await takeSnapshot(targetRoute);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`approve_${sessionId}`).setLabel('✅ Approve & Create PR').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`reject_${sessionId}`).setLabel('🔄 Reject / Iterate').setStyle(ButtonStyle.Danger),
        );

        await replyMessage.edit({ 
            content: `✨ Ready! (Agent: DEEPSEEK)\n📝 **Commit:** \`${commitMessage}\``,
            files: [new AttachmentBuilder(actualSnapshotPath)],
            components: [row]
        });

    } catch (error: any) {
        console.error(error);
        const safeError = error.message.length > 1500 ? error.message.substring(0, 1500) + '...' : error.message;
        await replyMessage.edit(`❌ Error:\n\`\`\`bash\n${safeError}\n\`\`\``);
    }
});

client.on('interactionCreate', async (interaction: Interaction) => {
    if (!interaction.isButton()) return;

    const [action, sessionId] = interaction.customId.split('_');

    if (action === 'approve') {
        await interaction.update({ content: '🚀 Creating PR with exact commit message...', components: [], files: [] });
        
        try {
            const exactCommitMessage = sessionStore.get(sessionId) || 'feat: update from Jarvis';
            const featureName = `req-${sessionId}`; 
            
            const prUrl = await createPullRequest(featureName, exactCommitMessage);
            await interaction.followUp(`✅ **Pull Request successfully created!**\n🔗 Review here: ${prUrl}`);
            
            sessionStore.delete(sessionId);
        } catch (error) {
            console.error(error);
            await interaction.followUp(`❌ Failed to create PR.`);
        }
    } else if (action === 'reject') {
        await interaction.update({ 
            content: '🛑 Operation cancelled.\n👉 **To iterate:** Reply to this message with your corrections.\n👉 **To start over:** Send a new regular message.', 
            components: [], 
            files: [] 
        });
        sessionStore.delete(sessionId);
    }
});

client.login(process.env.DISCORD_TOKEN as string);
console.log('🤖 Jarvis Git Flow Agent listening on Discord...');