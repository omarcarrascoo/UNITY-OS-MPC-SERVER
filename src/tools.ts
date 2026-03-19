import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import { TARGET_REPO_PATH } from './config.js';

const execPromise = util.promisify(exec);

const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.expo',
  'ios',
  'android',
  '.next',
]);

const SOURCE_FILE_REGEX = /\.(ts|tsx|js|jsx|json|md)$/i;
const SAFE_NPM_RUN_SCRIPTS = new Set(['lint', 'test', 'typecheck', 'build', 'start']);

function getRepoRoot(): string {
  return path.resolve(TARGET_REPO_PATH);
}

// Prevents path traversal when the model requests file reads.
function resolveSafePath(relativePath: string): string {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('Invalid path: expected non-empty relative path string.');
  }

  const repoRoot = getRepoRoot();
  const fullPath = path.resolve(repoRoot, relativePath);

  if (fullPath !== repoRoot && !fullPath.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error(`Path is outside repo root: ${relativePath}`);
  }

  return fullPath;
}

// Returns a numbered line window so model edits can target exact ranges.
function lineSlice(content: string, startLine = 1, endLine = 300): string {
  const lines = content.split('\n');
  const safeStart = Math.max(1, Math.floor(startLine));
  const safeEnd = Math.max(safeStart, Math.floor(endLine));
  const clippedEnd = Math.min(lines.length, safeEnd);

  const selected = lines.slice(safeStart - 1, clippedEnd);
  return selected
    .map((line, index) => {
      const lineNumber = String(safeStart + index).padStart(4, ' ');
      return `${lineNumber}| ${line}`;
    })
    .join('\n');
}

// Exposed tool: bounded file reader with stable "FILE/LINES" envelope format.
export function readFile(filepath: string, startLine = 1, endLine = 300): string {
  try {
    const repoRoot = getRepoRoot();
    const fullPath = resolveSafePath(filepath);

    if (!fs.existsSync(fullPath)) return `Error: file "${filepath}" does not exist.`;
    if (!fs.statSync(fullPath).isFile()) return `Error: path "${filepath}" is not a file.`;

    const content = fs.readFileSync(fullPath, 'utf8');
    const relative = path.relative(repoRoot, fullPath);

    return `FILE: ${relative}\nLINES: ${startLine}-${endLine}\n\n${lineSlice(content, startLine, endLine)}`;
  } catch (error: any) {
    return `Error reading file "${filepath}": ${error.message}`;
  }
}

interface SearchHit {
  file: string;
  lines: Array<{ line: number; text: string }>;
}

// DFS over source files with an early stop to control token and runtime cost.
function collectSearchHits(
  keyword: string,
  maxResults: number,
  dir = getRepoRoot(),
  hits: SearchHit[] = [],
): SearchHit[] {
  if (hits.length >= maxResults) return hits;

  const repoRoot = getRepoRoot();
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (hits.length >= maxResults) break;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) {
        collectSearchHits(keyword, maxResults, fullPath, hits);
      }
      continue;
    }

    if (!SOURCE_FILE_REGEX.test(entry.name)) continue;

    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (!content.toLowerCase().includes(keyword.toLowerCase())) continue;

      const matches: Array<{ line: number; text: string }> = [];
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(keyword.toLowerCase())) {
          matches.push({ line: i + 1, text: lines[i].trim() });
          if (matches.length >= 3) break;
        }
      }

      hits.push({
        file: path.relative(repoRoot, fullPath),
        lines: matches,
      });
    } catch {
      // Ignore files that cannot be read due to permissions or encoding issues.
    }
  }

  return hits;
}

// Exposed tool: case-insensitive keyword search with compact per-file snippets.
export function searchProject(keyword: string, maxResults = 30): string {
  try {
    if (typeof keyword !== 'string' || !keyword.trim()) {
      return 'Error: keyword must be a non-empty string.';
    }

    const safeLimit = Math.min(100, Math.max(1, Math.floor(maxResults)));
    const hits = collectSearchHits(keyword.trim(), safeLimit, getRepoRoot());

    if (!hits.length) return `No matches found for "${keyword}".`;

    const output = hits
      .map((hit) => {
        const snippets = hit.lines
          .map((l) => `  ${String(l.line).padStart(4, ' ')}| ${l.text}`)
          .join('\n');
        return `- ${hit.file}\n${snippets}`;
      })
      .join('\n');

    return `Keyword "${keyword}" found in ${hits.length} file(s):\n${output}`;
  } catch (error: any) {
    return `Error during search_project: ${error.message}`;
  }
}

function isSafeCdCommand(command: string): boolean {
  const match = command.match(/^cd\s+(.+)$/);
  if (!match) return false;

  const target = match[1].trim();

  if (!target || target.includes('..') || target.includes('~')) {
    return false;
  }

  if (path.isAbsolute(target)) {
    return false;
  }

  return true;
}

