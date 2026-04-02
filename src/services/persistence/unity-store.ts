import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../../config.js';
import type {
  ArtifactRecord,
  MemoryLayer,
  PlanRecord,
  PlanStatus,
  RunRecord,
  RunEventRecord,
  RunStatus,
  TaskRecord,
  TaskStatus,
} from '../../domain/orchestration.js';
import type { AutonomousRunPolicy, NightJobConfig } from '../../domain/policies.js';

type SqlValue = string | number | null;

function nowIso(): string {
  return new Date().toISOString();
}

function toSqliteValue(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  return JSON.stringify(value);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.trim() === '') {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapRun(row: Record<string, unknown>): RunRecord {
  return {
    id: String(row.id),
    projectName: String(row.project_name),
    channelName: String(row.channel_name),
    prompt: String(row.prompt),
    status: String(row.status) as RunStatus,
    mode: String(row.mode) as RunRecord['mode'],
    branchName: String(row.branch_name),
    defaultBranch: String(row.default_branch),
    maxParallelTasks: Number(row.max_parallel_tasks),
    maxRetriesPerTask: Number(row.max_retries_per_task),
    maxImprovementCycles: Number(row.max_improvement_cycles),
    maxHours: Number(row.max_hours),
    maxCommits: Number(row.max_commits),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: (row.started_at as string | null) || null,
    finishedAt: (row.finished_at as string | null) || null,
    summary: (row.summary as string | null) || null,
  };
}

function mapTask(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    parentTaskId: (row.parent_task_id as string | null) || null,
    title: String(row.title),
    prompt: String(row.prompt),
    role: String(row.role) as TaskRecord['role'],
    kind: String(row.kind) as TaskRecord['kind'],
    status: String(row.status) as TaskStatus,
    writeScope: parseJson<string[]>(row.write_scope, []),
    dependencies: parseJson<string[]>(row.dependencies, []),
    attempts: Number(row.attempts),
    branchName: (row.branch_name as string | null) || null,
    worktreePath: (row.worktree_path as string | null) || null,
    commitSha: (row.commit_sha as string | null) || null,
    commitMessage: (row.commit_message as string | null) || null,
    outputSummary: (row.output_summary as string | null) || null,
    validationSummary: (row.validation_summary as string | null) || null,
    orderIndex: Number(row.order_index),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: (row.started_at as string | null) || null,
    finishedAt: (row.finished_at as string | null) || null,
  };
}

function mapPlan(row: Record<string, unknown>): PlanRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    summary: String(row.summary),
    rawPlan: parseJson(row.raw_plan, { summary: '', tasks: [] }),
    status: String(row.status) as PlanStatus,
    version: Number(row.version),
    createdAt: String(row.created_at),
    approvedAt: (row.approved_at as string | null) || null,
    approvedBy: (row.approved_by as string | null) || null,
    rejectedAt: (row.rejected_at as string | null) || null,
    rejectedBy: (row.rejected_by as string | null) || null,
    rejectedReason: (row.rejected_reason as string | null) || null,
  };
}

function mapEvent(row: Record<string, unknown>): RunEventRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    taskId: (row.task_id as string | null) || null,
    level: String(row.level) as RunEventRecord['level'],
    type: String(row.type),
    message: String(row.message),
    payload: row.payload ? parseJson(row.payload, null) : null,
    createdAt: String(row.created_at),
  };
}

function mapArtifact(row: Record<string, unknown>): ArtifactRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    taskId: (row.task_id as string | null) || null,
    type: String(row.type),
    path: (row.path as string | null) || null,
    content: (row.content as string | null) || null,
    metadata: row.metadata ? parseJson(row.metadata, null) : null,
    createdAt: String(row.created_at),
  };
}

export class UnityStore {
  private readonly db: DatabaseSync;

