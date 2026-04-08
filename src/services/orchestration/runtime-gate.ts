import fs from 'fs';
import os from 'os';
import path from 'path';
import { ChildProcess, exec, spawn } from 'child_process';
import util from 'util';
import type { PreparedWorkspace } from '../../domain/runtime.js';

const execPromise = util.promisify(exec);

let currentExpoProcess: ChildProcess | null = null;
let currentNestProcess: ChildProcess | null = null;

export interface RuntimeGateResult {
  localUrl: string | null;
  publicUrl: string | null;
  details: string;
  status: 'passed' | 'failed';
}

type RuntimeLogFn = (message: string) => Promise<void> | void;

function getLocalIpAddress(): string | null {
  const interfaces = os.networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }

  return null;
}

function injectApiUrlToEnv(expoPath: string, url: string) {
  const envPath = path.join(expoPath, '.env');
  let envContent = '';

  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
  }

  envContent = envContent.replace(/^EXPO_PUBLIC_API_URL=.*$/gm, '').trim();
  envContent += `\nEXPO_PUBLIC_API_URL=${url}\n`;
  fs.writeFileSync(envPath, envContent.trim() + '\n');
}

function hasExpoApp(expoPath: string): boolean {
  const packageJsonPath = path.join(expoPath, 'package.json');

  if (!fs.existsSync(packageJsonPath)) {
    return false;
  }

  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  return Boolean(pkg.dependencies?.expo || pkg.devDependencies?.expo);
}

function hasNodeModules(packageDir: string | null): boolean {
  if (!packageDir) {
    return false;
  }

  try {
    return fs.statSync(path.join(packageDir, 'node_modules')).isDirectory();
  } catch {
    return false;
  }
}

