import fs from 'fs';
import path from 'path';
import type { CompletedTaskArtifacts, WorkspaceProject } from '../domain/runtime.js';
import { getFigmaContext } from '../figma.js';
import { getProjectMemory, getProjectTree } from '../scanner.js';
import { generateAndWriteCode } from '../ai.js';
import { takeSnapshot } from '../snapshot.js';
import {
  getRepositoryDiff,
  prepareWorkspace,
  resolveWorkspace,
} from '../git.js';

interface RunDevelopmentTaskParams {
  project: WorkspaceProject;
  prompt: string;
  isIteration: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => Promise<void>;
  onAgentStatusUpdate?: (status: string, thought?: string) => Promise<void>;
}

async function archiveDiffArtifacts(workspaceDir: string): Promise<void> {
  const logsDir = path.join(workspaceDir, 'logs');

  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const workspaceFiles = fs.readdirSync(workspaceDir);

  for (const file of workspaceFiles) {
    const fullPath = path.join(workspaceDir, file);

    if (file.endsWith('.diff') && fs.statSync(fullPath).isFile()) {
      fs.renameSync(fullPath, path.join(logsDir, file));
    }
  }
}

async function persistSessionDiff(
  workspaceDir: string,
  sessionId: string,
  diffOutput: string,
): Promise<string | null> {
  if (!diffOutput.trim()) {
    return null;
  }

  const diffPath = path.join(workspaceDir, `changes_${sessionId}.diff`);
  fs.writeFileSync(diffPath, diffOutput);
  return diffPath;
}

export async function runDevelopmentTask({
  project,
  prompt,
  isIteration,
  signal,
  onProgress,
  onAgentStatusUpdate,
}: RunDevelopmentTaskParams): Promise<CompletedTaskArtifacts> {
  const workspace = isIteration
    ? await resolveWorkspace(project)
    : await prepareWorkspace(project);

  const figmaData = await getFigmaContext(prompt);
  if (figmaData && onProgress) {
    await onProgress('🎨 Figma link detected. Analyzing design...');
  }

  const projectTree = getProjectTree(workspace.repoPath);
  const projectMemory = getProjectMemory(workspace.repoPath);

  if (projectMemory && onProgress) {
    await onProgress('🧠 UnityRC memory loaded. Applying architectural rules...');
  }

  let currentDiff: string | null = null;
  if (isIteration) {
    const diffOutput = await getRepositoryDiff(project);
    if (diffOutput.trim()) {
      currentDiff = diffOutput;
      if (onProgress) {
        await onProgress('🔄 Short-Term Memory loaded. Analyzing uncommitted changes...');
      }
    }
  }

  const finalPrompt = isIteration
    ? `We are iterating on the current code. Keep the recent changes but apply this correction: "${prompt}"`
    : prompt;

  const result = await generateAndWriteCode({
    repoPath: workspace.repoPath,
    userPrompt: finalPrompt,
    figmaData,
    projectTree,
    projectMemory,
    currentDiff,
    onStatusUpdate: onAgentStatusUpdate,
    signal,
  });

  const sessionId = Date.now().toString().slice(-6);

  if (onProgress) {
    await onProgress(`📸 Code generated. Navigating to \`${result.targetRoute}\` to take snapshot...`);
  }

  const snapshot = await takeSnapshot(workspace, result.targetRoute);
  await archiveDiffArtifacts(workspace.workspaceDir);
  const diffPath = await persistSessionDiff(
    workspace.workspaceDir,
    sessionId,
    await getRepositoryDiff(project),
  );

  return {
    sessionId,
    targetRoute: result.targetRoute,
    commitMessage: result.commitMessage,
    tokenUsage: result.tokenUsage,
    snapshotPath: snapshot.snapshotPath,
    publicUrl: snapshot.publicUrl,
    localUrl: snapshot.localUrl,
    warning: snapshot.warning,
    diffPath,
  };
}

