import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import { WORKSPACE_DIR, TARGET_REPO_PATH } from './config.js';

const execPromise = util.promisify(exec);
const BASE_BRANCH = process.env.GITHUB_BASE_BRANCH || 'main';

// Runtime-discovered app and API roots used by snapshot and orchestration modules.
export let TARGET_EXPO_PATH = TARGET_REPO_PATH;
export let TARGET_API_PATH: string | null = null;

// Ensures the active repo exists locally and is reset to a known clean baseline.
export async function prepareWorkspace(): Promise<void> {
  if (!fs.existsSync(WORKSPACE_DIR)) fs.mkdirSync(WORKSPACE_DIR);

  const repoUrl = `https://${process.env.GITHUB_TOKEN}@github.com/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}.git`;

  if (!fs.existsSync(TARGET_REPO_PATH)) {
    console.log(`📥 Cloning ${process.env.GITHUB_REPO}...`);
    await execPromise(`git clone "${repoUrl}" "${TARGET_REPO_PATH}"`);
  } else {
    console.log(`🔄 Resetting and updating ${process.env.GITHUB_REPO} for a fresh start...`);
    await execPromise(`git reset --hard HEAD`, { cwd: TARGET_REPO_PATH }).catch(() => {});
    await execPromise(`git clean -fd`, { cwd: TARGET_REPO_PATH }).catch(() => {});
    await execPromise(`git checkout ${BASE_BRANCH}`, { cwd: TARGET_REPO_PATH });
    await execPromise(`git pull origin ${BASE_BRANCH}`, { cwd: TARGET_REPO_PATH });
  }

  // Reset runtime-discovered paths every time the active project changes.
  TARGET_EXPO_PATH = TARGET_REPO_PATH;
  TARGET_API_PATH = null;

  await autoDetectAndInstall(TARGET_REPO_PATH);
}

// Detects project topology (single Expo app vs monorepo) and installs dependencies.
async function autoDetectAndInstall(basePath: string) {
  console.log(`📦 Scanning architecture in ${basePath}...`);
  let isSingleRepo = false;

  if (fs.existsSync(path.join(basePath, 'package.json'))) {
    const pkg = JSON.parse(fs.readFileSync(path.join(basePath, 'package.json'), 'utf8'));

    if (pkg.dependencies?.expo || pkg.devDependencies?.expo) {
      isSingleRepo = true;
      TARGET_EXPO_PATH = basePath;
      console.log(`⚙️ Single Repo detected. Installing Root Dependencies...`);
      await execPromise(`npm install`, { cwd: basePath });
    }
  }

  if (!isSingleRepo) {
    console.log(`⚙️ Monorepo detected. Scanning modules...`);
    const items = fs.readdirSync(basePath, { withFileTypes: true });

    for (const item of items) {
      if (item.isDirectory() && !['node_modules', '.git', 'assets', 'dist'].includes(item.name)) {
        const subDir = path.join(basePath, item.name);

        if (fs.existsSync(path.join(subDir, 'package.json'))) {
          console.log(`⚙️ Installing module: ${item.name}...`);
          await execPromise(`npm install`, { cwd: subDir });

          const pkg = JSON.parse(fs.readFileSync(path.join(subDir, 'package.json'), 'utf8'));

          if (pkg.dependencies?.expo || pkg.devDependencies?.expo || item.name.startsWith('expo-')) {
            console.log(`🚀 Expo App located at: ${subDir}`);
            TARGET_EXPO_PATH = subDir;
          }

          if (pkg.dependencies?.['@nestjs/core'] || item.name.includes('api') || item.name.includes('infra')) {
            console.log(`🔌 NestJS API located at: ${subDir}`);
            TARGET_API_PATH = subDir;
          }
        }
      }
    }
  }
}

// Creates a feature branch, commits generated changes, pushes, and opens a GitHub PR.
export async function createPullRequest(featureName: string, commitMessage: string): Promise<string> {
  const branchName = `jarvis-${featureName}`;
  const safeCommitMsg = commitMessage.replace(/"/g, '\\"');

  try {
    await execPromise(`git checkout -b ${branchName}`, { cwd: TARGET_REPO_PATH });
    await execPromise(`git add .`, { cwd: TARGET_REPO_PATH });
    await execPromise(`git commit -m "${safeCommitMsg}"`, { cwd: TARGET_REPO_PATH });
    await execPromise(`git push origin ${branchName}`, { cwd: TARGET_REPO_PATH });

    const prResponse = await fetch(`https://api.github.com/repos/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/pulls`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: `✨ ${commitMessage}`,
        body: `This PR was automatically generated via Discord.\n\n**Exact Changes:**\n${commitMessage}`,
        head: branchName,
        base: BASE_BRANCH,
      }),
    });

    if (!prResponse.ok) throw new Error(await prResponse.text());

    const prData = await prResponse.json();
    await execPromise(`git checkout ${BASE_BRANCH}`, { cwd: TARGET_REPO_PATH });
    return prData.html_url;
  } catch (error) {
    await execPromise(`git checkout ${BASE_BRANCH}`, { cwd: TARGET_REPO_PATH }).catch(() => {});
    throw error;
  }
}