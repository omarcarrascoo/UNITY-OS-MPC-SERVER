import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';

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
const SAFE_EXPO_COMMAND_PATTERNS = [
  /^npx\s+expo\s+--version$/,
  /^npx\s+expo\s+lint(?:\s+.*)?$/,
  /^npx\s+expo\s+start(?:\s+.*)?$/,
  /^npx\s+expo\s+doctor(?:\s+.*)?$/,
];
const MAX_COMMAND_OUTPUT_CHARS = 12000;
const MAX_COMMAND_OUTPUT_LINES = 300;

export interface AgentToolRuntime {
  tools: typeof agentTools;
  readFile: (filepath: string, startLine?: number, endLine?: number) => string;
  searchProject: (keyword: string, maxResults?: number) => string;
  runCommand: (cmd: string) => Promise<string>;
}

function resolveRepoRoot(repoPath: string): string {
  return path.resolve(repoPath);
}

function resolveSafePath(repoRoot: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('Invalid path: expected non-empty relative path string.');
  }

  const fullPath = path.resolve(repoRoot, relativePath);

  if (fullPath !== repoRoot && !fullPath.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error(`Path is outside repo root: ${relativePath}`);
  }

  return fullPath;
}

function lineSlice(content: string, startLine = 1, endLine = 300): string {
  const lines = content.split('\n');
  const safeStart = Math.max(1, Math.floor(startLine));
  const safeEnd = Math.max(safeStart, Math.floor(endLine));
  const clippedEnd = Math.min(lines.length, safeEnd);

  return lines
    .slice(safeStart - 1, clippedEnd)
    .map((line, index) => {
      const lineNumber = String(safeStart + index).padStart(4, ' ');
      return `${lineNumber}| ${line}`;
    })
    .join('\n');
}

function createReadFile(repoRoot: string) {
  return (filepath: string, startLine = 1, endLine = 300): string => {
    try {
      const fullPath = resolveSafePath(repoRoot, filepath);

      if (!fs.existsSync(fullPath)) return `Error: file "${filepath}" does not exist.`;
      if (!fs.statSync(fullPath).isFile()) return `Error: path "${filepath}" is not a file.`;

      const content = fs.readFileSync(fullPath, 'utf8');
      const relative = path.relative(repoRoot, fullPath);

      return `FILE: ${relative}\nLINES: ${startLine}-${endLine}\n\n${lineSlice(content, startLine, endLine)}`;
    } catch (error: any) {
      return `Error reading file "${filepath}": ${error.message}`;
    }
  };
}

interface SearchHit {
  file: string;
  lines: Array<{ line: number; text: string }>;
}

function collectSearchHits(
  repoRoot: string,
  keyword: string,
  maxResults: number,
  dir = repoRoot,
  hits: SearchHit[] = [],
): SearchHit[] {
  if (hits.length >= maxResults) return hits;

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (hits.length >= maxResults) break;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) {
        collectSearchHits(repoRoot, keyword, maxResults, fullPath, hits);
      }
      continue;
    }

    if (!SOURCE_FILE_REGEX.test(entry.name)) continue;

    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (!content.toLowerCase().includes(keyword.toLowerCase())) continue;

      const matches: Array<{ line: number; text: string }> = [];
      const lines = content.split('\n');

      for (let index = 0; index < lines.length; index++) {
        if (lines[index].toLowerCase().includes(keyword.toLowerCase())) {
          matches.push({ line: index + 1, text: lines[index].trim() });
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

function createSearchProject(repoRoot: string) {
  return (keyword: string, maxResults = 30): string => {
    try {
      if (typeof keyword !== 'string' || !keyword.trim()) {
        return 'Error: keyword must be a non-empty string.';
      }

      const safeLimit = Math.min(100, Math.max(1, Math.floor(maxResults)));
      const hits = collectSearchHits(repoRoot, keyword.trim(), safeLimit);

      if (!hits.length) return `No matches found for "${keyword}".`;

      const output = hits
        .map((hit) => {
          const snippets = hit.lines
            .map((line) => `  ${String(line.line).padStart(4, ' ')}| ${line.text}`)
            .join('\n');
          return `- ${hit.file}\n${snippets}`;
        })
        .join('\n');

      return `Keyword "${keyword}" found in ${hits.length} file(s):\n${output}`;
    } catch (error: any) {
      return `Error during search_project: ${error.message}`;
    }
  };
}

function isSafeCdCommand(command: string): boolean {
  const match = command.match(/^cd\s+(.+)$/);
  if (!match) return false;

  const target = match[1].trim();

  if (!target || target.includes('..') || target.includes('~')) {
    return false;
  }

  return !path.isAbsolute(target);
}

function isSafeNpmRunCommand(command: string): boolean {
  const match = command.match(/^npm\s+run\s+([a-zA-Z0-9:_-]+)(?:\s+--.*)?$/);
  if (!match) return false;

  return SAFE_NPM_RUN_SCRIPTS.has(match[1]);
}

function isFilterableExecutionCommand(command: string): boolean {
  return [
    /^npm\s+run\s+/,
    /^npx\s+tsc\b/,
    /^npx\s+expo\s+(lint|start|doctor)\b/,
    /^npx\s+expo\s+--version$/,
    /^npx\s+eslint\b/,
    /^npx\s+prettier\b/,
    /^git\s+(status|diff|log)\b/,
  ].some((pattern) => pattern.test(command));
}

function stripQuotedSegments(command: string): string {
  return command
    .replace(/"([^"\\]|\\.)*"/g, '""')
    .replace(/'([^'\\]|\\.)*'/g, "''");
}