function isSafeNpmRunCommand(command: string): boolean {
  const match = command.match(/^npm\s+run\s+([a-zA-Z0-9:_-]+)(?:\s+--.*)?$/);
  if (!match) return false;

  const scriptName = match[1];
  return SAFE_NPM_RUN_SCRIPTS.has(scriptName);
}

function isAllowedSubCommand(command: string): boolean {
  if (!command) return false;

  if (command.startsWith('npm install')) return true;
  if (command.startsWith('npm uninstall')) return true;
  if (command === 'npm i' || command.startsWith('npm i ')) return true;
  if (command.startsWith('npx expo')) return true;
  if (command.startsWith('npx tsc')) return true;
  if (command.startsWith('npx eslint')) return true;
  if (command.startsWith('npx prettier')) return true;
  if (command === 'ls' || command.startsWith('ls ')) return true;
  if (command === 'pwd') return true;
  if (command === 'git status' || command.startsWith('git status ')) return true;
  if (command === 'git diff' || command.startsWith('git diff ')) return true;
  if (command === 'git log' || command.startsWith('git log ')) return true;

  if (isSafeCdCommand(command)) return true;
  if (isSafeNpmRunCommand(command)) return true;

  return false;
}

// Exposed tool: command runner with path guards and explicit command allowlist.
export async function runCommand(cmd: string): Promise<string> {
  const trimmedCmd = cmd.trim();
  const repoRoot = getRepoRoot();

  if (!trimmedCmd) {
    return '🚨 SECURITY EXCEPTION: Command rejected. Empty command.';
  }

  // Reject traversal and shell features that significantly widen execution surface.
  const blockedPatterns = [
    /\.\.\//,
    /(^|\s)\/(?!dev|tmp)/,
    /~/,
    /;/,
    /\|\|/,
    /(^|[^|])\|([^|]|$)/,
    />/,
    /</,
    /(^|[^&])&([^&]|$)/,
  ];

  for (const pattern of blockedPatterns) {
    if (pattern.test(trimmedCmd)) {
      console.log(`🚨 SECURITY BLOCK: Unsafe shell pattern in command: ${trimmedCmd}`);
      return '🚨 SECURITY EXCEPTION: Command rejected. Unsafe shell operators are not allowed.';
    }
  }

  const subCommands = trimmedCmd
    .split('&&')
    .map((s) => s.trim())
    .filter(Boolean);

  if (subCommands.length === 0) {
    return '🚨 SECURITY EXCEPTION: Command rejected. No valid subcommands found.';
  }

  for (const subCmd of subCommands) {
    if (!isAllowedSubCommand(subCmd)) {
      console.log(`🚨 SECURITY BLOCK: Unauthorized command attempted: ${subCmd}`);
      return '🚨 SECURITY EXCEPTION: Command rejected. Only safe development commands are allowed.';
    }
  }

  try {
    console.log(`💻 Executing safe command in ${repoRoot}: ${trimmedCmd}`);
    const { stdout, stderr } = await execPromise(trimmedCmd, {
      cwd: repoRoot,
      timeout: 20000,
    });

    let output = '';
    if (stdout) output += `STDOUT:\n${stdout}\n`;
    if (stderr) output += `STDERR:\n${stderr}\n`;

    return output.trim() ? output.trim() : 'Command executed successfully with no output.';
  } catch (error: any) {
    return `⚠️ Command failed:\nSTDOUT:\n${error.stdout}\nSTDERR:\n${error.stderr}\nMESSAGE:\n${error.message}`;
  }
}

// JSON schemas exposed to the LLM as callable function tools.
export const agentTools: any[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a project file before editing it. Use relative paths from repo root. Supports line range for targeted inspection.',
      parameters: {
        type: 'object',
        properties: {
          filepath: { type: 'string', description: 'Relative path like "kubo-mobile/app/(tabs)/explore.tsx".' },
          startLine: { type: 'number', description: 'Optional first line number (1-based).' },
          endLine: { type: 'number', description: 'Optional last line number (1-based).' },
        },
        required: ['filepath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_project',
      description: 'Search keyword usage across source files and return matching file paths with line snippets.',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'String token like "KuboFilterModal" or "JwtAuthGuard".' },
          maxResults: { type: 'number', description: 'Optional cap for matching files (default 30, max 100).' },
        },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Executes a bash shell command in the repository root. Use this to install missing npm packages (e.g., "npm install dayjs"), run safe scripts like lint/test/typecheck/build/start, run linters/compilers (e.g., "npx tsc --noEmit"), or check git history (e.g., "git status" or "git diff"). Note: To install in a sub-folder of a monorepo, use cd (e.g., "cd kubo-mobile && npm install lucide-react-native").',
      parameters: {
        type: 'object',
        properties: {
          cmd: { type: 'string', description: 'The bash command to execute.' },
        },
        required: ['cmd'],
      },
    },
  },
];