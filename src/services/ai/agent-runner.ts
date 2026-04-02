import { createAgentToolRuntime } from '../../tools.js';
import { buildSystemPrompt } from './prompt-builder.js';
import { applyEditsToFiles, getDirsToCheck, parseJsonObject } from './edit-operations.js';
import {
  getCurrentGitDiff,
  getNewCompilationErrors,
  runTypecheckForDirs,
} from './validation-service.js';
import {
  countBroadExplorationCalls,
  hasEnoughTargetEvidence,
  isFatalRuntimeError,
  isFatalToolError,
} from './loop-heuristics.js';
import { createDeepseekChatCompletion } from './client.js';
import type { AIResponse, GenerateCodeParams } from './types.js';

function isFunctionToolCall(
  toolCall: any,
): toolCall is { id: string; function: { name: string; arguments?: string } } {
  return Boolean(toolCall && typeof toolCall.id === 'string' && toolCall.function);
}

export async function generateAndWriteCode({
  repoPath,
  userPrompt,
  figmaData,
  projectTree,
  projectMemory,
  currentDiff,
  onStatusUpdate,
  signal,
}: GenerateCodeParams): Promise<{ targetRoute: string; commitMessage: string; tokenUsage: number }> {
  const toolRuntime = createAgentToolRuntime(repoPath);
  const messages: any[] = [
    {
      role: 'system',
      content: buildSystemPrompt({
        userPrompt,
        figmaData,
        projectTree,
        projectMemory,
        currentDiff,
      }),
    },
    { role: 'user', content: userPrompt },
  ];

  let finalResult: AIResponse | null = null;
  const maxLoops = 100;
  let totalTokens = 0;
  const toolHistory: string[] = [];

  for (let loop = 1; loop <= maxLoops; loop++) {
    if (signal?.aborted) throw new Error('AbortError');

    const statusMsg = `🔄 Iteration ${loop}... Thinking...`;
    if (onStatusUpdate) onStatusUpdate(statusMsg);

    const response = await createDeepseekChatCompletion(
      {
        model: 'deepseek-reasoner',
        messages,
        tools: toolRuntime.tools as any,
        temperature: 0.1,
        max_tokens: 8192,
      },
      { signal },
    );

    if (response.usage) {
      totalTokens += response.usage.total_tokens;
    }

    const message = response.choices?.[0]?.message;
    if (!message) throw new Error('Model returned an empty response.');

    messages.push(message);

    const agentThought = message.content ? message.content.trim() : '';

    if (message.tool_calls?.length) {
      const broadExplorationCount = countBroadExplorationCalls(toolHistory);
      const enoughEvidence = hasEnoughTargetEvidence(toolHistory);

      if (broadExplorationCount >= 3 && enoughEvidence) {
        messages.push({
          role: 'user',
          content: `You already have enough context to implement the smallest requested change.
Stop broad exploration and produce the patch for the minimal valid implementation.
Do not expand the scope unless a concrete blocker remains.`,
        });

        if (onStatusUpdate) {
          onStatusUpdate('⚠️ Jarvis had enough evidence and was redirected to implementation.');
        }

        continue;
      }

      for (const toolCall of message.tool_calls) {
        if (!isFunctionToolCall(toolCall)) {
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: 'Tool error: Unsupported non-function tool call.',
          });
          continue;
        }

        const functionName = toolCall.function.name;
        let toolResult = '';

        try {
          const args = JSON.parse(toolCall.function.arguments || '{}');
          const toolDescriptor = `${functionName}:${args.filepath || args.keyword || args.cmd || ''}`;
          toolHistory.push(toolDescriptor);

          if (onStatusUpdate) {
            onStatusUpdate(
              `🛠️ Executing: ${functionName} -> ${args.filepath || args.keyword || args.cmd}`,
              agentThought,
            );
          }

          if (functionName === 'read_file') {
            toolResult = toolRuntime.readFile(args.filepath, args.startLine, args.endLine);
          } else if (functionName === 'search_project') {
            toolResult = toolRuntime.searchProject(args.keyword, args.maxResults);
          } else if (functionName === 'run_command') {
            toolResult = await toolRuntime.runCommand(args.cmd);
          } else {
            toolResult = `Tool error: Unsupported tool "${functionName}"`;
          }

          if (isFatalToolError(toolResult)) {
            throw new Error(toolResult);
          }
        } catch (error: any) {
          if (isFatalRuntimeError(error)) {
            throw error;
          }

          toolResult = `Tool error: ${error?.message || String(error)}`;
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: functionName,
          content: toolResult,
        });
      }

      continue;
    }

    try {
      finalResult = parseJsonObject<AIResponse>(message.content || '');

      if (agentThought && onStatusUpdate) {
        onStatusUpdate('🧪 Validating syntax and compilation...', agentThought);
      }

      const dirsToCheck = getDirsToCheck(finalResult.edits || []);
      const baselineValidation = await runTypecheckForDirs(repoPath, dirsToCheck);
      const patchErrors = applyEditsToFiles(repoPath, finalResult.edits || []);

      if (patchErrors.length > 0) {
        messages.push({
          role: 'user',
          content: `🚨 PATCH ERROR 🚨
I could not apply your code. The following errors occurred:
${patchErrors.join('\n')}

Please generate a new JSON correcting the 'search' block so it matches the current file exactly.
If the block is ambiguous, make the search more specific so it matches only one location.`,
        });

        if (onStatusUpdate) onStatusUpdate('⚠️ Error injecting code. Jarvis is self-correcting...');
        finalResult = null;
        continue;
      }

      const currentValidation = await runTypecheckForDirs(repoPath, dirsToCheck);
      const newCompilationErrors = getNewCompilationErrors(baselineValidation, currentValidation);

      if (currentValidation.rawOutput.trim() !== '') {
        if (baselineValidation.rawOutput.trim() === '') {
          messages.push({
            role: 'user',
            content: `🚨 COMPILATION ERROR 🚨
Your last changes introduced TypeScript errors in the validated scope.

Errors:
${currentValidation.rawOutput.substring(0, 1200)}

Repair only issues directly related to the files you edited.
Do NOT expand into unrelated project cleanup.
The files ALREADY have your changes applied. Your new 'search' must target the broken code you just wrote.
Generate a new JSON with the smallest fix.`,
          });

          if (onStatusUpdate) onStatusUpdate('⚠️ Compiler detected new errors. Jarvis is rewriting logic...');
          finalResult = null;
          continue;
        }

        if (newCompilationErrors.length > 0) {
          messages.push({
            role: 'user',
            content: `🚨 COMPILATION ERROR 🚨
The project already had TypeScript errors in this scope, but your last changes appear to have introduced ADDITIONAL errors.

New errors detected:
${newCompilationErrors.slice(0, 20).join('\n').substring(0, 1200)}

Only fix errors directly related to the files you edited.
Do NOT try to repair unrelated setup, ORM generation, environment, or infrastructure issues unless they are strictly required for the user's request.
Generate the smallest corrective JSON patch.`,
          });

          if (onStatusUpdate) {
            onStatusUpdate('⚠️ Compiler detected additional errors beyond the baseline. Jarvis is self-correcting...');
          }
          finalResult = null;
          continue;
        }

        if (onStatusUpdate) {
          onStatusUpdate('⚠️ TypeScript still has pre-existing errors in this scope, but no new errors were introduced by the latest edits.');
        }
      }

      if ((finalResult.edits || []).length === 0) {
        const diffAfterValidation = await getCurrentGitDiff(repoPath);
        const hasUnexpectedDiff = diffAfterValidation.trim() !== '' && !currentDiff?.trim();

        if (hasUnexpectedDiff) {
          messages.push({
            role: 'user',
            content: `🚨 RESULT CONSISTENCY ERROR 🚨
You returned "edits": [] but the repository still has uncommitted changes.

This usually means your final JSON does not accurately describe the current state.
Return a corrected JSON that reflects the actual changes needed from the CURRENT repository state, or explicitly clean up unintended changes first.`,
          });

          if (onStatusUpdate) {
            onStatusUpdate('⚠️ Final JSON was inconsistent with repository state. Jarvis is correcting the result...');
          }
          finalResult = null;
          continue;
        }
      }

      if ((finalResult.edits || []).length > 0) {
        const editedTopLevelTargets = new Set(
          finalResult.edits.map((edit) => edit.filepath.split('/')[0]),
        );

        if (finalResult.targetRoute && finalResult.targetRoute !== '/' && editedTopLevelTargets.size === 0) {
          messages.push({
            role: 'user',
            content: `🚨 RESULT COHERENCE ERROR 🚨
Your final result includes a targetRoute but the edits do not clearly reflect an implementation for that flow.
Re-check that your JSON accurately matches the code changes you made and return a corrected JSON.`,
          });

          if (onStatusUpdate) {
            onStatusUpdate('⚠️ Final result was weakly aligned with the implementation. Jarvis is correcting coherence...');
          }

          finalResult = null;
          continue;
        }
      }

      if (onStatusUpdate) onStatusUpdate('✅ Code successfully validated by compiler.');
      break;
    } catch (error) {
      if (isFatalRuntimeError(error)) {
        throw error;
      }

      messages.push({
        role: 'user',
        content: 'Response was not valid JSON or failed to parse. Return exactly one JSON object.',
      });
    }
  }

  if (!finalResult) {
    throw new Error('Agent reached loop limit without passing compilation checks.');
  }

  return {
    targetRoute: finalResult.targetRoute || '/',
    commitMessage: finalResult.commitMessage || 'feat: auto-update',
    tokenUsage: totalTokens,
  };
}