function isSafeExpoCommand(command: string): boolean {
  return SAFE_EXPO_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

function normalizeInspectionCommand(command: string): string {
  let normalized = command.trim();

  normalized = normalized.replace(/\s+2>\s*\/dev\/null\b/g, '');
  normalized = normalized.replace(/\s+2>&1\b/g, '');

  if (isFilterableExecutionCommand(normalized) && normalized.includes('|')) {
    normalized = normalized.split('|')[0].trim();
  }

  return normalized;
}

function isAllowedReadOnlyCommand(command: string): boolean {
  if (!command) return false;

  const normalized = command.trim();

  if (normalized === 'pwd') return true;
  if (normalized === 'ls' || normalized.startsWith('ls ')) return true;
  if (normalized === 'cat' || normalized.startsWith('cat ')) return true;
  if (normalized === 'head' || normalized.startsWith('head ')) return true;
  if (normalized === 'tail' || normalized.startsWith('tail ')) return true;
  if (normalized === 'sort' || normalized.startsWith('sort ')) return true;
  if (normalized === 'wc' || normalized.startsWith('wc ')) return true;
  if (normalized.startsWith('grep ')) return true;
  if (normalized.startsWith('rg ')) return true;

  if (normalized.startsWith('sed ')) {
    return /\bsed\s+-n\b/.test(normalized) && !/\bsed\s+-i\b/.test(normalized);
  }

  if (normalized.startsWith('find ')) {
    return !/\s-(exec|ok|delete|fprint|fls|print0)\b/.test(normalized);
  }

  if (normalized === 'git status' || normalized.startsWith('git status ')) return true;
  if (normalized === 'git diff' || normalized.startsWith('git diff ')) return true;
  if (normalized === 'git log' || normalized.startsWith('git log ')) return true;

  return false;
}

function isAllowedPipeline(command: string): boolean {
  const segments = command
    .split('|')
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length <= 1) {
    return false;
  }

  return segments.every((segment) => isAllowedReadOnlyCommand(segment));
}

function isAllowedSubCommand(command: string): boolean {
  if (!command) return false;

  const normalized = normalizeInspectionCommand(command);

  if (normalized.startsWith('npm install')) return true;
  if (normalized.startsWith('npm uninstall')) return true;
  if (normalized === 'npm i' || normalized.startsWith('npm i ')) return true;
  if (isSafeExpoCommand(normalized)) return true;
  if (normalized.startsWith('npx tsc')) return true;
  if (normalized.startsWith('npx eslint')) return true;
  if (normalized.startsWith('npx prettier')) return true;

  if (isAllowedReadOnlyCommand(normalized)) return true;
  if (isAllowedPipeline(normalized)) return true;

  if (isSafeCdCommand(normalized)) return true;
  if (isSafeNpmRunCommand(normalized)) return true;

  return false;
}

