import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import type { PreparedWorkspace, WorkspaceProject } from '../../domain/runtime.js';
import { resolveWorkspace } from '../../git.js';

const execPromise = util.promisify(exec);

export interface TaskWorktree {
  branchName: string;
  workspace: PreparedWorkspace;
  worktreePath: string;
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function pathExistsNoFollow(targetPath: string): boolean {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function removePathIfExists(targetPath: string): void {
  if (pathExistsNoFollow(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

function resolveUsableDirectory(source: string): string | null {
  try {
    const stat = fs.lstatSync(source);

    if (stat.isSymbolicLink()) {
      const resolved = fs.realpathSync(source);
      const resolvedStat = fs.statSync(resolved);
      return resolvedStat.isDirectory() ? resolved : null;
    }

    return stat.isDirectory() ? source : null;
  } catch {
    return null;
  }
}

function isSelfReferentialLink(targetPath: string): boolean {
  try {
    if (!fs.lstatSync(targetPath).isSymbolicLink()) {
      return false;
    }

    const linkTarget = fs.readlinkSync(targetPath);
    const resolvedLinkTarget = path.resolve(path.dirname(targetPath), linkTarget);
    return resolvedLinkTarget === path.resolve(targetPath);
  } catch {
    return false;
  }
}

function createSymlinkIfMissing(source: string, target: string): void {
  const usableSource = resolveUsableDirectory(source);
  if (!usableSource) {
    return;
  }

  if (pathExistsNoFollow(target)) {
    if (isSelfReferentialLink(target)) {
      removePathIfExists(target);
    } else {
      return;
    }
  }

  const resolvedTarget = path.resolve(target);
  if (path.resolve(usableSource) === resolvedTarget) {
    return;
  }

  fs.symlinkSync(usableSource, target, 'dir');
}

function copyEnvFileIfPresent(sourceDir: string, targetDir: string): void {
  const sourceEnv = path.join(sourceDir, '.env');
  const targetEnv = path.join(targetDir, '.env');

  if (fs.existsSync(sourceEnv) && !pathExistsNoFollow(targetEnv)) {
    fs.copyFileSync(sourceEnv, targetEnv);
  }
}

function syncLocalSupportFiles(baseWorkspace: PreparedWorkspace, taskWorkspace: PreparedWorkspace): void {
  copyEnvFileIfPresent(baseWorkspace.repoPath, taskWorkspace.repoPath);

  for (const basePackageDir of baseWorkspace.packageDirs) {
    const relativeDir = path.relative(baseWorkspace.repoPath, basePackageDir);
    const taskPackageDir = path.join(taskWorkspace.repoPath, relativeDir);

    ensureDir(taskPackageDir);
    copyEnvFileIfPresent(basePackageDir, taskPackageDir);
    createSymlinkIfMissing(path.join(basePackageDir, 'node_modules'), path.join(taskPackageDir, 'node_modules'));
  }
}

export async function createTaskWorktree(
  baseWorkspace: PreparedWorkspace,
  runId: string,
  taskId: string,
  baseRef: string,
): Promise<TaskWorktree> {
  const worktreesRoot = path.join(baseWorkspace.workspaceDir, '.unity-worktrees', runId);
  const worktreePath = path.join(worktreesRoot, taskId);
  const branchName = `unity-task-${runId}-${taskId}`.slice(0, 120);

  ensureDir(worktreesRoot);
  await execPromise('git worktree prune', { cwd: baseWorkspace.repoPath }).catch(() => {});
  await execPromise(`git worktree remove --force "${worktreePath}"`, {
    cwd: baseWorkspace.repoPath,
  }).catch(() => {});
  removePathIfExists(worktreePath);

  await execPromise(`git worktree add -B ${branchName} "${worktreePath}" ${baseRef}`, {
    cwd: baseWorkspace.repoPath,
  });

  const taskProject: WorkspaceProject = {
    name: baseWorkspace.name,
    repoPath: worktreePath,
    workspaceDir: baseWorkspace.workspaceDir,
  };

  const taskWorkspace = await resolveWorkspace(taskProject);
  syncLocalSupportFiles(baseWorkspace, taskWorkspace);

  return {
    branchName,
    workspace: taskWorkspace,
    worktreePath,
  };
}

export async function removeTaskWorktree(baseRepoPath: string, worktreePath: string): Promise<void> {
  await execPromise(`git worktree remove --force "${worktreePath}"`, { cwd: baseRepoPath }).catch(() => {});
  removePathIfExists(worktreePath);
}
