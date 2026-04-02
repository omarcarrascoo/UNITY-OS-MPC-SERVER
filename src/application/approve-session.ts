import type { WorkspaceProject } from '../domain/runtime.js';
import { generatePRMetadata } from '../ai.js';
import { createPullRequest, getRepositoryDiff, resolveWorkspace } from '../git.js';

interface ApproveSessionParams {
  project: WorkspaceProject;
  sessionId: string;
  fallbackCommitMessage?: string;
}

export async function approveSession({
  project,
  sessionId,
  fallbackCommitMessage,
}: ApproveSessionParams): Promise<string> {
  const workspace = await resolveWorkspace(project);
  const finalDiff = await getRepositoryDiff(project);
  const smartCommitMsg = finalDiff.trim()
    ? await generatePRMetadata(finalDiff)
    : fallbackCommitMessage || 'feat: update from Jarvis';

  return createPullRequest(workspace, `req-${sessionId}`, smartCommitMsg);
}

