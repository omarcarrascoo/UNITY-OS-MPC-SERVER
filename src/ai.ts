import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import { TARGET_REPO_PATH } from './config.js';
import { agentTools, readFile, searchProject, runCommand } from './tools.js'; 

const execPromise = util.promisify(exec);

export interface FileEdit { filepath: string; search: string; replace: string; }
export interface AIResponse { targetRoute: string; commitMessage: string; edits: FileEdit[]; }

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

function buildSystemPrompt(userPrompt: string, figmaData: string | null, projectTree: string, projectMemory: string | null): string {
  const figmaInstructions = figmaData ? `FIGMA JSON CONTEXT:\n${figmaData}` : 'FIGMA JSON CONTEXT: (none)';
  
  const memoryInstructions = projectMemory 
    ? `\n\n### 🧠 STRICT PROJECT RULES (.unityrc.md) 🧠\nYou MUST strictly follow these architectural rules for this project:\n${projectMemory}\n` 
    : '';

  return `
You are Jarvis, a senior autonomous software architect.

PROJECT TREE
${projectTree || '(empty)'}

${REPO_PATTERNS}
${figmaInstructions}${memoryInstructions}

USER OBJECTIVE
"${userPrompt}"

TOOL USAGE CONTRACT
1) ONLY inspect files with 'read_file' if modifying them is strictly necessary. Do NOT read files for simple creations (like READMEs).
2) If you use 'read_file', ONLY read the specific lines you need (use startLine and endLine).
3) Use 'search_project' to find unknown components.
4) Use 'run_command' ONLY to execute system/dependency commands (e.g., "cd app-folder && npm install package-name" or "npx tsc"). 
5) CRITICAL RULE: DO NOT use 'run_command' to create or modify code files (no 'touch', 'echo', or 'cat'). All file creations and modifications MUST be done via the FINAL OUTPUT JSON.
6) Before calling a tool, you MUST write a brief 1-2 sentence explanation of your thought process in the message content.

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

function resolveSafeFilePath(relativeFilePath: string): string {
  const repoRoot = path.resolve(TARGET_REPO_PATH);
  const fullPath = path.resolve(repoRoot, relativeFilePath);
  if (fullPath !== repoRoot && !fullPath.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error(`Blocked unsafe path: ${relativeFilePath}`);
  }
  return fullPath;
}

// Función para inyectar código y detectar errores de parcheo
function applyEditsToFiles(edits: FileEdit[]): string[] {
    const patchErrors: string[] = [];
    
    for (const edit of edits) {
        if (!edit.filepath) continue;
        const fullPath = resolveSafeFilePath(edit.filepath);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        if (!fs.existsSync(fullPath) || edit.search.trim() === "") {
            fs.writeFileSync(fullPath, edit.replace, 'utf8'); 
            continue;
        }

        let content = fs.readFileSync(fullPath, 'utf8');
        if (content.includes(edit.search)) {
            content = content.replace(edit.search, edit.replace);
            fs.writeFileSync(fullPath, content, 'utf8');
        } else {
            patchErrors.push(`⚠️ Error in ${edit.filepath}: Exact 'search' block not found. You must match spaces and line breaks perfectly.`);
        }
    }
    return patchErrors;
}

export async function generateAndWriteCode(
  userPrompt: string,
  figmaData: string | null,
  projectTree: string,
  projectMemory: string | null,
  onStatusUpdate?: (status: string, thought?: string) => void
): Promise<{ targetRoute: string; commitMessage: string; tokenUsage: number }> {
  
  const openai = new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey: process.env.DEEPSEEK_API_KEY as string });

  const messages: any[] = [
    { role: 'system', content: buildSystemPrompt(userPrompt, figmaData, projectTree, projectMemory) },
    { role: 'user', content: userPrompt },
  ];

  let finalResult: AIResponse | null = null;
  const MAX_LOOPS = 100;
  let totalTokens = 0; 

  for (let loop = 1; loop <= MAX_LOOPS; loop++) {
    const statusMsg = `🔄 Iteration ${loop}... Thinking...`;
    console.log(statusMsg);
    if (onStatusUpdate) onStatusUpdate(statusMsg);

    const response = await openai.chat.completions.create({
      model: 'deepseek-chat',
      messages,
      tools: agentTools,
      temperature: 0.1,
      max_tokens: 8192,
    });

    if (response.usage) {
      totalTokens += response.usage.total_tokens;
    }

    const message = response.choices?.[0]?.message;
    if (!message) throw new Error('Model returned an empty response.');

    messages.push(message);

    const agentThought = message.content ? message.content.trim() : "";

    // Manejo de herramientas (read_file, etc.)
    if (message.tool_calls?.length) {
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

        messages.push({ role: 'tool', tool_call_id: toolCall.id, name: functionName, content: toolResult });
      }
      continue;
    }

    // Análisis de salida JSON
    const modelText = message.content || '';
    try {
      const candidate = extractJsonObject(modelText);
      finalResult = JSON.parse(candidate) as AIResponse;
      
      if (agentThought && onStatusUpdate) onStatusUpdate(`🧪 Validating syntax and compilation...`, agentThought);

      // BUCLE DE AUTO-SANACIÓN PASO 1: Inyectar y verificar Patch
      const patchErrors = applyEditsToFiles(finalResult.edits || []);
      if (patchErrors.length > 0) {
          messages.push({ 
              role: 'user', 
              content: `🚨 PATCH ERROR 🚨\nI could not apply your code. The following errors occurred:\n${patchErrors.join('\n')}\n\nPlease generate a new JSON correcting the 'search' block so it matches the current file exactly.` 
          });
          if (onStatusUpdate) onStatusUpdate(`⚠️ Error injecting code. Jarvis is self-correcting...`);
          finalResult = null;
          continue; 
      }

      // BUCLE DE AUTO-SANACIÓN PASO 2: Verificar TypeScript (Nest/Expo)
      let compilationErrors = '';
      
      const dirsToCheck = new Set((finalResult.edits || []).map(e => {
          const parts = e.filepath.split('/');
          return parts.length > 1 ? parts[0] : '.'; 
      }));

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

      // 📉 Truncamos el error a 800 caracteres máximo para ahorrar tokens
      if (compilationErrors.trim() !== '') {
          messages.push({ 
              role: 'user', 
              content: `🚨 COMPILATION ERROR 🚨\nYour last changes broke TypeScript. Here are the errors:\n${compilationErrors.substring(0, 800)}\n\nNote: The files ALREADY have your changes applied. Your new 'search' must target the broken code you just wrote. Generate a new JSON with the fix.` 
          });
          if (onStatusUpdate) onStatusUpdate(`⚠️ Compiler detected an error. Jarvis is rewriting logic...`);
          finalResult = null;
          continue;
      }

      if (onStatusUpdate) onStatusUpdate(`✅ Code successfully validated by compiler.`);
      break; 

    } catch (e) {
      messages.push({ role: 'user', content: 'Response was not valid JSON or failed to parse. Return exactly one JSON object.' });
    }
  }

  if (!finalResult) throw new Error('Agent reached loop limit without passing compilation checks.');

  return { targetRoute: finalResult.targetRoute || '/', commitMessage: finalResult.commitMessage || 'feat: auto-update', tokenUsage: totalTokens };
}