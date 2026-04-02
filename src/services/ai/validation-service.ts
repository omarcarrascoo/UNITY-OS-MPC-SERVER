import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import type { ValidationResult } from './types.js';

const execPromise = util.promisify(exec);

function normalizeCompilationOutput(rawOutput: string): Set<string> {
  return new Set(
    rawOutput
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith('[Error in '))
      .filter((line) => !line.startsWith('Found '))
      .filter((line) => line !== 'error Command failed with exit code 2.')
      .map((line) => line.replace(/\s+/g, ' ')),
  );
}

export async function runTypecheckForDirs(repoPath: string, dirs: string[]): Promise<ValidationResult> {
  let rawOutput = '';

  for (const dir of dirs) {
    const checkPath = dir === '.' ? repoPath : path.join(repoPath, dir);

    if (!fs.existsSync(path.join(checkPath, 'tsconfig.json'))) {
      continue;
    }

    try {
      await execPromise(`npx tsc --noEmit`, { cwd: checkPath });
    } catch (err: any) {
      rawOutput += `\n[Error in ${dir}]:\n${err.stdout || err.message}\n`;
    }
  }

  return {
    rawOutput: rawOutput.trim(),
    normalizedErrors: normalizeCompilationOutput(rawOutput),
  };
}

export function getNewCompilationErrors(
  baseline: ValidationResult,
  current: ValidationResult,
): string[] {
  const newErrors: string[] = [];

  for (const line of current.normalizedErrors) {
    if (!baseline.normalizedErrors.has(line)) {
      newErrors.push(line);
    }
  }

  return newErrors;
}

export async function getCurrentGitDiff(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execPromise(`git diff`, { cwd: repoPath });
    return stdout || '';
  } catch {
    return '';
  }
}

