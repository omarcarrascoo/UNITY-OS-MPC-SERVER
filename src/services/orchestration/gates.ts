import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import type { GateResult } from '../../domain/orchestration.js';
import type { AutonomousRunPolicy } from '../../domain/policies.js';
import type { PreparedWorkspace } from '../../domain/runtime.js';
import { runProjectRuntimeGate } from './runtime-gate.js';

const execPromise = util.promisify(exec);

interface PackageScripts {
  dir: string;
  scripts: Record<string, string>;
}

function normalizeScopes(scopes?: string[]): string[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return ['.'];
  }

  const cleaned = scopes.map((scope) => scope.trim()).filter(Boolean);
  return cleaned.length ? cleaned : ['.'];
}

function packageDirMatchesScopes(repoPath: string, packageDir: string, scopes: string[]): boolean {
  const relativeDir = path.relative(repoPath, packageDir) || '.';
  const normalizedScopes = normalizeScopes(scopes);

  if (normalizedScopes.includes('.')) {
    return true;
  }

  return normalizedScopes.some((scope) => {
    return (
      scope === relativeDir ||
      scope.startsWith(`${relativeDir}/`) ||
      relativeDir.startsWith(`${scope}/`)
    );
  });
}

function loadPackageScripts(packageDir: string): PackageScripts | null {
  const packageJsonPath = path.join(packageDir, 'package.json');

  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  const raw = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  return {
    dir: packageDir,
    scripts: raw.scripts || {},
  };
}

function isPlaceholderTestScript(script: string | undefined): boolean {
  return Boolean(script && script.includes('no test specified'));
}

async function runGateCommand(name: string, cwd: string, command: string): Promise<GateResult> {
  try {
    const { stdout, stderr } = await execPromise(command, {
      cwd,
      timeout: 120000,
    });

    return {
      name,
      status: 'passed',
      details: [stdout, stderr].filter(Boolean).join('\n').trim() || 'Passed',
    };
  } catch (error: any) {
    return {
      name,
      status: 'failed',
      details: `${error.stdout || ''}\n${error.stderr || ''}\n${error.message || ''}`.trim(),
    };
  }
}

export async function runStaticGates(
  workspace: PreparedWorkspace,
  policy: AutonomousRunPolicy,
  scopes?: string[],
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  const packageDirs = Array.from(
    new Set(workspace.packageDirs.length ? workspace.packageDirs : [workspace.repoPath]),
  ).filter((packageDir) => packageDirMatchesScopes(workspace.repoPath, packageDir, scopes || ['.']));

  for (const packageDir of packageDirs) {
    const relativeDir = path.relative(workspace.repoPath, packageDir) || '.';
    const packageScripts = loadPackageScripts(packageDir);

    if (policy.gates.runTypecheck) {
      if (packageScripts?.scripts.typecheck) {
        results.push(await runGateCommand(`typecheck:${relativeDir}`, packageDir, 'npm run typecheck'));
      } else if (fs.existsSync(path.join(packageDir, 'tsconfig.json'))) {
        results.push(await runGateCommand(`tsc:${relativeDir}`, packageDir, 'npx tsc --noEmit'));
      } else {
        results.push({
          name: `typecheck:${relativeDir}`,
          status: 'skipped',
          details: 'No typecheck script or tsconfig found.',
        });
      }
    }

    if (policy.gates.runLint) {
      if (packageScripts?.scripts.lint) {
        results.push(await runGateCommand(`lint:${relativeDir}`, packageDir, 'npm run lint'));
      } else {
        results.push({
          name: `lint:${relativeDir}`,
          status: 'skipped',
          details: 'No lint script found.',
        });
      }
    }

    if (policy.gates.runTests) {
      if (packageScripts?.scripts.test && !isPlaceholderTestScript(packageScripts.scripts.test)) {
        results.push(await runGateCommand(`test:${relativeDir}`, packageDir, 'npm run test'));
      } else {
        results.push({
          name: `test:${relativeDir}`,
          status: 'skipped',
          details: 'No real test script found.',
        });
      }
    }

    if (policy.gates.runBuild) {
      if (packageScripts?.scripts.build) {
        results.push(await runGateCommand(`build:${relativeDir}`, packageDir, 'npm run build'));
      } else {
        results.push({
          name: `build:${relativeDir}`,
          status: 'skipped',
          details: 'No build script found.',
        });
      }
    }
  }

  return results;
}

export async function runRuntimeGate(
  workspace: PreparedWorkspace,
  policy: AutonomousRunPolicy,
  targetRoute = '/',
): Promise<GateResult[]> {
  if (!policy.gates.runRuntime) {
    return [
      {
        name: 'runtime',
        status: 'skipped',
        details: 'Runtime gate disabled by policy.',
      },
    ];
  }

  const runtimeResult = await runProjectRuntimeGate(workspace, targetRoute);

  return [
    {
      name: 'runtime',
      status: runtimeResult.status,
      details: runtimeResult.details,
    },
    {
      name: 'runtime:url',
      status: runtimeResult.status === 'passed' ? 'passed' : 'skipped',
      details: runtimeResult.localUrl
        ? `Local: ${runtimeResult.localUrl}${runtimeResult.publicUrl ? ` | Public: ${runtimeResult.publicUrl}` : ''}`
        : 'No runtime URLs available.',
    },
  ];
}

export function summarizeGateResults(results: GateResult[]): string {
  return results.map((result) => `${result.name} [${result.status}] ${result.details}`).join('\n');
}