  constructor(dbPath = path.join(DATA_DIR, 'unity-agent.sqlite')) {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        project_name TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        max_parallel_tasks INTEGER NOT NULL,
        max_retries_per_task INTEGER NOT NULL,
        max_improvement_cycles INTEGER NOT NULL,
        max_hours INTEGER NOT NULL,
        max_commits INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        summary TEXT
      );

      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        raw_plan TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed',
        version INTEGER NOT NULL DEFAULT 1,
        approved_at TEXT,
        approved_by TEXT,
        rejected_at TEXT,
        rejected_by TEXT,
        rejected_reason TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        parent_task_id TEXT,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        write_scope TEXT NOT NULL,
        dependencies TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        branch_name TEXT,
        worktree_path TEXT,
        commit_sha TEXT,
        commit_message TEXT,
        output_summary TEXT,
        validation_summary TEXT,
        order_index INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT,
        level TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        payload TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT,
        type TEXT NOT NULL,
        path TEXT,
        content TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        project_name TEXT NOT NULL,
        layer TEXT NOT NULL,
        memory_key TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS memories_project_layer_key
      ON memories(project_name, layer, memory_key);

      CREATE TABLE IF NOT EXISTS policies (
        project_name TEXT PRIMARY KEY,
        config TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS night_jobs (
        id TEXT PRIMARY KEY,
        project_name TEXT NOT NULL,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        config TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
    `);

    this.ensureColumn('plans', 'status', `ALTER TABLE plans ADD COLUMN status TEXT NOT NULL DEFAULT 'proposed'`);
    this.ensureColumn('plans', 'version', `ALTER TABLE plans ADD COLUMN version INTEGER NOT NULL DEFAULT 1`);
    this.ensureColumn('plans', 'approved_at', `ALTER TABLE plans ADD COLUMN approved_at TEXT`);
    this.ensureColumn('plans', 'approved_by', `ALTER TABLE plans ADD COLUMN approved_by TEXT`);
    this.ensureColumn('plans', 'rejected_at', `ALTER TABLE plans ADD COLUMN rejected_at TEXT`);
    this.ensureColumn('plans', 'rejected_by', `ALTER TABLE plans ADD COLUMN rejected_by TEXT`);
    this.ensureColumn('plans', 'rejected_reason', `ALTER TABLE plans ADD COLUMN rejected_reason TEXT`);
  }

  private ensureColumn(tableName: string, columnName: string, sql: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;

    if (columns.some((column) => column.name === columnName)) {
      return;
    }

    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }

  createRun(run: RunRecord): void {
    this.db
      .prepare(`
        INSERT INTO runs (
          id, project_name, channel_name, prompt, status, mode, branch_name, default_branch,
          max_parallel_tasks, max_retries_per_task, max_improvement_cycles, max_hours, max_commits,
          created_at, updated_at, started_at, finished_at, summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        run.id,
        run.projectName,
        run.channelName,
        run.prompt,
        run.status,
        run.mode,
        run.branchName,
        run.defaultBranch,
        run.maxParallelTasks,
        run.maxRetriesPerTask,
        run.maxImprovementCycles,
        run.maxHours,
        run.maxCommits,
        run.createdAt,
        run.updatedAt,
        run.startedAt || null,
        run.finishedAt || null,
        run.summary || null,
      );
  }

  updateRun(id: string, patch: Partial<RunRecord>): void {
    const entries = Object.entries({
      project_name: patch.projectName,
      channel_name: patch.channelName,
      prompt: patch.prompt,
      status: patch.status,
      mode: patch.mode,
      branch_name: patch.branchName,
      default_branch: patch.defaultBranch,
      max_parallel_tasks: patch.maxParallelTasks,
      max_retries_per_task: patch.maxRetriesPerTask,
      max_improvement_cycles: patch.maxImprovementCycles,
      max_hours: patch.maxHours,
      max_commits: patch.maxCommits,
      started_at: patch.startedAt,
      finished_at: patch.finishedAt,
      summary: patch.summary,
      updated_at: nowIso(),
    }).filter(([, value]) => value !== undefined);

    if (entries.length === 0) return;

    const sql = `UPDATE runs SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...entries.map(([, value]) => toSqliteValue(value)), id);
  }

  getRun(id: string): RunRecord | null {
    const row = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? mapRun(row) : null;
  }

  listRuns(limit = 50): RunRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];

    return rows.map(mapRun);
  }

  createPlan(
    planId: string,
    runId: string,
    summary: string,
    rawPlan: unknown,
    options?: {
      status?: PlanStatus;
      version?: number;
      approvedAt?: string | null;
      approvedBy?: string | null;
      rejectedAt?: string | null;
      rejectedBy?: string | null;
      rejectedReason?: string | null;
    },
  ): void {
    this.db
      .prepare(`
        INSERT INTO plans (
          id, run_id, summary, raw_plan, status, version, approved_at, approved_by,
          rejected_at, rejected_by, rejected_reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        planId,
        runId,
        summary,
        JSON.stringify(rawPlan),
        options?.status || 'proposed',
        options?.version || 1,
        options?.approvedAt || null,
        options?.approvedBy || null,
        options?.rejectedAt || null,
        options?.rejectedBy || null,
        options?.rejectedReason || null,
        nowIso(),
      );
  }

  updatePlan(id: string, patch: Partial<PlanRecord>): void {
    const entries = Object.entries({
      summary: patch.summary,
      raw_plan: patch.rawPlan ? JSON.stringify(patch.rawPlan) : undefined,
      status: patch.status,
      version: patch.version,
      approved_at: patch.approvedAt,
      approved_by: patch.approvedBy,
      rejected_at: patch.rejectedAt,
      rejected_by: patch.rejectedBy,
      rejected_reason: patch.rejectedReason,
    }).filter(([, value]) => value !== undefined);

    if (entries.length === 0) return;

    const sql = `UPDATE plans SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...entries.map(([, value]) => toSqliteValue(value)), id);
  }

  getPlan(id: string): PlanRecord | null {
    const row = this.db.prepare(`SELECT * FROM plans WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? mapPlan(row) : null;
  }

  getLatestPlanByRun(runId: string): PlanRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM plans WHERE run_id = ? ORDER BY version DESC, created_at DESC LIMIT 1`)
      .get(runId) as Record<string, unknown> | undefined;

    return row ? mapPlan(row) : null;
  }

  listPlansByRun(runId: string): PlanRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM plans WHERE run_id = ? ORDER BY version DESC, created_at DESC`)
      .all(runId) as Record<string, unknown>[];