function truncateCommandOutput(output: string): string {
  const clippedByChars =
    output.length > MAX_COMMAND_OUTPUT_CHARS
      ? `${output.slice(0, MAX_COMMAND_OUTPUT_CHARS)}\n... [truncated]`
      : output;

  const lines = clippedByChars.split('\n');
  if (lines.length <= MAX_COMMAND_OUTPUT_LINES) {
    return clippedByChars;
  }

  return `${lines.slice(0, MAX_COMMAND_OUTPUT_LINES).join('\n')}\n... [truncated]`;
}

function createRunCommand(repoRoot: string) {
  return async (cmd: string): Promise<string> => {
    const trimmedCmd = cmd.trim();

    if (!trimmedCmd) {
      return '🚨 SECURITY EXCEPTION: Command rejected. Empty command.';
    }

    const blockedPatterns = [
      /\.\.\//,
      /(^|\s)\.\.(\/|\s|$)/,
      /(^|\s)\/(?!dev|tmp)/,
      /~/,
      /;/,
      /\|\|/,
      />/,
      /</,
      /(^|[^&])&([^&]|$)/,
      /`/,
      /\$\(/,
    ];

    const sanitizedCmd = trimmedCmd
      .replace(/\s+2>\s*\/dev\/null\b/g, '')
      .replace(/\s+2>&1\b/g, '')
      .trim();
    const analyzedCmd = stripQuotedSegments(sanitizedCmd);

    for (const pattern of blockedPatterns) {
      if (pattern.test(analyzedCmd)) {
        console.log(`🚨 SECURITY BLOCK: Unsafe shell pattern in command: ${trimmedCmd}`);
        return '🚨 SECURITY EXCEPTION: Command rejected. Unsafe shell operators are not allowed. Use read-only inspection commands like ls/find/grep/cat/sed -n or validation commands without redirection.';
      }
    }

    const subCommands = sanitizedCmd
      .split('&&')
      .map((segment) => normalizeInspectionCommand(segment))
      .filter(Boolean);

    if (subCommands.length === 0) {
      return '🚨 SECURITY EXCEPTION: Command rejected. No valid subcommands found.';
    }

    for (const subCommand of subCommands) {
      if (!isAllowedSubCommand(subCommand)) {
        console.log(`🚨 SECURITY BLOCK: Unauthorized command attempted: ${subCommand}`);
        return '🚨 SECURITY EXCEPTION: Command rejected. Only safe development commands are allowed. Supported inspection commands include ls, pwd, find, grep, rg, cat, sed -n, head, tail, sort, wc, git status/diff/log.';
      }
    }

    try {
      const normalizedCmd = subCommands.join(' && ');
      console.log(`💻 Executing safe command in ${repoRoot}: ${normalizedCmd}`);
      const { stdout, stderr } = await execPromise(normalizedCmd, {
        cwd: repoRoot,
        timeout: 20000,
      });

      let output = '';
      if (stdout) output += `STDOUT:\n${stdout}\n`;
      if (stderr) output += `STDERR:\n${stderr}\n`;

      const finalOutput = output.trim() ? output.trim() : 'Command executed successfully with no output.';
      return truncateCommandOutput(finalOutput);
    } catch (error: any) {
      return truncateCommandOutput(
        `⚠️ Command failed:\nSTDOUT:\n${error.stdout}\nSTDERR:\n${error.stderr}\nMESSAGE:\n${error.message}`,
      );
    }
  };
}

export function createAgentToolRuntime(repoPath: string): AgentToolRuntime {
  const repoRoot = resolveRepoRoot(repoPath);

  return {
    tools: agentTools,
    readFile: createReadFile(repoRoot),
    searchProject: createSearchProject(repoRoot),
    runCommand: createRunCommand(repoRoot),
  };
}

export const agentTools = [
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
      description:
        'Executes a safe bash command in the repository root. Use this for validation commands like lint/test/typecheck/build/start and for read-only inspection commands such as ls, pwd, find, grep, rg, cat, sed -n, head, tail, sort, wc, and git status/diff/log. Output is automatically truncated, so extra head/tail filtering is usually unnecessary. To operate in a monorepo sub-folder, use cd first.',
      parameters: {
        type: 'object',
        properties: {
          cmd: { type: 'string', description: 'The bash command to execute.' },
        },
        required: ['cmd'],
      },
    },
  },
] as const;
