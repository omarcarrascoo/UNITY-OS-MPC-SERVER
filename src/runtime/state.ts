import { getRuntimeConfig, getProjectByName } from '../config.js';
import type { WorkspaceProject } from '../domain/runtime.js';

interface SessionRecord {
  commitMessage: string;
  projectName: string;
}

export class RuntimeState {
  private activeProjectName: string;
  private processing = false;
  private abortController: AbortController | null = null;
  private readonly sessionStore = new Map<string, SessionRecord>();

  constructor(initialProjectName = getRuntimeConfig().githubRepo) {
    this.activeProjectName = initialProjectName;
  }

  getActiveProject(): WorkspaceProject {
    return getProjectByName(this.activeProjectName);
  }

  setActiveProject(repoName: string): WorkspaceProject {
    this.activeProjectName = repoName;
    return this.getActiveProject();
  }

  getActiveProjectName(): string {
    return this.activeProjectName;
  }

  isProcessing(): boolean {
    return this.processing;
  }

  startProcessing(): AbortController {
    if (this.processing) {
      throw new Error('Runtime is already processing another task.');
    }

    this.processing = true;
    this.abortController = new AbortController();
    return this.abortController;
  }

  finishProcessing(): void {
    this.processing = false;
    this.abortController = null;
  }

  abortCurrentTask(): boolean {
    if (!this.abortController) {
      return false;
    }

    this.abortController.abort();
    return true;
  }

  getAbortSignal(): AbortSignal | undefined {
    return this.abortController?.signal;
  }

  rememberSession(sessionId: string, commitMessage: string, projectName: string): void {
    this.sessionStore.set(sessionId, { commitMessage, projectName });
  }

  getSessionRecord(sessionId: string): SessionRecord | undefined {
    return this.sessionStore.get(sessionId);
  }

  deleteSession(sessionId: string): void {
    this.sessionStore.delete(sessionId);
  }
}
