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
): Promise<RuntimeGateResult> {
  const expoAvailable = hasExpoApp(workspace.expoPath);
  const port = 8081;
  const backendPort = 3000;
  const localUrl = `http://localhost:${port}${targetRoute.startsWith('/') ? targetRoute : `/${targetRoute}`}`;
  const ip = getLocalIpAddress();
  const publicUrl = ip ? `http://${ip}:${port}${targetRoute.startsWith('/') ? targetRoute : `/${targetRoute}`}` : null;

  killTrackedProcess(currentExpoProcess);
  killTrackedProcess(currentNestProcess);
  currentExpoProcess = null;
  currentNestProcess = null;

  await killPort(port);
  await killPort(backendPort);
  await new Promise((resolve) => setTimeout(resolve, 1000));

  if (workspace.apiPath) {
    currentNestProcess = spawn('npm', ['run', 'start'], {
      cwd: workspace.apiPath,
      stdio: 'pipe',
    });

    const backendUrl = ip ? `http://${ip}:${backendPort}` : `http://localhost:${backendPort}`;
    if (expoAvailable) {
      injectApiUrlToEnv(workspace.expoPath, backendUrl);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  if (!expoAvailable) {
    if (workspace.apiPath) {
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

  return new Promise((resolve) => {
    currentExpoProcess = spawn('npx', ['expo', 'start', '--web', '--port', port.toString()], {
      cwd: workspace.expoPath,
      stdio: 'pipe',
    });

    let ready = false;
    let stderrLog = '';

    const processOutput = (data: any) => {
      const text = data.toString();
      stderrLog += text;

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

    const interval = setInterval(() => {
      if (!ready) {
        return;
      }

      clearInterval(interval);
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
        resolve({
          localUrl,
          publicUrl,
          details: `Runtime available at ${localUrl}`,
          status: 'passed',
        });
        return;
      }

      resolve({
        localUrl: null,
        publicUrl: null,
        details: `Runtime failed to start. ${stderrLog.substring(0, 1000)}`,
        status: 'failed',
      });
    }, 30000);
  });
}
