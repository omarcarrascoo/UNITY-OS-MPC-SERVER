import type { WorkspaceProject } from '../domain/runtime.js';
import { resetWorkspace } from '../git.js';

export async function rejectSession(project: WorkspaceProject): Promise<void> {
  await resetWorkspace(project);
}

