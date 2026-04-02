export interface WorkspaceProject {
  name: string;
  repoPath: string;
  workspaceDir: string;
}

export interface PreparedWorkspace extends WorkspaceProject {
  expoPath: string;
  apiPath: string | null;
  packageDirs: string[];
}

export interface ProjectContextSnapshot {
  figmaData: string | null;
  projectTree: string;
  projectMemory: string | null;
  currentDiff: string | null;
}

export interface TaskExecutionResult {
  targetRoute: string;
  commitMessage: string;
  tokenUsage: number;
}

export interface CompletedTaskArtifacts extends TaskExecutionResult {
  sessionId: string;
  snapshotPath: string | null;
  publicUrl: string | null;
  localUrl: string;
  warning?: string;
  diffPath: string | null;
}
