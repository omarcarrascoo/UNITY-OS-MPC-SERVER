import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import { TARGET_REPO_PATH } from './config.js';
import { agentTools, readFile, searchProject, runCommand } from './tools.js';

const execPromise = util.promisify(exec);

export interface FileEdit {
  filepath: string;
  search: string;
  replace: string;
}

export interface AIResponse {
  targetRoute: string;
  commitMessage: string;
  edits: FileEdit[];
}

// Stable repository heuristics injected into the system prompt for architectural consistency.
const REPO_PATTERNS = `
REPOSITORY OVERVIEW
- Monorepos structure: frontends (expo) and backends (nest/api).
- Single repos: standard expo app.

FRONTEND PATTERNS (Expo)
- Routes live in app/.
- Reuse UI blocks from components/ui.
- Use theme tokens from theme/index.ts.

BACKEND PATTERNS (NestJS)
- Keep domain structure: module + controller + service + schema + dto.

DELIVERY RULES
- Do minimal edits.
- Use "search" and "replace" blocks to patch files. The "search" string MUST perfectly match existing code.
`;

// Assembles static policies with dynamic context (tree, memory, figma, and current diff).
function buildSystemPrompt(
  userPrompt: string,
  figmaData: string | null,
  projectTree: string,
  projectMemory: string | null,
  currentDiff: string | null,
): string {
  const figmaInstructions = figmaData ? `FIGMA JSON CONTEXT:\n${figmaData}` : 'FIGMA JSON CONTEXT: (none)';

  const memoryInstructions = projectMemory
    ? `\n\n### 🧠 STRICT PROJECT RULES (.unityrc.md) 🧠\nYou MUST strictly follow these architectural rules for this project:\n${projectMemory}\n`
    : '';

  const diffInstructions = currentDiff
    ? `\n\n### 📝 UNCOMMITTED CHANGES (SHORT-TERM MEMORY) 📝\nYou are in an iteration. You have ALREADY made the following changes in this session. DO NOT undo them unless explicitly asked. Use this as context for what you just built:\n\`\`\`diff\n${currentDiff.substring(0, 4000)}\n\`\`\`\n`
    : '';

  return `
You are Jarvis, a senior autonomous software architect.

PROJECT TREE
${projectTree || '(empty)'}

${REPO_PATTERNS}
${figmaInstructions}${memoryInstructions}${diffInstructions}

USER OBJECTIVE
"${userPrompt}"

TOOL USAGE CONTRACT
1) ONLY inspect files with 'read_file' if modifying them is strictly necessary. Do NOT read files for simple creations (like READMEs).
2) If you use 'read_file', ONLY read the specific lines you need (use startLine and endLine).
3) Use 'search_project' to find unknown components.
4) Use 'run_command' ONLY to execute system/dependency commands (e.g., "cd app-folder && npm install package-name" or "npx tsc").
5) CRITICAL RULE: DO NOT use 'run_command' to create or modify code files (no 'touch', 'echo', or 'cat'). All file creations and modifications MUST be done via the FINAL OUTPUT JSON.
6) Before calling a tool, you MUST write a brief 1-2 sentence explanation of your thought process in the message content.
7) 🧠 CONTEXT EXPANSION: I have provided your recent uncommitted changes in the prompt below. However, you can STILL use 'run_command' with 'git status', 'git diff <file>', or 'git log' if you need to investigate other parts of the repository history.

FINAL OUTPUT CONTRACT (STRICT)
- Return exactly ONE valid JSON object.
- JSON shape:
{
  "targetRoute": "/path",
  "commitMessage": "feat: summary",
  "edits": [
    {
      "filepath": "relative/path.ts",
      "search": "exact code to replace",
      "replace": "new code"
    }
  ]
}
- If creating a NEW file, leave "search" empty.
  `;
}

// Extracts the first valid JSON object from model text that may include markdown wrappers.
function extractJsonObject(raw: string): string {
  let text = (raw || '').trim().replace(/```json/gi, '').replace(/```/g, '').trim();
  text = text.replace(/[\u00A0\u2028\u2029\u200B]/g, ' ');

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }

  throw new Error('No JSON object found.');
}

// Guards file writes so generated edits cannot escape the active repository root.
function resolveSafeFilePath(relativeFilePath: string): string {
  const repoRoot = path.resolve(TARGET_REPO_PATH);
  const fullPath = path.resolve(repoRoot, relativeFilePath);

  if (fullPath !== repoRoot && !fullPath.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error(`Blocked unsafe path: ${relativeFilePath}`);
  }

  return fullPath;
}

function countOccurrences(content: string, search: string): number {
  if (!search) return 0;

  let count = 0;
  let searchStartIndex = 0;

  while (true) {
    const foundIndex = content.indexOf(search, searchStartIndex);
    if (foundIndex === -1) break;

    count += 1;
    searchStartIndex = foundIndex + search.length;
  }

  return count;
}

