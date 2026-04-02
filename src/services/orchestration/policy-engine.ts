import { getRuntimeConfig } from '../../config.js';
import type { AutonomousRunPolicy } from '../../domain/policies.js';
import { UnityStore } from '../persistence/unity-store.js';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function getDefaultAutonomousRunPolicy(): AutonomousRunPolicy {
  return {
    integrationBranchName: getRuntimeConfig().integrationBranchName,
    autoApprovePlan: true,
    maxParallelTasks: 3,
    maxRetriesPerTask: 2,
    maxImprovementCycles: 2,
    maxHours: 1,
    maxCommits: 8,
    gates: {
      runTypecheck: true,
      runLint: true,
      runTests: true,
      runBuild: true,
      runRuntime: true,
      requireRuntimeForUi: true,
      captureSnapshot: false,
    },
  };
}

export function normalizePolicy(policy: AutonomousRunPolicy): AutonomousRunPolicy {
  return {
    ...policy,
    autoApprovePlan: policy.autoApprovePlan ?? true,
    maxParallelTasks: clamp(policy.maxParallelTasks, 1, 6),
    maxRetriesPerTask: clamp(policy.maxRetriesPerTask, 0, 5),
    maxImprovementCycles: clamp(policy.maxImprovementCycles, 0, 4),
    maxHours: clamp(policy.maxHours, 1, 4),
    maxCommits: clamp(policy.maxCommits, 1, 50),
  };
}

export function getProjectPolicy(store: UnityStore, projectName: string): AutonomousRunPolicy {
  const stored = store.getPolicy(projectName);
  return normalizePolicy(stored || getDefaultAutonomousRunPolicy());
}
