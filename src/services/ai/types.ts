export interface FileEdit {
  filepath: string;
  search: string;
  replace: string;
}

export interface AIResponse {
  targetRoute: string;
  commitMessage: string;
  edits: FileEdit[];
}

export interface ValidationResult {
  rawOutput: string;
  normalizedErrors: Set<string>;
}

export interface BuildSystemPromptParams {
  userPrompt: string;
  figmaData: string | null;
  projectTree: string;
  projectMemory: string | null;
  currentDiff: string | null;
}

export interface GenerateCodeParams extends BuildSystemPromptParams {
  repoPath: string;
  onStatusUpdate?: (status: string, thought?: string) => void;
  signal?: AbortSignal;
}

