import path from 'path';
import { getRuntimeConfig, getProjectByName } from '../config.js';
import { getFigmaContext } from '../figma.js';
import { prepareWorkspace } from '../git.js';
import { getProjectMemory, getProjectTree } from '../scanner.js';
import { generateAndWriteCode } from '../ai.js';
import type {
  GateResult,
  PlanTaskDraft,
  ReviewResult,
  RunPlanDraft,
  RunMode,
  RunRecord,
  TaskExecutionOutcome,
  TaskRecord,
} from '../domain/orchestration.js';
import type { AutonomousRunPolicy } from '../domain/policies.js';
import type { PreparedWorkspace, WorkspaceProject } from '../domain/runtime.js';
import { unityStore } from '../runtime/services.js';
import { createEntityId } from '../shared/ids.js';
import {
  checkoutBranch,
  cherryPickCommit,
  commitAllChanges,
  ensureIntegrationBranch,
  getDiffAgainstHead,
  pushBranch,
} from '../services/orchestration/branch-manager.js';
import { runRuntimeGate, runStaticGates, summarizeGateResults } from '../services/orchestration/gates.js';
import { planAutonomousRun } from '../services/orchestration/planner.js';
import { getProjectPolicy } from '../services/orchestration/policy-engine.js';
import { reviewTaskResult } from '../services/orchestration/reviewer.js';
import { createTaskWorktree, removeTaskWorktree } from '../services/orchestration/worktree-manager.js';

interface RunAutonomousAgentParams {
  project: WorkspaceProject;
  prompt: string;
  channelName: string;
  mode?: RunMode;
  signal?: AbortSignal;
  onProgress?: (message: string) => Promise<void>;
}

interface CreateAutonomousRunPlanResult {
  runId: string;
  branchName: string;
  defaultBranch: string;
  planSummary: string;
  consoleUrl: string;
  requiresApproval: boolean;
  autoApproved: boolean;
  tasks: Array<{
    title: string;
    writeScope: string[];
    dependencies: string[];
  }>;
}

interface ResumeAutonomousRunParams {
  runId: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => Promise<void>;
}

interface RunAutonomousAgentResult {
  runId: string;
  branchName: string;
  defaultBranch: string;
  summary: string;
  commitsCreated: number;
  runtimeUrls: {
    localUrl: string | null;
    publicUrl: string | null;
  };
  tasks: Array<{
    title: string;
    status: TaskRecord['status'];
    commitMessage?: string | null;
  }>;
}

interface ExecutedTaskResult {
  task: TaskRecord;
  outcome: TaskExecutionOutcome;
  review: ReviewResult;
  diff: string;
  targetRoute: string;
}

const ADVISORY_TITLE_PATTERN =
  /^(analy[sz]e|analy[sz]ing|analysis|analizar|revisar|review|inspect|investigate|diagnose|audit|explore)\b/i;
const RUN_CLOSING_WINDOW_MS = 10 * 60 * 1000;

interface RunBudgetState {
  remainingMs: number;
  inClosingWindow: boolean;
  exhausted: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function formatRemainingTime(remainingMs: number): string {
  const safeMs = Math.max(0, remainingMs);
  const totalMinutes = Math.ceil(safeMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours <= 0) {
    return `${minutes} minute(s)`;
  }

  return `${hours} hour(s) ${minutes} minute(s)`;
}

function getRunBudgetState(deadline: number): RunBudgetState {
  const remainingMs = deadline - Date.now();

  return {
    remainingMs,
    inClosingWindow: remainingMs <= RUN_CLOSING_WINDOW_MS,
    exhausted: remainingMs <= 0,
  };
}

function hasScopeConflict(left: string[], right: string[]): boolean {
  const normalizedLeft = left.length ? left : ['.'];
  const normalizedRight = right.length ? right : ['.'];

  for (const leftScope of normalizedLeft) {
    for (const rightScope of normalizedRight) {
      if (leftScope === '.' || rightScope === '.') {
        return true;
      }

      if (
        leftScope === rightScope ||
        leftScope.startsWith(`${rightScope}/`) ||
        rightScope.startsWith(`${leftScope}/`)
      ) {
        return true;
      }
    }
  }

  return false;
}

function normalizeScopes(scopes: string[]): string[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return ['.'];
  }