    return rows.map(mapPlan);
  }

  createTask(task: TaskRecord): void {
    this.db
      .prepare(`
        INSERT INTO tasks (
          id, run_id, parent_task_id, title, prompt, role, kind, status, write_scope, dependencies,
          attempts, branch_name, worktree_path, commit_sha, commit_message, output_summary,
          validation_summary, order_index, created_at, updated_at, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        task.id,
        task.runId,
        task.parentTaskId || null,
        task.title,
        task.prompt,
        task.role,
        task.kind,
        task.status,
        JSON.stringify(task.writeScope),
        JSON.stringify(task.dependencies),
        task.attempts,
        task.branchName || null,
        task.worktreePath || null,
        task.commitSha || null,
        task.commitMessage || null,
        task.outputSummary || null,
        task.validationSummary || null,
        task.orderIndex,
        task.createdAt,
        task.updatedAt,
        task.startedAt || null,
        task.finishedAt || null,
      );
  }

  updateTask(id: string, patch: Partial<TaskRecord>): void {
    const entries = Object.entries({
      parent_task_id: patch.parentTaskId,
      title: patch.title,
      prompt: patch.prompt,
      role: patch.role,
      kind: patch.kind,
      status: patch.status,
      write_scope: patch.writeScope ? JSON.stringify(patch.writeScope) : undefined,
      dependencies: patch.dependencies ? JSON.stringify(patch.dependencies) : undefined,
      attempts: patch.attempts,
      branch_name: patch.branchName,
      worktree_path: patch.worktreePath,
      commit_sha: patch.commitSha,
      commit_message: patch.commitMessage,
      output_summary: patch.outputSummary,
      validation_summary: patch.validationSummary,
      order_index: patch.orderIndex,
      started_at: patch.startedAt,
      finished_at: patch.finishedAt,
      updated_at: nowIso(),
    }).filter(([, value]) => value !== undefined);

    if (entries.length === 0) return;

    const sql = `UPDATE tasks SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...entries.map(([, value]) => toSqliteValue(value)), id);
  }

  getTask(id: string): TaskRecord | null {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? mapTask(row) : null;
  }

  listTasksByRun(runId: string): TaskRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE run_id = ? ORDER BY order_index ASC, created_at ASC`)
      .all(runId) as Record<string, unknown>[];

    return rows.map(mapTask);
  }

  addEvent(
    eventId: string,
    runId: string,
    taskId: string | null,
    level: 'info' | 'warning' | 'error',
    type: string,
    message: string,
    payload?: unknown,
  ): void {
    this.db
      .prepare(`
        INSERT INTO events (id, run_id, task_id, level, type, message, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(eventId, runId, taskId, level, type, message, payload ? JSON.stringify(payload) : null, nowIso());
  }

  addArtifact(
    artifactId: string,
    runId: string,
    taskId: string | null,
    type: string,
    content: string | null,
    filePath: string | null,
    metadata?: unknown,
  ): void {
    this.db
      .prepare(`
        INSERT INTO artifacts (id, run_id, task_id, type, path, content, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        artifactId,
        runId,
        taskId,
        type,
        filePath,
        content,
        metadata ? JSON.stringify(metadata) : null,
        nowIso(),
      );
  }

  listEventsByRun(runId: string): RunEventRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE run_id = ? ORDER BY created_at ASC`)
      .all(runId) as Record<string, unknown>[];

    return rows.map(mapEvent);
  }

  listArtifactsByRun(runId: string): ArtifactRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC`)
      .all(runId) as Record<string, unknown>[];

    return rows.map(mapArtifact);
  }

  upsertPolicy(projectName: string, policy: AutonomousRunPolicy): void {
    this.db
      .prepare(`
        INSERT INTO policies (project_name, config, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(project_name) DO UPDATE SET
          config = excluded.config,
          updated_at = excluded.updated_at
      `)
      .run(projectName, JSON.stringify(policy), nowIso());
  }

  getPolicy(projectName: string): AutonomousRunPolicy | null {
    const row = this.db
      .prepare(`SELECT config FROM policies WHERE project_name = ?`)
      .get(projectName) as { config: string } | undefined;

    return row ? parseJson<AutonomousRunPolicy>(row.config, null as any) : null;
  }

  upsertMemory(
    memoryId: string,
    projectName: string,
    layer: MemoryLayer,
    key: string,
    content: string,
    metadata?: unknown,
  ): void {
    const existing = this.db
      .prepare(`
        SELECT id FROM memories
        WHERE project_name = ? AND layer = ? AND memory_key = ?
      `)
      .get(projectName, layer, key) as { id: string } | undefined;

    if (existing) {
      this.db
        .prepare(`
          UPDATE memories
          SET content = ?, metadata = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(content, metadata ? JSON.stringify(metadata) : null, nowIso(), existing.id);
      return;
    }

    this.db
      .prepare(`
        INSERT INTO memories (
          id, project_name, layer, memory_key, content, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(memoryId, projectName, layer, key, content, metadata ? JSON.stringify(metadata) : null, nowIso(), nowIso());
  }

  createNightJob(id: string, projectName: string, prompt: string, config: NightJobConfig): void {
    this.db
      .prepare(`
        INSERT INTO night_jobs (id, project_name, status, prompt, config, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(id, projectName, 'queued', prompt, JSON.stringify(config), nowIso(), nowIso());
  }
}
