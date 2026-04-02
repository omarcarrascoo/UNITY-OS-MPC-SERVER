export interface GatePolicy {
  runTypecheck: boolean;
  runLint: boolean;
  runTests: boolean;
  runBuild: boolean;
  runRuntime: boolean;
  requireRuntimeForUi: boolean;
  captureSnapshot: boolean;
}

export interface AutonomousRunPolicy {
  integrationBranchName: string;
  autoApprovePlan: boolean;
  maxParallelTasks: number;
  maxRetriesPerTask: number;
  maxImprovementCycles: number;
  maxHours: number;
  maxCommits: number;
  gates: GatePolicy;
}

export interface NightJobConfig {
  maxHours: number;
  maxCommits: number;
  maxParallelTasks: number;
  maxRetriesPerTask: number;
}