  const normalized = scopes
    .map((scope) => scope.trim().replace(/^\.?\//, '').replace(/\/+$/, ''))
    .filter(Boolean);

  return normalized.length ? normalized : ['.'];
}

function isPathWithinScope(filePath: string, scope: string): boolean {
  if (scope === '.') {
    return true;
  }

  return filePath === scope || filePath.startsWith(`${scope}/`);
}

function isAdvisoryTaskTitle(title: string): boolean {
  return ADVISORY_TITLE_PATTERN.test(title.trim());
}

function getRelativePackageDirs(workspace: PreparedWorkspace): string[] {
  return Array.from(
    new Set(
      workspace.packageDirs
        .map((packageDir) => path.relative(workspace.repoPath, packageDir) || '.')
        .filter((packageDir) => packageDir !== '.'),
    ),
  );
}

function getAllowedPackageDirs(workspace: PreparedWorkspace, scopes: string[]): string[] {
  if (scopes.includes('.')) {
    return getRelativePackageDirs(workspace);
  }

  const packageDirs = getRelativePackageDirs(workspace);
  return packageDirs.filter((packageDir) =>
    scopes.some((scope) => isPathWithinScope(scope, packageDir) || isPathWithinScope(packageDir, scope)),
  );
}

function extractChangedPaths(diff: string): string[] {
  const paths = new Set<string>();

  for (const line of diff.split('\n')) {
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (!match) continue;
    paths.add(match[2]);
  }

  return Array.from(paths);
}

function getOutOfScopePaths(workspace: PreparedWorkspace, diff: string, scopes: string[]): string[] {
  const normalizedScopes = normalizeScopes(scopes);
  if (normalizedScopes.includes('.')) {
    return [];
  }

  const allowedPackageDirs = getAllowedPackageDirs(workspace, normalizedScopes);
  return extractChangedPaths(diff).filter((filePath) => {
    if (normalizedScopes.some((scope) => isPathWithinScope(filePath, scope))) {
      return false;
    }

    if (allowedPackageDirs.some((packageDir) => isPathWithinScope(filePath, packageDir))) {
      return false;
    }

    return true;
  });
}

function buildScopedTaskPrompt(
  task: TaskRecord,
  runPrompt: string,
  dependencyContext: string,
  options?: { inClosingWindow?: boolean; remainingMs?: number },
): string {
  const scopes = normalizeScopes(task.writeScope);
  const budgetInstructions = options?.inClosingWindow
    ? `

Time budget warning:
- The run is inside its final closing window with about ${formatRemainingTime(options.remainingMs || 0)} remaining.
- Prioritize finishing the smallest viable change for this task.
- Do not expand scope, start adjacent refactors, or generate optional follow-up work unless absolutely necessary for correctness.
- Prefer wrapping up cleanly over chasing ideal completion.`
    : '';

  return `Run goal:
${runPrompt}

Task title:
${task.title}

Writable scope:
${scopes.join(', ')}

Rules:
- Deliver concrete code changes, not analysis-only output.
- Focus on this task's scope and ignore unrelated failures elsewhere in the repo.
- Only touch files outside the task scope when they are directly required to complete the scoped change.
- Prefer the smallest correct implementation that clears scoped validation.
${budgetInstructions}

Dependency context:
${dependencyContext || '(none)'}

Task instruction:
${task.prompt}`;
}

function buildDependencyContext(task: TaskRecord, tasks: TaskRecord[]): string {
  return task.dependencies
    .map((dependencyId) => tasks.find((candidate) => candidate.id === dependencyId))
    .filter((dependency): dependency is TaskRecord => Boolean(dependency))
    .map((dependency) => {
      const summary =
        dependency.outputSummary ||
        dependency.validationSummary ||
        dependency.commitMessage ||
        `Dependency finished with status ${dependency.status}.`;

      return `- ${dependency.title}: ${summary}`;
    })
    .join('\n');
}

function buildDependencyBlockReason(task: TaskRecord, tasks: TaskRecord[]): string {
  const blockingDependencies = task.dependencies
    .map((dependencyId) => tasks.find((candidate) => candidate.id === dependencyId))
    .filter((dependency): dependency is TaskRecord => Boolean(dependency))
    .filter((dependency) => dependency.status === 'failed' || dependency.status === 'blocked');

  if (blockingDependencies.length === 0) {
    return 'Task remained pending because its dependencies never reached a runnable state.';
  }

  return `Blocked by dependencies: ${blockingDependencies
    .map((dependency) => `${dependency.title} [${dependency.status}]`)
    .join(', ')}.`;
}

function getNewFailedGates(baseline: GateResult[], current: GateResult[]): GateResult[] {
  const baselineStatusByName = new Map(baseline.map((gate) => [gate.name, gate.status]));

  return current.filter((gate) => {
    if (gate.status !== 'failed') {
      return false;
    }

    return baselineStatusByName.get(gate.name) !== 'failed';
  });
}

function buildRunRecord(
  runId: string,
  projectName: string,
  channelName: string,
  prompt: string,
  policy: AutonomousRunPolicy,
  branchName: string,
  defaultBranch: string,
  mode: RunMode,
): RunRecord {
  const timestamp = nowIso();

  return {
    id: runId,
    projectName,
    channelName,
    prompt,
    status: 'planning',
    mode,
    branchName,
    defaultBranch,
    maxParallelTasks: policy.maxParallelTasks,
    maxRetriesPerTask: policy.maxRetriesPerTask,
    maxImprovementCycles: policy.maxImprovementCycles,
    maxHours: policy.maxHours,
    maxCommits: policy.maxCommits,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: null,
    summary: null,
  };
}

function buildConsoleRunUrl(runId: string): string {
  const config = getRuntimeConfig();
  return `http://localhost:${config.localConsolePort}/runs/${runId}`;
}

function createTasksFromPlan(runId: string, plan: RunPlanDraft): TaskRecord[] {
  const titleToId = new Map<string, string>();

  for (const task of plan.tasks) {
    titleToId.set(task.title, createEntityId('task'));
  }

  return plan.tasks.map((task, index) => {
    const id = titleToId.get(task.title) as string;
    const timestamp = nowIso();

    return {
      id,
      runId,
      title: task.title,
      prompt: task.prompt,
      role: 'executor',
      kind: task.kind,
      status: 'pending',
      writeScope: task.writeScope,
      dependencies: (task.dependencies || [])
        .filter((title) => !isAdvisoryTaskTitle(title))
        .map((title) => titleToId.get(title))
        .filter(Boolean) as string[],
      attempts: 0,
      branchName: null,
      worktreePath: null,
      commitSha: null,
      commitMessage: null,
      outputSummary: task.rationale || null,
      validationSummary: null,
      orderIndex: index,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      finishedAt: null,
      parentTaskId: null,
    };
  });
}

function buildRetryPrompt(task: TaskRecord, validationSummary: string): string {
  return `${task.prompt}

Retry context:
${validationSummary}

Repair only what is necessary to make this task pass all gates.`;
}

function dedupeFollowUpTasks(drafts: PlanTaskDraft[]): PlanTaskDraft[] {
  const seen = new Set<string>();
  const result: PlanTaskDraft[] = [];

  for (const draft of drafts) {
    const key = `${draft.title}::${draft.writeScope.join('|')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(draft);
  }

  return result;
}

async function executeTask(
  task: TaskRecord,
  baseWorkspace: PreparedWorkspace,
  run: RunRecord,
  figmaData: string | null,
  projectMemory: string | null,
  policy: AutonomousRunPolicy,
  signal: AbortSignal | undefined,
  dependencyContext: string,
  options?: { inClosingWindow?: boolean; remainingMs?: number },
  onProgress?: (message: string) => Promise<void>,
): Promise<ExecutedTaskResult> {
  const taskWorktree = await createTaskWorktree(baseWorkspace, run.id, task.id, run.branchName);
  unityStore.updateTask(task.id, {
    status: 'running',
    attempts: task.attempts + 1,
    branchName: taskWorktree.branchName,
    worktreePath: taskWorktree.worktreePath,
    startedAt: nowIso(),
  });

  try {
    const baselineStaticGates = await runStaticGates(taskWorktree.workspace, policy, task.writeScope);
    const projectTree = getProjectTree(taskWorktree.workspace.repoPath);
    const execution = await generateAndWriteCode({
      repoPath: taskWorktree.workspace.repoPath,
      userPrompt: buildScopedTaskPrompt(task, run.prompt, dependencyContext, options),
      figmaData,
      projectTree,
      projectMemory,
      currentDiff: null,
      signal,
      onStatusUpdate: (status, thought) => {
        if (!onProgress) return;
        return onProgress(`🧩 [${task.title}] ${status}${thought ? `\n> ${thought}` : ''}`);
      },
    });

    const commitSha = await commitAllChanges(
      taskWorktree.workspace.repoPath,
      execution.commitMessage || `chore: ${task.title.toLowerCase()}`,
    );

    const diff = commitSha ? await getDiffAgainstHead(taskWorktree.workspace.repoPath) : '';
    const outOfScopePaths = getOutOfScopePaths(taskWorktree.workspace, diff, task.writeScope);
    const scopeGateResults: GateResult[] = outOfScopePaths.length
      ? [
          {
            name: 'scope',
            status: 'failed',
            details: `Task touched files outside its allowed scope: ${outOfScopePaths.join(', ')}`,
          },
        ]
      : [
          {
            name: 'scope',
            status: 'passed',
            details: `Task stayed inside scope: ${normalizeScopes(task.writeScope).join(', ')}`,
          },
        ];
    const currentScopedGates = await runStaticGates(taskWorktree.workspace, policy, task.writeScope);
    const newScopedFailures = getNewFailedGates(baselineStaticGates, currentScopedGates);
    const baselineDeltaGate: GateResult = {
      name: 'baseline-delta',
      status: newScopedFailures.length > 0 ? 'failed' : 'passed',
      details: newScopedFailures.length
        ? `Task introduced new scoped gate failures: ${newScopedFailures.map((gate) => gate.name).join(', ')}`
        : 'No new scoped gate failures compared with the baseline.',
    };
    const staticGates = [
      ...scopeGateResults,
      baselineDeltaGate,
      ...currentScopedGates,
    ];
    const review = await reviewTaskResult({
      runPrompt: run.prompt,
      taskTitle: task.title,
      diff,
      gateResults: staticGates,
    });

    const validationSummary = `${summarizeGateResults(staticGates)}\n\nReviewer: ${review.summary}`;
    const hasFailedGate = scopeGateResults.some((gate) => gate.status === 'failed') || baselineDeltaGate.status === 'failed';
    const status: TaskExecutionOutcome['status'] =
      !commitSha ? 'skipped' : hasFailedGate || !review.approved ? 'failed' : 'succeeded';

    return {
      task,
      diff,
      review,
      targetRoute: execution.targetRoute,
      outcome: {
        taskId: task.id,
        status,
        commitSha: commitSha || undefined,
        commitMessage: execution.commitMessage,
        outputSummary: review.summary,
        validationSummary,
        gates: staticGates,
        targetRoute: execution.targetRoute,
        tokenUsage: execution.tokenUsage,
      },
    };
  } finally {
    await removeTaskWorktree(baseWorkspace.repoPath, taskWorktree.worktreePath);
  }
}

async function integrateTaskResult(
  baseWorkspace: PreparedWorkspace,
  run: RunRecord,
  executedTask: ExecutedTaskResult,
): Promise<void> {
  if (!executedTask.outcome.commitSha) {
    return;
  }

  await checkoutBranch(baseWorkspace.repoPath, run.branchName);
  await cherryPickCommit(baseWorkspace.repoPath, executedTask.outcome.commitSha);
  await pushBranch(baseWorkspace.repoPath, run.branchName);
}

function createImprovementTasks(
  runId: string,
  cycle: number,
  drafts: PlanTaskDraft[],
  startIndex: number,
): TaskRecord[] {
  return drafts.map((draft, index) => {
    const timestamp = nowIso();

    return {
      id: createEntityId('task'),
      runId,
      parentTaskId: null,
      title: `[Improvement ${cycle}] ${draft.title}`,
      prompt: draft.prompt,
      role: 'executor',
      kind: draft.kind || 'improve',
      status: 'pending',
      writeScope: draft.writeScope,
      dependencies: [],
      attempts: 0,
      branchName: null,
      worktreePath: null,
      commitSha: null,
      commitMessage: null,
      outputSummary: draft.rationale || null,
      validationSummary: null,
      orderIndex: startIndex + index,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      finishedAt: null,
    };
  });
}

function selectRunnableBatch(tasks: TaskRecord[], maxParallelTasks: number): TaskRecord[] {
  const orderedTasks = [...tasks].sort((left, right) => {
    const advisoryDelta = Number(isAdvisoryTaskTitle(left.title)) - Number(isAdvisoryTaskTitle(right.title));
    if (advisoryDelta !== 0) {
      return advisoryDelta;
    }

    return left.orderIndex - right.orderIndex;
  });
  const running: TaskRecord[] = [];

  for (const task of orderedTasks) {
    const conflicts = running.some((candidate) => hasScopeConflict(candidate.writeScope, task.writeScope));
    if (conflicts) continue;

    running.push(task);
    if (running.length >= maxParallelTasks) break;
  }

  return running;
}

function formatRunSummary(
  run: RunRecord,
  tasks: TaskRecord[],
  commitsCreated: number,
  baselineStaticResults: GateResult[],
  staticResults: GateResult[],
  runtimeResults: GateResult[],
): string {
  const successfulTasks = tasks.filter((task) => task.status === 'succeeded').length;
  const failedTasks = tasks.filter((task) => task.status === 'failed').length;
  const blockedTasks = tasks.filter((task) => task.status === 'blocked').length;
  const newStaticFailures = getNewFailedGates(baselineStaticResults, staticResults);
  const runtimeFailed = runtimeResults.some((gate) => gate.status === 'failed');

  return [
    `Run ${run.id} finished on branch ${run.branchName}.`,
    `Successful tasks: ${successfulTasks}.`,
    `Failed tasks: ${failedTasks}.`,
    `Blocked tasks: ${blockedTasks}.`,
    `Commits created: ${commitsCreated}.`,
    `Final static gates introduced new failures: ${newStaticFailures.length > 0 ? 'yes' : 'no'}.`,
    `Runtime gate failed: ${runtimeFailed ? 'yes' : 'no'}.`,
    baselineStaticResults.length
      ? `Baseline static gates:\n${summarizeGateResults(baselineStaticResults)}`
      : 'Baseline static gates were not executed.',
    staticResults.length ? `Final static gates:\n${summarizeGateResults(staticResults)}` : 'Final static gates were not executed.',
    runtimeResults.length ? `Runtime gates:\n${summarizeGateResults(runtimeResults)}` : 'Runtime gates were not executed.',
  ].join('\n');
}

function shouldAutoApprovePlan(mode: RunMode, policy: AutonomousRunPolicy): boolean {
  return mode === 'nightly' && policy.autoApprovePlan;
}

function loadBaselineStaticResults(runId: string): GateResult[] {
  const baselineArtifact = unityStore
    .listArtifactsByRun(runId)
    .find((artifact) => artifact.type === 'baseline-static-gates');

  if (!baselineArtifact?.content) {
    return [];
  }

  try {
    return JSON.parse(baselineArtifact.content) as GateResult[];
  } catch {
    return [];
  }
}

async function executeApprovedRun(
  run: RunRecord,
  project: WorkspaceProject,
  plan: RunPlanDraft,
  policy: AutonomousRunPolicy,
  baseWorkspace: PreparedWorkspace,
  baselineStaticResults: GateResult[],
  signal?: AbortSignal,
  onProgress?: (message: string) => Promise<void>,
): Promise<RunAutonomousAgentResult> {
  const figmaData = await getFigmaContext(run.prompt);
  const projectMemory = getProjectMemory(baseWorkspace.repoPath);
  const existingTasks = unityStore.listTasksByRun(run.id);

  if (existingTasks.length === 0) {
    const initialTasks = createTasksFromPlan(run.id, plan);
    for (const task of initialTasks) {
      unityStore.createTask(task);
    }
  }

  const deadline = Date.now() + policy.maxHours * 60 * 60 * 1000;
  let closingWindowAnnounced = false;
  let gracefulDrainRequested = false;
  let commitsCreated = 0;
  let improvementCycle = 0;
  let pendingImprovementDrafts: PlanTaskDraft[] = [];
  let latestTargetRoute = '/';

  while (commitsCreated < policy.maxCommits) {
    if (signal?.aborted) {
      throw new Error('AbortError');
    }

    const budgetState = getRunBudgetState(deadline);

    if (budgetState.inClosingWindow && !closingWindowAnnounced) {
      closingWindowAnnounced = true;
      gracefulDrainRequested = true;

      unityStore.addEvent(
        createEntityId('event'),
        run.id,
        null,
        'warning',
        'run.closing_window',
        `Run entered closing window with about ${formatRemainingTime(budgetState.remainingMs)} remaining.`,
      );

      if (onProgress) {
        await onProgress(
          `⏳ Unity Agent entered its final closing window with about ${formatRemainingTime(
            budgetState.remainingMs,
          )} remaining. It will stop opening new improvement cycles and focus on wrapping up cleanly.`,
        );
      }
    }

    if (budgetState.exhausted) {
      break;
    }

    const allTasks = unityStore.listTasksByRun(run.id);
    const succeededTaskIds = new Set(
      allTasks.filter((task) => task.status === 'succeeded' || task.status === 'skipped').map((task) => task.id),
    );

    const readyTasks = allTasks.filter(
      (task) =>
        task.status === 'pending' && task.dependencies.every((dependencyId) => succeededTaskIds.has(dependencyId)),
    );

    if (readyTasks.length === 0) {
      const unresolvedTasks = allTasks.some((task) => task.status === 'pending' || task.status === 'running');
      if (unresolvedTasks) {
        for (const task of allTasks.filter((candidate) => candidate.status === 'pending')) {
          unityStore.updateTask(task.id, {
            status: 'blocked',
            validationSummary: buildDependencyBlockReason(task, allTasks),
            finishedAt: nowIso(),
          });
        }
        break;
      }

      if (
        pendingImprovementDrafts.length > 0 &&
        !gracefulDrainRequested &&
        improvementCycle < policy.maxImprovementCycles &&
        commitsCreated < policy.maxCommits
      ) {
        improvementCycle += 1;
        unityStore.updateRun(run.id, { status: 'healing' });
        const tasksToCreate = createImprovementTasks(
          run.id,
          improvementCycle,
          dedupeFollowUpTasks(pendingImprovementDrafts),
          allTasks.length,
        );
        pendingImprovementDrafts = [];

        for (const task of tasksToCreate) {
          unityStore.createTask(task);
        }

        if (onProgress) {
          await onProgress(`♻️ Starting self-improvement cycle ${improvementCycle} with ${tasksToCreate.length} tasks.`);
        }

        continue;
      }

      break;
    }

    const batch = selectRunnableBatch(readyTasks, policy.maxParallelTasks);
    if (onProgress) {
      await onProgress(`🧠 Scheduling ${batch.length} task(s) in parallel.`);
    }

    const results = await Promise.all(
      batch.map((task) =>
        executeTask(
          task,
          baseWorkspace,
          run,
          figmaData,
          projectMemory,
          policy,
          signal,
          buildDependencyContext(task, allTasks),
          {
            inClosingWindow: budgetState.inClosingWindow,
            remainingMs: budgetState.remainingMs,
          },
          onProgress,
        ),
      ),
    );

    for (const result of results) {
      const task = unityStore.getTask(result.task.id) || result.task;

      if (result.outcome.status === 'succeeded') {
        try {
          await integrateTaskResult(baseWorkspace, run, result);
          commitsCreated += result.outcome.commitSha ? 1 : 0;
          latestTargetRoute = result.targetRoute || latestTargetRoute;
          unityStore.updateTask(task.id, {
            status: 'succeeded',
            commitSha: result.outcome.commitSha || null,
            commitMessage: result.outcome.commitMessage || null,
            outputSummary: result.outcome.outputSummary || null,
            validationSummary: result.outcome.validationSummary || null,
            finishedAt: nowIso(),
          });
          unityStore.addArtifact(
            createEntityId('artifact'),
            run.id,
            task.id,
            'diff',
            result.diff,
            null,
            { taskTitle: task.title },
          );
          unityStore.addEvent(
            createEntityId('event'),
            run.id,
            task.id,
            'info',
            'task.integrated',
            `Task integrated into ${run.branchName}.`,
            {
              commitSha: result.outcome.commitSha,
              commitMessage: result.outcome.commitMessage,
            },
          );

          if (!gracefulDrainRequested) {
            pendingImprovementDrafts.push(...result.review.followUpTasks);
          }
        } catch (error: any) {
          const validationSummary = `Integration failed: ${error.message || String(error)}`;
          if (task.attempts < policy.maxRetriesPerTask && !gracefulDrainRequested) {
            unityStore.updateTask(task.id, {
              status: 'pending',
              prompt: buildRetryPrompt(task, validationSummary),
              validationSummary,
            });
            unityStore.addEvent(
              createEntityId('event'),
              run.id,
              task.id,
              'warning',
              'task.retry.integration',
              validationSummary,
            );
          } else {
            unityStore.updateTask(task.id, {
              status: 'failed',
              validationSummary,
              finishedAt: nowIso(),
            });
            unityStore.addEvent(
              createEntityId('event'),
              run.id,
              task.id,
              'error',
              'task.failed.integration',
              validationSummary,
            );
          }
        }

        continue;
      }

      const validationSummary = result.outcome.validationSummary || 'Task failed validation.';
      if (task.attempts < policy.maxRetriesPerTask && !gracefulDrainRequested) {
        unityStore.updateTask(task.id, {
          status: 'pending',
          prompt: buildRetryPrompt(task, validationSummary),
          validationSummary,
        });
        unityStore.addEvent(
          createEntityId('event'),
          run.id,
          task.id,
          'warning',
          'task.retry.validation',
          validationSummary,
        );
      } else {
        unityStore.updateTask(task.id, {
          status: result.outcome.status,
          commitSha: result.outcome.commitSha || null,
          commitMessage: result.outcome.commitMessage || null,
          outputSummary: result.outcome.outputSummary || null,
          validationSummary,
          finishedAt: nowIso(),
        });
        unityStore.addEvent(
          createEntityId('event'),
          run.id,
          task.id,
          'error',
          'task.failed.validation',
          validationSummary,
        );
      }
    }

    if (gracefulDrainRequested) {
      break;
    }
  }

  if (getRunBudgetState(deadline).exhausted || commitsCreated >= policy.maxCommits || gracefulDrainRequested) {
    const blockingReason =
      getRunBudgetState(deadline).exhausted
        ? `Run reached the max execution window of ${policy.maxHours} hour(s).`
        : gracefulDrainRequested
          ? `Run entered the final closing window and stopped scheduling new work to finish cleanly.`
          : `Run reached the max commit budget of ${policy.maxCommits}.`;

    for (const task of unityStore.listTasksByRun(run.id).filter((candidate) => candidate.status === 'pending')) {
      unityStore.updateTask(task.id, {
        status: 'blocked',
        validationSummary: blockingReason,
        finishedAt: nowIso(),
      });
    }

    unityStore.addEvent(
      createEntityId('event'),
      run.id,
      null,
      'warning',
      'run.budget_exhausted',
      blockingReason,
    );
  }

  await checkoutBranch(baseWorkspace.repoPath, run.branchName);
  const finalStaticResults = await runStaticGates(baseWorkspace, policy);
  unityStore.addArtifact(
    createEntityId('artifact'),
    run.id,
    null,
    'final-static-gates',
    JSON.stringify(finalStaticResults, null, 2),
    null,
  );
  const runtimeResults = await runRuntimeGate(baseWorkspace, policy, latestTargetRoute);
  unityStore.addArtifact(
    createEntityId('artifact'),
    run.id,
    null,
    'runtime-gates',
    JSON.stringify(runtimeResults, null, 2),
    null,
  );
  const tasks = unityStore.listTasksByRun(run.id);
  const successfulTasks = tasks.filter((task) => task.status === 'succeeded' || task.status === 'skipped');
  const failedTasks = tasks.filter((task) => task.status === 'failed');
  const blockedTasks = tasks.filter((task) => task.status === 'blocked');
  const hasFailedStaticGate = getNewFailedGates(baselineStaticResults, finalStaticResults).length > 0;
  const hasFailedRuntimeGate = runtimeResults.some((gate) => gate.status === 'failed');
  const summary = formatRunSummary(
    run,
    tasks,
    commitsCreated,
    baselineStaticResults,
    finalStaticResults,
    runtimeResults,
  );
  const runtimeUrlDetails = runtimeResults.find((gate) => gate.name === 'runtime:url')?.details || '';
  const localUrlMatch = runtimeUrlDetails.match(/Local:\s+([^|]+)/);
  const publicUrlMatch = runtimeUrlDetails.match(/Public:\s+(.+)$/);
  unityStore.upsertMemory(
    createEntityId('memory'),
    project.name,
    'continuous_improvement',
    `run:${run.id}:summary`,
    summary,
    {
      commitsCreated,
      successfulTasks: successfulTasks.length,
      failedTasks: failedTasks.length,
      blockedTasks: blockedTasks.length,
    },
  );

  unityStore.updateRun(run.id, {
    status:
      failedTasks.length === 0 && blockedTasks.length === 0 && !hasFailedStaticGate && !hasFailedRuntimeGate
        ? 'completed'
        : 'failed',
    finishedAt: nowIso(),
    summary,
  });

  unityStore.addEvent(
    createEntityId('event'),
    run.id,
    null,
    failedTasks.length === 0 && !hasFailedStaticGate && !hasFailedRuntimeGate ? 'info' : 'warning',
    'run.completed',
    summary,
  );

  return {
    runId: run.id,
    branchName: run.branchName,
    defaultBranch: run.defaultBranch,
    summary,
    commitsCreated,
    runtimeUrls: {
      localUrl: localUrlMatch ? localUrlMatch[1].trim() : null,
      publicUrl: publicUrlMatch ? publicUrlMatch[1].trim() : null,
    },
    tasks: tasks.map((task) => ({
      title: task.title,
      status: task.status,
      commitMessage: task.commitMessage,
    })),
  };
}

export async function createAutonomousRunPlan({
  project,
  prompt,
  channelName,
  mode = 'interactive',
  signal,
  onProgress,
}: RunAutonomousAgentParams): Promise<CreateAutonomousRunPlanResult> {
  const policy = getProjectPolicy(unityStore, project.name);
  unityStore.upsertPolicy(project.name, policy);

  const baseWorkspace = await prepareWorkspace(project);
  const branchState = await ensureIntegrationBranch(baseWorkspace, policy.integrationBranchName);
  const baselineStaticResults = await runStaticGates(baseWorkspace, policy);
  const runId = createEntityId('run');
  const run = buildRunRecord(
    runId,
    project.name,
    channelName,
    prompt,
    policy,
    branchState.integrationBranch,
    branchState.defaultBranch,
    mode,
  );

  unityStore.createRun(run);
  unityStore.addEvent(createEntityId('event'), run.id, null, 'info', 'run.created', 'Autonomous run created.', {
    project: project.name,
    branch: branchState.integrationBranch,
    branchCreated: branchState.created,
    mode,
  });
  unityStore.addArtifact(
    createEntityId('artifact'),
    run.id,
    null,
    'baseline-static-gates',
    JSON.stringify(baselineStaticResults, null, 2),
    null,
  );

  if (onProgress) {
    await onProgress(
      `🤖 Autonomous run \`${run.id}\` started on \`${branchState.integrationBranch}\`${branchState.created ? ' (branch created upstream)' : ''}.`,
    );
  }

  const projectTree = getProjectTree(baseWorkspace.repoPath);
  const projectMemory = getProjectMemory(baseWorkspace.repoPath);
  unityStore.upsertMemory(createEntityId('memory'), project.name, 'run_context', run.id, prompt, {
    channelName,
    mode,
  });

  if (projectMemory) {
    unityStore.upsertMemory(
      createEntityId('memory'),
      project.name,
      'stable_repo',
      'project_memory',
      projectMemory,
    );
  }

  if (signal?.aborted) {
    throw new Error('AbortError');
  }

  const plan = await planAutonomousRun({
    prompt,
    projectTree,
    projectMemory,
  });

  const autoApproved = shouldAutoApprovePlan(mode, policy);
  const timestamp = nowIso();
  const planId = createEntityId('plan');

  unityStore.createPlan(planId, run.id, plan.summary, plan, {
    status: autoApproved ? 'approved' : 'proposed',
    version: 1,
    approvedAt: autoApproved ? timestamp : null,
    approvedBy: autoApproved ? 'policy:auto' : null,
  });
  unityStore.addArtifact(createEntityId('artifact'), run.id, null, 'plan', JSON.stringify(plan, null, 2), null);
  unityStore.updateRun(run.id, {
    status: autoApproved ? 'running' : 'awaiting_plan_approval',
  });
  unityStore.addEvent(
    createEntityId('event'),
    run.id,
    null,
    'info',
    autoApproved ? 'plan.auto_approved' : 'plan.created',
    autoApproved
      ? `Plan auto-approved by policy.`
      : `Plan created and awaiting approval in the local console.`,
    {
      planId,
      summary: plan.summary,
    },
  );

  if (onProgress) {
    await onProgress(
      autoApproved
        ? `🗺️ Plan ready and auto-approved: ${plan.summary}`
        : `🗺️ Plan ready: ${plan.summary}`,
    );
  }

  return {
    runId: run.id,
    branchName: run.branchName,
    defaultBranch: run.defaultBranch,
    planSummary: plan.summary,
    consoleUrl: buildConsoleRunUrl(run.id),
    requiresApproval: !autoApproved,
    autoApproved,
    tasks: plan.tasks.map((task) => ({
      title: task.title,
      writeScope: task.writeScope,
      dependencies: task.dependencies || [],
    })),
  };
}

export function approveAutonomousRunPlan(runId: string, approvedBy = 'local-ui'): void {
  const run = unityStore.getRun(runId);
  if (!run) {
    throw new Error(`Run ${runId} was not found.`);
  }

  const plan = unityStore.getLatestPlanByRun(runId);
  if (!plan) {
    throw new Error(`Run ${runId} has no persisted plan.`);
  }

  if (plan.status === 'approved') {
    return;
  }

  if (plan.status === 'rejected') {
    throw new Error(`Run ${runId} has a rejected plan and cannot be approved without replanning.`);
  }

  const timestamp = nowIso();
  unityStore.updatePlan(plan.id, {
    status: 'approved',
    approvedAt: timestamp,
    approvedBy,
    rejectedAt: null,
    rejectedBy: null,
    rejectedReason: null,
  });
  unityStore.updateRun(run.id, {
    status: 'running',
    finishedAt: null,
  });
  unityStore.addEvent(
    createEntityId('event'),
    run.id,
    null,
    'info',
    'plan.approved',
    `Plan approved by ${approvedBy}.`,
  );
}

export function rejectAutonomousRunPlan(
  runId: string,
  rejectedBy = 'local-ui',
  rejectedReason = 'Plan rejected from the local console.',
): void {
  const run = unityStore.getRun(runId);
  if (!run) {
    throw new Error(`Run ${runId} was not found.`);
  }

  const plan = unityStore.getLatestPlanByRun(runId);
  if (!plan) {
    throw new Error(`Run ${runId} has no persisted plan.`);
  }

  if (plan.status === 'approved' || run.status === 'running' || run.status === 'healing' || run.status === 'completed') {
    throw new Error(`Run ${runId} has already moved past the approval stage.`);
  }

  const timestamp = nowIso();
  unityStore.updatePlan(plan.id, {
    status: 'rejected',
    rejectedAt: timestamp,
    rejectedBy,
    rejectedReason,
  });
  unityStore.updateRun(run.id, {
    status: 'plan_rejected',
    finishedAt: timestamp,
    summary: rejectedReason,
  });
  unityStore.addEvent(
    createEntityId('event'),
    run.id,
    null,
    'warning',
    'plan.rejected',
    rejectedReason,
    {
      rejectedBy,
    },
  );
}

export async function resumeAutonomousRun({
  runId,
  signal,
  onProgress,
}: ResumeAutonomousRunParams): Promise<RunAutonomousAgentResult> {
  const run = unityStore.getRun(runId);
  if (!run) {
    throw new Error(`Run ${runId} was not found.`);
  }

  const planRecord = unityStore.getLatestPlanByRun(runId);
  if (!planRecord) {
    throw new Error(`Run ${runId} has no persisted plan.`);
  }

  if (planRecord.status !== 'approved') {
    throw new Error(`Run ${runId} is not approved yet.`);
  }

  const project = getProjectByName(run.projectName);
  const policy = getProjectPolicy(unityStore, project.name);
  unityStore.upsertPolicy(project.name, policy);

  const baseWorkspace = await prepareWorkspace(project);
  await ensureIntegrationBranch(baseWorkspace, run.branchName);
  let baselineStaticResults = loadBaselineStaticResults(runId);
  if (baselineStaticResults.length === 0) {
    baselineStaticResults = await runStaticGates(baseWorkspace, policy);
    unityStore.addArtifact(
      createEntityId('artifact'),
      run.id,
      null,
      'baseline-static-gates',
      JSON.stringify(baselineStaticResults, null, 2),
      null,
    );
  }

  unityStore.updateRun(run.id, {
    status: 'running',
    finishedAt: null,
  });
  unityStore.addEvent(
    createEntityId('event'),
    run.id,
    null,
    'info',
    'run.resumed',
    'Run resumed after plan approval.',
  );

  if (onProgress) {
    await onProgress(`🚀 Resuming run \`${run.id}\` on \`${run.branchName}\`.`);
  }

  return executeApprovedRun(
    unityStore.getRun(run.id) || run,
    project,
    planRecord.rawPlan,
    policy,
    baseWorkspace,
    baselineStaticResults,
    signal,
    onProgress,
  );
}

export async function runAutonomousAgent(
  params: RunAutonomousAgentParams,
): Promise<RunAutonomousAgentResult> {
  const planned = await createAutonomousRunPlan(params);

  if (planned.requiresApproval) {
    throw new Error(
      `Run ${planned.runId} is waiting for plan approval. Use createAutonomousRunPlan + resumeAutonomousRun for interactive flows.`,
    );
  }

  return resumeAutonomousRun({
    runId: planned.runId,
    signal: params.signal,
    onProgress: params.onProgress,
  });
}
