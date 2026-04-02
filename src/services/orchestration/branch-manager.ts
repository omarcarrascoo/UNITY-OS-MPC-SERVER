import { exec } from 'child_process';
import util from 'util';
import { getRuntimeConfig } from '../../config.js';
import type { PreparedWorkspace } from '../../domain/runtime.js';

const execPromise = util.promisify(exec);

export interface IntegrationBranchState {
  defaultBranch: string;
  integrationBranch: string;
  created: boolean;
}

async function tryGitCommand(command: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await execPromise(command, { cwd });
    return (stdout || '').trim();
  } catch {
    return '';
  }
}

export async function detectDefaultBranch(repoPath: string): Promise<string> {
  const symbolicRef = await tryGitCommand('git symbolic-ref refs/remotes/origin/HEAD', repoPath);
  if (symbolicRef.startsWith('refs/remotes/origin/')) {
    return symbolicRef.replace('refs/remotes/origin/', '').trim();
  }

  const remoteShow = await tryGitCommand('git remote show origin', repoPath);
  const match = remoteShow.match(/HEAD branch:\s+([^\n]+)/);
  if (match) {
    return match[1].trim();
  }

  return getRuntimeConfig().githubBaseBranch;
}

async function localBranchExists(repoPath: string, branchName: string): Promise<boolean> {
  try {
    await execPromise(`git show-ref --verify --quiet refs/heads/${branchName}`, { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

async function remoteBranchExists(repoPath: string, branchName: string): Promise<boolean> {
  const output = await tryGitCommand(`git ls-remote --heads origin ${branchName}`, repoPath);
  return output.trim() !== '';
}

export async function ensureIntegrationBranch(
  workspace: PreparedWorkspace,
  integrationBranch = getRuntimeConfig().integrationBranchName,
): Promise<IntegrationBranchState> {
  await tryGitCommand('git fetch origin --prune', workspace.repoPath);
  const defaultBranch = await detectDefaultBranch(workspace.repoPath);
  const hasRemoteBranch = await remoteBranchExists(workspace.repoPath, integrationBranch);
  const hasLocalBranch = await localBranchExists(workspace.repoPath, integrationBranch);

  if (hasRemoteBranch) {
    await execPromise(`git checkout -B ${integrationBranch} origin/${integrationBranch}`, {
      cwd: workspace.repoPath,
    });
    await tryGitCommand(`git pull --ff-only origin ${integrationBranch}`, workspace.repoPath);
    return {
      defaultBranch,
      integrationBranch,
      created: false,
    };
  }

  if (hasLocalBranch) {
    await execPromise(`git checkout ${integrationBranch}`, { cwd: workspace.repoPath });
  } else {
    await execPromise(`git checkout ${defaultBranch}`, { cwd: workspace.repoPath });
    await tryGitCommand(`git pull --ff-only origin ${defaultBranch}`, workspace.repoPath);
    await execPromise(`git checkout -B ${integrationBranch}`, { cwd: workspace.repoPath });
  }

  await execPromise(`git push -u origin ${integrationBranch}`, { cwd: workspace.repoPath });

  return {
    defaultBranch,
    integrationBranch,
    created: true,
  };
}

export async function commitAllChanges(repoPath: string, commitMessage: string): Promise<string | null> {
  const status = await tryGitCommand('git status --porcelain', repoPath);
  if (!status.trim()) {
    return null;
  }

  const safeCommitMessage = commitMessage.replace(/"/g, '\\"');
  await execPromise('git add .', { cwd: repoPath });
  await execPromise(`git commit -m "${safeCommitMessage}"`, { cwd: repoPath });
  return tryGitCommand('git rev-parse HEAD', repoPath);
}

export async function cherryPickCommit(repoPath: string, commitSha: string): Promise<void> {
  try {
    await execPromise(`git cherry-pick ${commitSha}`, { cwd: repoPath });
  } catch (error) {
    await tryGitCommand('git cherry-pick --abort', repoPath);
    throw error;
  }
}

export async function pushBranch(repoPath: string, branchName: string): Promise<void> {
  await execPromise(`git push origin ${branchName}`, { cwd: repoPath });
}

export async function checkoutBranch(repoPath: string, branchName: string): Promise<void> {
  await execPromise(`git checkout ${branchName}`, { cwd: repoPath });
}

export async function getDiffAgainstHead(repoPath: string): Promise<string> {
  return tryGitCommand('git diff HEAD~1..HEAD', repoPath);
}