function getPackageManagerHint(packageDir: string | null): string {
  if (!packageDir) {
    return 'none';
  }

  if (fs.existsSync(path.join(packageDir, 'package-lock.json'))) {
    return 'npm';
  }

  if (fs.existsSync(path.join(packageDir, 'yarn.lock'))) {
    return 'yarn';
  }

  if (fs.existsSync(path.join(packageDir, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }

  return 'npm';
}

async function emitRuntimeLog(onLog: RuntimeLogFn | undefined, message: string): Promise<void> {
  if (!onLog) {
    return;
  }

  await onLog(message);
}

function killTrackedProcess(proc: ChildProcess | null): void {
  if (!proc?.pid) return;

  try {
    proc.kill('SIGKILL');
  } catch {
    // Ignore cleanup errors.
  }
}

async function killPort(port: number): Promise<void> {
  await execPromise(`fuser -k ${port}/tcp || true`).catch(() => {});
}

export async function runProjectRuntimeGate(
  workspace: PreparedWorkspace,
  targetRoute = '/',
  onLog?: RuntimeLogFn,
): Promise<RuntimeGateResult> {
  const expoAvailable = hasExpoApp(workspace.expoPath);
  const expoNodeModules = hasNodeModules(workspace.expoPath);
  const apiNodeModules = hasNodeModules(workspace.apiPath);
  const port = 8081;
  const backendPort = 3000;
  const localUrl = `http://localhost:${port}${targetRoute.startsWith('/') ? targetRoute : `/${targetRoute}`}`;
  const ip = getLocalIpAddress();
  const publicUrl = ip ? `http://${ip}:${port}${targetRoute.startsWith('/') ? targetRoute : `/${targetRoute}`}` : null;

  await emitRuntimeLog(
    onLog,
    `🌐 [runtime] Preflight: route=${targetRoute}, expo=${expoAvailable ? workspace.expoPath : 'not detected'}, api=${
      workspace.apiPath || 'not detected'
    }, expo node_modules=${expoNodeModules ? 'present' : 'missing'}, api node_modules=${
      workspace.apiPath ? (apiNodeModules ? 'present' : 'missing') : 'n/a'
    }.`,
  );

  killTrackedProcess(currentExpoProcess);
  killTrackedProcess(currentNestProcess);
  currentExpoProcess = null;
  currentNestProcess = null;

  await emitRuntimeLog(onLog, `🌐 [runtime] Clearing ports ${backendPort} and ${port} before boot.`);
  await killPort(port);
  await killPort(backendPort);
  await new Promise((resolve) => setTimeout(resolve, 1000));

  if (workspace.apiPath) {
    if (!apiNodeModules) {
      const details = `API runtime prerequisites missing: node_modules not found in ${workspace.apiPath}. Expected package manager: ${getPackageManagerHint(
        workspace.apiPath,
      )}.`;
      await emitRuntimeLog(onLog, `❌ [runtime] ${details}`);
      return {
        localUrl: null,
        publicUrl: null,
        details,
        status: 'failed',
      };
    }

    await emitRuntimeLog(onLog, `🌐 [runtime] Starting backend with \`npm run start\` in ${workspace.apiPath}.`);
    currentNestProcess = spawn('npm', ['run', 'start'], {
      cwd: workspace.apiPath,
      stdio: 'pipe',
    });

    let backendLog = '';
    const onBackendOutput = (data: Buffer | string) => {
      backendLog += data.toString();
    };
    currentNestProcess.stdout?.on('data', onBackendOutput);
    currentNestProcess.stderr?.on('data', onBackendOutput);

    const backendUrl = ip ? `http://${ip}:${backendPort}` : `http://localhost:${backendPort}`;
    if (expoAvailable) {
      injectApiUrlToEnv(workspace.expoPath, backendUrl);
      await emitRuntimeLog(onLog, `🌐 [runtime] Injected EXPO_PUBLIC_API_URL=${backendUrl} into ${workspace.expoPath}/.env.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));

    if (currentNestProcess.exitCode !== null) {
      const details = `Backend exited before runtime verification. Exit code: ${currentNestProcess.exitCode}. Logs: ${backendLog
        .trim()
        .slice(0, 1000)}`;
      await emitRuntimeLog(onLog, `❌ [runtime] ${details}`);
      return {
        localUrl: null,
        publicUrl: null,
        details,
        status: 'failed',
      };
    }

    await emitRuntimeLog(onLog, `🌐 [runtime] Backend boot window elapsed without early exit.`);
  }

  if (!expoAvailable) {
    if (workspace.apiPath) {
      await emitRuntimeLog(onLog, `✅ [runtime] Expo app not detected. API-only runtime considered healthy.`);
      return {
        localUrl: `http://localhost:${backendPort}`,
        publicUrl: ip ? `http://${ip}:${backendPort}` : null,
        details: `API runtime available at http://localhost:${backendPort}`,
        status: 'passed',
      };
    }

    return {
      localUrl: null,
      publicUrl: null,
      details: 'No runtime-capable app detected. Skipping runtime gate.',
      status: 'passed',
    };
  }

  if (!expoNodeModules) {
    const details = `Expo runtime prerequisites missing: node_modules not found in ${workspace.expoPath}. Expected package manager: ${getPackageManagerHint(
      workspace.expoPath,
    )}.`;
    await emitRuntimeLog(onLog, `❌ [runtime] ${details}`);
    return {
      localUrl: null,
      publicUrl: null,
      details,
      status: 'failed',
    };
  }

  return new Promise((resolve) => {
    emitRuntimeLog(
      onLog,
      `🌐 [runtime] Starting Expo web with \`npx expo start --web --port ${port}\` in ${workspace.expoPath}.`,
    ).catch(() => {});

    currentExpoProcess = spawn('npx', ['expo', 'start', '--web', '--port', port.toString()], {
      cwd: workspace.expoPath,
      stdio: 'pipe',
    });

    let ready = false;
    let runtimeLog = '';

    const processOutput = (data: any) => {
      const text = data.toString();
      runtimeLog += text;

      if (
        text.includes('http://localhost') ||
        text.includes('Web is waiting on') ||
        text.includes('ready in')
      ) {
        ready = true;
      }
    };

    currentExpoProcess.stdout?.on('data', processOutput);
    currentExpoProcess.stderr?.on('data', processOutput);
    currentExpoProcess.on('exit', (code, signal) => {
      if (!ready) {
        emitRuntimeLog(
          onLog,
          `❌ [runtime] Expo exited before readiness. code=${code ?? 'null'} signal=${signal ?? 'null'}.`,
        ).catch(() => {});
      }
    });

    const interval = setInterval(() => {
      if (!ready) {
        return;
      }

      clearInterval(interval);
      emitRuntimeLog(onLog, `✅ [runtime] Expo reported ready at ${localUrl}.`).catch(() => {});
      resolve({
        localUrl,
        publicUrl,
        details: `Runtime available at ${localUrl}`,
        status: 'passed',
      });
    }, 1000);

    setTimeout(() => {
      clearInterval(interval);

      if (ready) {
        emitRuntimeLog(onLog, `✅ [runtime] Expo reported ready at ${localUrl}.`).catch(() => {});
        resolve({
          localUrl,
          publicUrl,
          details: `Runtime available at ${localUrl}`,
          status: 'passed',
        });
        return;
      }

      const trimmedLog = runtimeLog.trim().slice(0, 1000);
      emitRuntimeLog(
        onLog,
        `❌ [runtime] Runtime failed to start within 30s.${trimmedLog ? ` Logs: ${trimmedLog}` : ''}`,
      ).catch(() => {});
      resolve({
        localUrl: null,
        publicUrl: null,
        details: `Runtime failed to start within 30s.${trimmedLog ? ` Logs: ${trimmedLog}` : ''}`,
        status: 'failed',
      });
    }, 30000);
  });
}