// Applies search/replace patches; "search" empty means create or overwrite file content.
function applyEditsToFiles(edits: FileEdit[]): string[] {
  const patchErrors: string[] = [];

  for (const edit of edits) {
    if (!edit.filepath) continue;

    const fullPath = resolveSafeFilePath(edit.filepath);
    const dir = path.dirname(fullPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(fullPath) || edit.search.trim() === '') {
      fs.writeFileSync(fullPath, edit.replace, 'utf8');
      continue;
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    const occurrences = countOccurrences(content, edit.search);

    if (occurrences === 0) {
      patchErrors.push(
        `⚠️ Error in ${edit.filepath}: Exact 'search' block not found. You must match spaces and line breaks perfectly.`,
      );
      continue;
    }

    if (occurrences > 1) {
      patchErrors.push(
        `⚠️ Error in ${edit.filepath}: Ambiguous 'search' block. Found ${occurrences} matches. Provide a more specific block.`,
      );
      continue;
    }

    const updatedContent = content.replace(edit.search, edit.replace);
    fs.writeFileSync(fullPath, updatedContent, 'utf8');
  }

  return patchErrors;
}

// Main generation loop: tool calls + patching + compile validation + self-correction retries.
export async function generateAndWriteCode(
  userPrompt: string,
  figmaData: string | null,
  projectTree: string,
  projectMemory: string | null,
  currentDiff: string | null,
  onStatusUpdate?: (status: string, thought?: string) => void,
  signal?: AbortSignal,
): Promise<{ targetRoute: string; commitMessage: string; tokenUsage: number }> {
  const openai = new OpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY as string,
  });

  const messages: any[] = [
    { role: 'system', content: buildSystemPrompt(userPrompt, figmaData, projectTree, projectMemory, currentDiff) },
    { role: 'user', content: userPrompt },
  ];

  let finalResult: AIResponse | null = null;
  const MAX_LOOPS = 100;
  let totalTokens = 0;

  for (let loop = 1; loop <= MAX_LOOPS; loop++) {
    // Stop before each iteration so cancellation does not trigger extra work.
    if (signal?.aborted) throw new Error('AbortError');

    const statusMsg = `🔄 Iteration ${loop}... Thinking...`;
    console.log(statusMsg);
    if (onStatusUpdate) onStatusUpdate(statusMsg);

    const response = await openai.chat.completions.create(
      {
        model: 'deepseek-chat',
        messages,
        tools: agentTools,
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
      // Execute tool calls and append outputs as tool-role messages for the next model turn.
      for (const toolCall of message.tool_calls) {
        const functionName = toolCall.function.name;
        let toolResult = '';

        try {
          const args = JSON.parse(toolCall.function.arguments || '{}');
          const toolMsg = `🛠️ Executing: ${functionName} -> ${args.filepath || args.keyword || args.cmd}`;
          console.log(toolMsg);

          if (onStatusUpdate) onStatusUpdate(toolMsg, agentThought);

          if (functionName === 'read_file') {
            toolResult = readFile(args.filepath, args.startLine, args.endLine);
          } else if (functionName === 'search_project') {
            toolResult = searchProject(args.keyword, args.maxResults);
          } else if (functionName === 'run_command') {
            toolResult = await runCommand(args.cmd);
          }
        } catch (error: any) {
          toolResult = `Tool error: ${error.message}`;
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

    const modelText = message.content || '';

    try {
      const candidate = extractJsonObject(modelText);
      finalResult = JSON.parse(candidate) as AIResponse;

      if (agentThought && onStatusUpdate) {
        onStatusUpdate('🧪 Validating syntax and compilation...', agentThought);
      }

      const patchErrors = applyEditsToFiles(finalResult.edits || []);
      if (patchErrors.length > 0) {
        messages.push({
          role: 'user',
          content: `🚨 PATCH ERROR 🚨\nI could not apply your code. The following errors occurred:\n${patchErrors.join('\n')}\n\nPlease generate a new JSON correcting the 'search' block so it matches the current file exactly. If the block is ambiguous, make the search more specific so it matches only one location.`,
        });

        if (onStatusUpdate) onStatusUpdate('⚠️ Error injecting code. Jarvis is self-correcting...');
        finalResult = null;
        continue;
      }

      let compilationErrors = '';

      // Compile only touched top-level folders to keep validation time bounded on monorepos.
      const dirsToCheck = new Set(
        (finalResult.edits || []).map((e) => {
          const parts = e.filepath.split('/');
          return parts.length > 1 ? parts[0] : '.';
        }),
      );

      for (const dir of dirsToCheck) {
        const checkPath = dir === '.' ? TARGET_REPO_PATH : path.join(TARGET_REPO_PATH, dir);

        if (fs.existsSync(path.join(checkPath, 'tsconfig.json'))) {
          try {
            await execPromise(`npx tsc --noEmit`, { cwd: checkPath });
          } catch (err: any) {
            compilationErrors += `\n[Error in ${dir}]:\n${err.stdout || err.message}\n`;
          }
        }
      }

      if (compilationErrors.trim() !== '') {
        messages.push({
          role: 'user',
          content: `🚨 COMPILATION ERROR 🚨\nYour last changes broke TypeScript. Here are the errors:\n${compilationErrors.substring(0, 800)}\n\nNote: The files ALREADY have your changes applied. Your new 'search' must target the broken code you just wrote. Generate a new JSON with the fix.`,
        });

        if (onStatusUpdate) onStatusUpdate('⚠️ Compiler detected an error. Jarvis is rewriting logic...');
        finalResult = null;
        continue;
      }

      if (onStatusUpdate) onStatusUpdate('✅ Code successfully validated by compiler.');
      break;
    } catch {
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

// Summarizes the accumulated diff into a conventional commit for PR title/body usage.
export async function generatePRMetadata(diff: string): Promise<string> {
  const openai = new OpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY as string,
  });

  const prompt = `You are an expert developer. I will provide you with a git diff of the work done in this session.
  Please generate a conventional commit message that summarizes ALL the changes comprehensively.
  Format it as a single string where the first line is the conventional commit title (e.g., feat: added login screen), followed by a blank line, and then a brief bulleted list of the key changes.

  GIT DIFF:
  ${diff.substring(0, 6000)}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 500,
    });

    return response.choices[0]?.message?.content?.trim() || 'feat: accumulated session updates';
  } catch (error) {
    console.error('Error generating Smart PR:', error);
    return 'feat: accumulated session updates';
  }
}