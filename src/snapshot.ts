import fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import puppeteer from 'puppeteer';
import os from 'os';
import util from 'util';
import { exec } from 'child_process';
import { WORKSPACE_DIR } from './config.js';
import { TARGET_EXPO_PATH, TARGET_API_PATH } from './git.js';

const execPromise = util.promisify(exec);

// Long-lived process handles allow restarts between runs without zombie servers.
let currentExpoProcess: ChildProcess | null = null;
let currentNestProcess: ChildProcess | null = null;

export interface SnapshotResult {
  snapshotPath: string | null;
  publicUrl: string | null;
  localUrl: string;
  warning?: string;
}

// Selects the first non-loopback IPv4 address for LAN/Proxy preview links.
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

// Injects the backend URL into Expo's environment so the mobile app knows where to point.
function injectApiUrlToEnv(url: string) {
  const envPath = path.join(TARGET_EXPO_PATH, '.env');
  let envContent = '';

  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
  }

  envContent = envContent.replace(/^EXPO_PUBLIC_API_URL=.*$/gm, '').trim();
  envContent += `\nEXPO_PUBLIC_API_URL=${url}\n`;

  fs.writeFileSync(envPath, envContent.trim() + '\n');
  console.log(`💉 Injected EXPO_PUBLIC_API_URL=${url} into Expo App`);
}

function killTrackedProcess(proc: ChildProcess | null, label: string) {
  if (!proc?.pid) return;

  try {
    proc.kill('SIGKILL');
    console.log(`🛑 Killed tracked ${label} process PID=${proc.pid}`);
  } catch (error: any) {
    console.log(`⚠️ Failed to kill tracked ${label} PID=${proc.pid}: ${error.message}`);
  }
}

async function killPort(port: number) {
  try {
    await execPromise(`fuser -k ${port}/tcp || true`);
    console.log(`🧹 Cleared port ${port}`);
  } catch (error: any) {
    console.log(`⚠️ Failed clearing port ${port}: ${error.message}`);
  }
}

// Boots backend/frontend locally and captures a mobile viewport screenshot of the target route.
export async function takeSnapshot(targetRoute: string = '/'): Promise<SnapshotResult> {
  // Normalizes Expo Router file paths into a browser-safe route.
  let safeRoute = targetRoute.replace(/^\/?app\//, '/').replace(/\/\([^)]+\)/g, '').replace(/\/index\/?$/i, '');
  if (!safeRoute || safeRoute === '') safeRoute = '/';
  if (!safeRoute.startsWith('/')) safeRoute = '/' + safeRoute;

  const snapshotPath = path.join(WORKSPACE_DIR, 'snapshot.png');
  const port = 8081;
  const backendPort = 3000;
  const localUrl = `http://localhost:${port}${safeRoute}`;
  const ip = getLocalIpAddress();
  const mobileUrl = ip ? `http://${ip}:${port}${safeRoute}` : null;

  console.log(`📸 Requested route: ${targetRoute}`);
  console.log('🚀 Launching preview services', {
    expoPath: TARGET_EXPO_PATH,
    apiPath: TARGET_API_PATH,
    localUrl,
    mobileUrl,
  });

  // Kill tracked processes first.
  killTrackedProcess(currentExpoProcess, 'expo');
  killTrackedProcess(currentNestProcess, 'nest');
  currentExpoProcess = null;
  currentNestProcess = null;

  // Then aggressively clear ports in case shell children survived.
  await killPort(port);
  await killPort(backendPort);

  // Small pause so the OS releases ports cleanly.
  await new Promise((r) => setTimeout(r, 1500));

  if (TARGET_API_PATH) {
    console.log('🔌 Starting NestJS Backend (Local Port 3000)...');

    currentNestProcess = spawn('npm', ['run', 'start'], {
      cwd: TARGET_API_PATH,
      stdio: 'pipe',
    });

    currentNestProcess.stdout?.on('data', (data) => {
      console.log(`[NEST] ${data.toString().trim()}`);
    });

    currentNestProcess.stderr?.on('data', (data) => {
      console.log(`[NEST:ERR] ${data.toString().trim()}`);
    });

    const backendUrl = ip ? `http://${ip}:${backendPort}` : `http://localhost:${backendPort}`;
    injectApiUrlToEnv(backendUrl);

    await new Promise((r) => setTimeout(r, 3000));
  }

  return new Promise((resolve) => {
    console.log('🚀 Starting new Expo Web Server...');

    currentExpoProcess = spawn('npx', ['expo', 'start', '--web', '--port', port.toString()], {
      cwd: TARGET_EXPO_PATH,
      stdio: 'pipe',
    });

    currentExpoProcess.stdout?.on('data', (data) => {
      const text = data.toString().trim();
      console.log(`[EXPO] ${text}`);
    });

    currentExpoProcess.stderr?.on('data', (data) => {
      const text = data.toString().trim();
      console.log(`[EXPO:ERR] ${text}`);
    });

    let isResolved = false;
    let serverReady = false;

    const processOutput = (data: any) => {
      const rawString = data.toString();
      if (
        rawString.includes('http://localhost') ||
        rawString.includes('Web is waiting on') ||
        rawString.includes('ready in')
      ) {
        serverReady = true;
      }
    };

    currentExpoProcess.stdout?.on('data', processOutput);
    currentExpoProcess.stderr?.on('data', processOutput);

    const checkInterval = setInterval(async () => {
      if (serverReady && !isResolved) {
        isResolved = true;
        clearInterval(checkInterval);

        try {
          console.log('🌐 Expo Server ready! Taking snapshot...');

          const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
          });

          const page = await browser.newPage();
          await page.setViewport({ width: 390, height: 844, isMobile: true });
          await page.goto(localUrl, { waitUntil: 'networkidle2', timeout: 30000 });
          await page.screenshot({ path: snapshotPath });
          await browser.close();

          resolve({ snapshotPath, publicUrl: mobileUrl, localUrl });
        } catch (error: any) {
          console.log(`⚠️ Puppeteer failed: ${error.message}`);
          resolve({
            snapshotPath: null,
            publicUrl: mobileUrl,
            localUrl,
            warning: `Snapshot failed: ${error.message}`,
          });
        }
      }
    }, 1000);

    setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        clearInterval(checkInterval);
        resolve({
          snapshotPath: null,
          publicUrl: mobileUrl,
          localUrl,
          warning: '⚠️ Server start timeout.',
        });
      }
    }, 30000);
  });
}