import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { getRuntimeConfig } from '../../config.js';
import {
  approveAutonomousRunPlan,
  rejectAutonomousRunPlan,
  resumeAutonomousRun,
} from '../../application/run-autonomous-agent.js';
import { RuntimeState } from '../../runtime/state.js';
import { unityStore } from '../../runtime/services.js';
import { createEntityId } from '../../shared/ids.js';

type RunPayload = NonNullable<ReturnType<typeof buildRunPayload>>;

type UiTask = {
  id: string;
  runId: string;
  parentTaskId: string | null;
  title: string;
  prompt: string | null;
  role: string | null;
  kind: string | null;
  status: string;
  writeScope: string[];
  dependencies: string[];
  attempts: number;
  branchName: string | null;
  worktreePath: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  outputSummary: string | null;
  validationSummary: string | null;
  orderIndex: number;
  createdAt: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  planOnly?: boolean;
};

type UiArtifact = {
  taskId: string | null;
  type: string;
  path: string | null;
  content: string | null;
  createdAt: string | null;
};

type UiEvent = {
  taskId: string | null;
  type: string;
  level: string;
  message: string;
  payload: unknown;
  createdAt: string | null;
};

type UiRunViewModel = {
  run: RunPayload['run'];
  plan: RunPayload['plan'];
  tasks: UiTask[];
  artifacts: UiArtifact[];
  events: UiEvent[];
  selectedTaskId: string | null;
  counts: {
    total: number;
    pending: number;
    running: number;
    succeeded: number;
    failed: number;
    blocked: number;
    skipped: number;
    done: number;
    progress: number;
  };
  graph: {
    svgInner: string;
    viewBox: string;
    width: number;
    height: number;
    phasesCount: number;
  };
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/<\/script/gi, '<\\/script');
}

function safeText(value: unknown): string {
  return escapeHtml(String(value ?? ''));
}

function truncate(value: unknown, maxLength: number): string {
  const text = String(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-US');
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'completed':
    case 'succeeded':
      return '#4ade80'; // Emerald 400
    case 'completed_with_warnings':
      return '#f59e0b'; // Amber 500
    case 'awaiting_plan_approval':
    case 'pending':
      return '#facc15'; // Yellow 400
    case 'failed':
    case 'blocked':
    case 'plan_rejected':
      return '#f87171'; // Red 400
    case 'running':
    case 'healing':
    case 'planning':
      return '#60a5fa'; // Blue 400
    case 'cancelled':
    case 'skipped':
      return '#9ca3af'; // Gray 400
    default:
      return '#d1d5db'; // Gray 300
  }
}

function renderStatusBadgeHtml(status: string): string {
  const color = getStatusColor(status);
  return `<span class="status-badge" style="background:${color}15;color:${color};border:1px solid ${color}30;">${escapeHtml(
    status.replaceAll('_', ' '),
  )}</span>`;
}

function normalizeTasks(payload: RunPayload): UiTask[] {
  if (payload.tasks.length > 0) {
    return payload.tasks
      .slice()
      .sort((left, right) => left.orderIndex - right.orderIndex)
      .map((task) => ({
        ...task,
        parentTaskId: task.parentTaskId ?? null,
        prompt: task.prompt ?? null,
        role: task.role ?? null,
        kind: task.kind ?? null,
        writeScope: task.writeScope || ['.'],
        dependencies: task.dependencies || [],
        branchName: task.branchName ?? null,
        worktreePath: task.worktreePath ?? null,
        commitSha: task.commitSha ?? null,
        commitMessage: task.commitMessage ?? null,
        outputSummary: task.outputSummary ?? null,
        validationSummary: task.validationSummary ?? null,
        createdAt: task.createdAt ?? null,
        updatedAt: task.updatedAt ?? null,
        startedAt: task.startedAt ?? null,
        finishedAt: task.finishedAt ?? null,
      }));
  }

  const planTasks = payload.plan?.rawPlan?.tasks || [];
  const titleToId = new Map<string, string>();

  planTasks.forEach((task, index) => {
    titleToId.set(task.title, `draft-${index}`);
  });

  return planTasks.map((task, index) => ({
    id: titleToId.get(task.title) || `draft-${index}`,
    runId: payload.run.id,
    parentTaskId: null,
    title: task.title,
    prompt: task.prompt,
    role: task.role || 'executor',
    kind: task.kind || 'implement',
    status: payload.run.status === 'plan_rejected' ? 'blocked' : 'pending',
    writeScope: task.writeScope || ['.'],
    dependencies: (task.dependencies || []).map((dependency) => titleToId.get(dependency)).filter(Boolean) as string[],
    attempts: 0,
    branchName: null,
    worktreePath: null,
    commitSha: null,
    commitMessage: null,
    outputSummary: task.rationale || null,
    validationSummary: null,
    orderIndex: index,
    createdAt: payload.run.createdAt,
    updatedAt: payload.run.updatedAt,
    startedAt: null,
    finishedAt: null,
    planOnly: true,
  }));
}

function buildLevels(tasks: UiTask[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const memo = new Map<string, number>();

  function computeLevel(taskId: string, trail: Set<string>): number {
    if (memo.has(taskId)) {
      return memo.get(taskId) as number;
    }

    if (trail.has(taskId)) {
      return 0;
    }

    const task = byId.get(taskId);
    if (!task) {
      return 0;
    }

    trail.add(taskId);
    const dependencies = (task.dependencies || []).filter((dependencyId) => byId.has(dependencyId));
    const level = dependencies.length
      ? Math.max(...dependencies.map((dependencyId) => computeLevel(dependencyId, trail))) + 1
      : 0;
    trail.delete(taskId);
    memo.set(taskId, level);
    return level;
  }

  for (const task of tasks) {
    computeLevel(task.id, new Set());
  }

  const levels: UiTask[][] = [];
  for (const task of tasks) {
    const level = memo.get(task.id) || 0;
    if (!levels[level]) {
      levels[level] = [];
    }
    levels[level].push(task);
  }

  for (const column of levels) {
    column.sort((left, right) => left.orderIndex - right.orderIndex);
  }

  return levels.filter(Boolean);
}

function buildGraph(
  runId: string,
  tasks: UiTask[],
  selectedTaskId: string | null,
): UiRunViewModel['graph'] {
  if (tasks.length === 0) {
    return {
      width: 900,
      height: 420,
      viewBox: '0 0 900 420',
      phasesCount: 0,
      svgInner: `<text x="96" y="170" class="lane-label">No tasks yet</text><text x="96" y="202" class="lane-sub">The plan exists but no nodes were generated.</text>`,
    };
  }

  const levels = buildLevels(tasks);
  const nodeWidth = 280;
  const nodeHeight = 110;
  const columnGap = 120;
  const rowGap = 140;
  const marginX = 60;
  const marginY = 80;
  const positions = new Map<string, { x: number; y: number }>();
  let maxRows = 1;

  levels.forEach((column, columnIndex) => {
    maxRows = Math.max(maxRows, column.length);
    column.forEach((task, rowIndex) => {
      positions.set(task.id, {
        x: marginX + columnIndex * (nodeWidth + columnGap),
        y: marginY + rowIndex * rowGap,
      });
    });
  });

  const width =
    marginX * 2 + Math.max(1, levels.length) * nodeWidth + Math.max(0, levels.length - 1) * columnGap;
  const height = marginY + maxRows * rowGap + 90;

  const laneLabels = levels
    .map((column, index) => {
      const x = marginX + index * (nodeWidth + columnGap);
      return `<text x="${x}" y="36" class="lane-label">Phase ${index + 1}</text><text x="${x}" y="56" class="lane-sub">${column.length} node(s)</text>`;
    })
    .join('');

  const edges = tasks
    .flatMap((task) => {
      const target = positions.get(task.id);
      if (!target) return [];

      return (task.dependencies || []).map((dependencyId) => {
        const source = positions.get(dependencyId);
        if (!source) return '';
        const startX = source.x + nodeWidth;
        const startY = source.y + nodeHeight / 2;
        const endX = target.x;
        const endY = target.y + nodeHeight / 2;
        const curve = Math.max(40, (endX - startX) / 2);
        return `<path class="edge" stroke="#3f3f46" d="M ${startX} ${startY} C ${startX + curve} ${startY}, ${endX - curve} ${endY}, ${endX} ${endY}" />`;
      });
    })
    .join('');

  const nodes = tasks
    .map((task) => {
      const position = positions.get(task.id) as { x: number; y: number };
      const color = getStatusColor(task.status);
      const active = selectedTaskId === task.id;
      const stroke = active ? color : '#3f3f46';
      const glow = active ? `drop-shadow(0 0 10px ${color}40)` : 'none';
      const scopeLabel = escapeHtml(truncate((task.writeScope || ['.']).join(', '), 30));
      const summary = escapeHtml(truncate(task.outputSummary || task.validationSummary || task.prompt || '', 60));
      const taskHref = `/runs/${encodeURIComponent(runId)}?task=${encodeURIComponent(task.id)}`;

      return `<a href="${taskHref}">
        <g class="node-group${active ? ' active' : ''}" data-task-id="${escapeHtml(task.id)}" transform="translate(${position.x} ${position.y})" style="filter:${glow};">
          <rect class="node-card" x="0" y="0" rx="12" ry="12" width="${nodeWidth}" height="${nodeHeight}" fill="#18181b" stroke="${stroke}" />
          <rect x="16" y="16" rx="6" ry="6" width="68" height="24" fill="${color}15" stroke="${color}30" />
          <text x="26" y="32" class="node-subtitle" fill="${color}">${escapeHtml(task.status.toUpperCase())}</text>
          
          <circle cx="250" cy="28" r="4" fill="${color}" />
          
          <text x="16" y="64" class="node-title">${escapeHtml(truncate(task.title, 28))}</text>
          <text x="16" y="84" class="node-subtitle">scope · ${scopeLabel}</text>
          <text x="16" y="100" class="node-foot">${summary}</text>
        </g>
      </a>`;
    })
    .join('');

  return {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    phasesCount: levels.length,
    svgInner: `${laneLabels}${edges}${nodes}`,
  };
}

function buildRunCounts(tasks: UiTask[]) {
  const counts = {
    total: tasks.length,
    pending: tasks.filter((task) => task.status === 'pending').length,
    running: tasks.filter((task) => task.status === 'running').length,
    succeeded: tasks.filter((task) => task.status === 'succeeded').length,
    failed: tasks.filter((task) => task.status === 'failed').length,
    blocked: tasks.filter((task) => task.status === 'blocked').length,
    skipped: tasks.filter((task) => task.status === 'skipped').length,
    done: 0,
    progress: 0,
  };

  counts.done = counts.succeeded + counts.failed + counts.blocked + counts.skipped;
  counts.progress = counts.total ? Math.round((counts.done / counts.total) * 100) : 0;

  return counts;
}

function buildRunViewModel(payload: RunPayload, requestedTaskId?: string | null): UiRunViewModel {
  const tasks = normalizeTasks(payload);
  const selectedTask =
    tasks.find((task) => task.id === requestedTaskId) ||
    tasks[0] ||
    null;

  const counts = buildRunCounts(tasks);

  return {
    run: payload.run,
    plan: payload.plan,
    tasks,
    artifacts: payload.artifacts.map((artifact) => ({
      taskId: artifact.taskId ?? null,
      type: artifact.type,
      path: artifact.path ?? null,
      content: artifact.content ?? null,
      createdAt: artifact.createdAt ?? null,
    })),
    events: payload.events.map((event) => ({
      taskId: event.taskId ?? null,
      type: event.type,
      level: event.level,
      message: event.message,
      payload: event.payload,
      createdAt: event.createdAt ?? null,
    })),
    selectedTaskId: selectedTask?.id || null,
    counts,
    graph: buildGraph(payload.run.id, tasks, selectedTask?.id || null),
  };
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, {
    Location: location,
    'Cache-Control': 'no-store',
  });
  res.end();
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

async function readFormBody(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  return Object.fromEntries(new URLSearchParams(raw).entries());
}

function extractRunId(pathname: string, suffix = ''): string | null {
  const base = '/api/runs/';
  if (!pathname.startsWith(base)) return null;

  const trimmed = pathname.slice(base.length);
  if (suffix && trimmed.endsWith(suffix)) {
    return trimmed.slice(0, -suffix.length);
  }

  if (!suffix && !trimmed.includes('/')) {
    return trimmed;
  }

  return null;
}

function extractConsoleRunId(pathname: string, suffix = ''): string | null {
  const base = '/runs/';
  if (!pathname.startsWith(base)) return null;

  const trimmed = pathname.slice(base.length);
  if (suffix && trimmed.endsWith(suffix)) {
    return trimmed.slice(0, -suffix.length);
  }

  if (!suffix && !trimmed.includes('/')) {
    return trimmed;
  }

  return null;
}

function buildRunPayload(runId: string) {
  const run = unityStore.getRun(runId);
  if (!run) {
    return null;
  }

  return {
    run,
    plan: unityStore.getLatestPlanByRun(runId),
    plans: unityStore.listPlansByRun(runId),
    tasks: unityStore.listTasksByRun(runId),
    events: unityStore.listEventsByRun(runId),
    artifacts: unityStore.listArtifactsByRun(runId),
  };
}

function buildRunsListPayload() {
  return unityStore.listRuns(100).map((run) => {
    const latestPlan = unityStore.getLatestPlanByRun(run.id);
    const tasks = unityStore.listTasksByRun(run.id);
    const counts = buildRunCounts(
      tasks.map((task) => ({
        ...task,
        parentTaskId: task.parentTaskId ?? null,
        prompt: task.prompt ?? null,
        role: task.role ?? null,
        kind: task.kind ?? null,
        writeScope: task.writeScope || ['.'],
        dependencies: task.dependencies || [],
        branchName: task.branchName ?? null,
        worktreePath: task.worktreePath ?? null,
        commitSha: task.commitSha ?? null,
        commitMessage: task.commitMessage ?? null,
        outputSummary: task.outputSummary ?? null,
        validationSummary: task.validationSummary ?? null,
        createdAt: task.createdAt ?? null,
        updatedAt: task.updatedAt ?? null,
        startedAt: task.startedAt ?? null,
        finishedAt: task.finishedAt ?? null,
      })),
    );

    return {
      run,
      latestPlan,
      taskCounts: counts,
    };
  });
}

function buildActionsHtml(run: UiRunViewModel['run'], plan: UiRunViewModel['plan']) {
  const runId = encodeURIComponent(run.id);

  if (run.status === 'awaiting_plan_approval' && plan?.status === 'proposed') {
    return `<div class="actions">
        <button class="btn-primary" id="approve-plan">Approve Plan</button>
        <button class="btn-danger" id="reject-plan">Reject Plan</button>
      </div>`;
  }

  if (run.status === 'running' || run.status === 'healing') {
    return `<div class="actions">
      <button class="btn-secondary" id="cancel-run">Cancel Active Run</button>
    </div>`;
  }

  return '';
}

function buildMetaGridHtml(vm: UiRunViewModel) {
  const cards = [
    ['Status', renderStatusBadgeHtml(vm.run.status)],
    ['Mode', safeText(vm.run.mode)],
    ['Branch', safeText(vm.run.branchName)],
    ['Plan', vm.plan ? renderStatusBadgeHtml(vm.plan.status) : '<span class="muted">Missing</span>'],
    ['Progress', `${vm.counts.progress}%`],
    ['Tasks', String(vm.counts.total)],
    ['Running', String(vm.counts.running)],
    ['Failed', String(vm.counts.failed)],
  ];

  return cards
    .map(
      ([label, value]) =>
        `<div class="meta-card"><div class="meta-label">${label}</div><div class="meta-value">${value}</div></div>`,
    )
    .join('');
}

function buildPlanMetaHtml(vm: UiRunViewModel) {
  if (!vm.plan) {
    return '<div class="muted" style="padding: 16px;">Plan not found.</div>';
  }

  const lifecycle = [
    ['Run status', renderStatusBadgeHtml(vm.run.status)],
    ['Plan status', renderStatusBadgeHtml(vm.plan.status)],
    ['Created', formatDateTime(vm.plan.createdAt)],
    [
      'Approved',
      vm.plan.approvedAt
        ? `${formatDateTime(vm.plan.approvedAt)} · ${safeText(vm.plan.approvedBy || 'unknown')}`
        : 'Pending',
    ],
    [
      'Rejected',
      vm.plan.rejectedAt
        ? `${formatDateTime(vm.plan.rejectedAt)} · ${safeText(vm.plan.rejectedBy || 'unknown')}`
        : '—',
    ],
    ['Tasks', String(vm.counts.total)],
  ];

  return (
    `<div class="kv-grid">` +
    lifecycle
      .map(
        ([label, value]) =>
          `<div class="meta-card"><div class="meta-label">${label}</div><div class="meta-value" style="font-size:13px; font-weight:normal;">${value}</div></div>`,
      )
      .join('') +
    `</div>
    <div class="task-card" style="margin-top: 16px;">
      <div class="task-title">Plan Summary</div>
      <pre>${safeText(vm.plan.summary)}</pre>
    </div>` +
    (vm.plan.rejectedReason
      ? `<div class="task-card" style="margin-top: 16px; border-color: #f8717140;"><div class="task-title" style="color: #f87171;">Rejected Because</div><pre>${safeText(
          vm.plan.rejectedReason,
        )}</pre></div>`
      : '')
  );
}

function buildEventsHtml(events: UiEvent[]) {
  if (!events.length) {
    return '<div class="muted" style="padding: 16px;">No events yet.</div>';
  }

  return events
    .slice()
    .reverse()
    .map((event) => {
      const levelColor =
        event.level === 'error'
          ? getStatusColor('failed')
          : event.level === 'warning'
            ? getStatusColor('pending')
            : getStatusColor('running');

      return `<div class="timeline-item">
        <div class="timeline-dot" style="background:${levelColor}; box-shadow: 0 0 0 4px #09090b;"></div>
        <article class="event-card">
          <div class="event-top">
            <strong>${safeText(event.type)}</strong>
            <span class="muted">${safeText(formatDateTime(event.createdAt))}</span>
          </div>
          <div style="font-size: 13px; color: var(--text-muted); margin-top: 6px;">${safeText(event.message)}</div>
          ${event.payload ? `<pre style="margin-top: 10px;">${safeText(JSON.stringify(event.payload, null, 2))}</pre>` : ''}
        </article>
      </div>`;
    })
    .join('');
}

function buildTaskListHtml(tasks: UiTask[], selectedTaskId: string | null) {
  if (!tasks.length) {
    return '<div class="muted" style="padding: 16px; text-align: center;">No tasks available yet.</div>';
  }

  return tasks
    .map((task) => {
      const active = selectedTaskId === task.id;
      const dependencyCount = task.dependencies.length;

      return `<a class="task-list-item${active ? ' active' : ''}" href="/runs/${encodeURIComponent(
        task.runId,
      )}?task=${encodeURIComponent(task.id)}" data-task-id="${safeText(task.id)}">
        <div class="task-list-top">
          <div class="task-list-title">${safeText(task.title)}</div>
          ${renderStatusBadgeHtml(task.status)}
        </div>
        <div class="chip-row" style="margin-top: 8px;">
          <span class="chip">${safeText(task.kind || 'implement')}</span>
          <span class="chip">attempts ${safeText(task.attempts)}</span>
          ${task.planOnly ? '<span class="chip">plan preview</span>' : ''}
        </div>
        <div class="task-list-meta" style="margin-top: 12px;">
          <span>scope: ${safeText((task.writeScope || ['.']).join(', '))}</span>
          <span>${dependencyCount ? `${dependencyCount} dependenc${dependencyCount === 1 ? 'y' : 'ies'}` : 'no deps'}</span>
        </div>
      </a>`;
    })
    .join('');
}

function buildInspectorHtml(vm: UiRunViewModel) {
  const task = vm.tasks.find((candidate) => candidate.id === vm.selectedTaskId);

  if (!task) {
    return '<div class="muted" style="padding: 16px; text-align: center;">Select a task to inspect.</div>';
  }

  const dependencyTitles = task.dependencies.map((dependencyId) => {
    const dependency = vm.tasks.find((candidate) => candidate.id === dependencyId);
    return dependency ? dependency.title : dependencyId;
  });

  const relatedEvents = vm.events
    .filter((event) => event.taskId === task.id)
    .slice(-4)
    .reverse();

  return `<div style="display: flex; flex-direction: column; gap: 16px;">
    <div class="split">
      <div class="task-title" style="font-size: 16px;">${safeText(task.title)}</div>
      ${renderStatusBadgeHtml(task.status)}
    </div>
    <div class="chip-row">
      <span class="chip">${safeText(task.kind || 'implement')}</span>
      <span class="chip">attempts ${safeText(task.attempts)}</span>
      ${task.planOnly ? '<span class="chip">plan preview</span>' : ''}
    </div>
    <div class="kv-grid">
      <div class="meta-card"><div class="meta-label">Scope</div><div class="meta-value" style="font-size:13px; font-weight:normal;">${safeText((task.writeScope || ['.']).join(', '))}</div></div>
      <div class="meta-card"><div class="meta-label">Dependencies</div><div class="meta-value" style="font-size:13px; font-weight:normal;">${safeText(dependencyTitles.length ? dependencyTitles.join(', ') : 'None')}</div></div>
      <div class="meta-card"><div class="meta-label">Branch</div><div class="meta-value" style="font-size:13px; font-weight:normal;">${safeText(task.branchName || vm.run.branchName || '—')}</div></div>
      <div class="meta-card"><div class="meta-label">Commit</div><div class="meta-value" style="font-size:13px; font-weight:normal;">${safeText(task.commitSha || '—')}</div></div>
    </div>
    <div class="task-card">
      <div class="meta-label">Summary</div>
      <pre>${safeText(task.outputSummary || task.validationSummary || task.prompt || 'No summary available.')}</pre>
    </div>
    ${
      relatedEvents.length
        ? `<div class="task-card">
            <div class="meta-label">Recent task events</div>
            <pre>${safeText(
              relatedEvents
                .map((event) => `[${formatDateTime(event.createdAt)}] ${event.type} → ${event.message}`)
                .join('\n\n'),
            )}</pre>
          </div>`
        : ''
    }
  </div>`;
}

function buildArtifactsHtml(vm: UiRunViewModel) {
  const task = vm.tasks.find((candidate) => candidate.id === vm.selectedTaskId);
  if (!task) {
    return '<div class="muted" style="padding: 16px;">Select a task to view artifacts.</div>';
  }

  const taskArtifacts = vm.artifacts.filter((artifact) => artifact.taskId === task.id);
  if (!taskArtifacts.length) {
    return '<div class="muted" style="padding: 16px;">No artifacts stored for this task.</div>';
  }

  return taskArtifacts
    .slice()
    .reverse()
    .map((artifact) => {
      const preview = artifact.content ? artifact.content.slice(0, 1000) : '(binary or path-only artifact)';
      return `<article class="task-card" style="margin-bottom: 12px;">
        <div class="event-top" style="margin-bottom: 8px;">
          <strong style="font-size: 13px;">${safeText(artifact.type)}</strong>
          <span class="muted" style="font-size: 12px;">${safeText(formatDateTime(artifact.createdAt))}</span>
        </div>
        ${artifact.path ? `<div class="muted" style="font-size: 12px; margin-bottom: 12px; font-family: monospace;">${safeText(artifact.path)}</div>` : ''}
        <pre>${safeText(preview)}</pre>
      </article>`;
    })
    .join('');
}

const GLOBAL_CSS = `
  :root {
    --bg-app: #09090b;
    --bg-sidenav: #121214;
    --bg-surface: #18181b;
    --border: #27272a;
    --text-main: #fafafa;
    --text-muted: #a1a1aa;
    --accent: #e4e4e7;
    --radius: 12px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; height: 100vh; overflow: hidden;
    color: var(--text-main);
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: var(--bg-app);
    display: flex;
  }
  a { text-decoration: none; color: inherit; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.5; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; color: var(--text-muted); }
  
  /* Sidenav */
  .sidenav {
    width: 280px; min-width: 280px;
    background: var(--bg-sidenav);
    border-right: 1px solid var(--border);
    display: flex; flex-direction: column;
    padding: 16px; gap: 16px;
    z-index: 10;
  }
  .sidenav-header { padding: 8px 4px; display: flex; align-items: center; justify-content: space-between; }
  .sidenav-header h2 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: 0.02em; display: flex; align-items: center; gap: 8px;}
  .sidenav-header h2::before { content: ''; display: inline-block; width: 8px; height: 8px; background: #fafafa; border-radius: 2px; }
  .search-box {
    background: var(--bg-app); border: 1px solid var(--border);
    color: var(--text-main); padding: 10px 14px;
    border-radius: 8px; font-size: 13px; width: 100%;
    outline: none; transition: border 0.2s;
  }
  .search-box:focus { border-color: #52525b; }
  .runs-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; padding-right: 4px; }
  .run-nav-item {
    padding: 10px 12px; border-radius: 8px; cursor: pointer;
    display: flex; flex-direction: column; gap: 6px;
    color: var(--text-muted); transition: all 0.15s ease; border: 1px solid transparent;
  }
  .run-nav-item:hover { background: var(--bg-surface); color: var(--text-main); }
  .run-nav-item.active { background: var(--bg-surface); color: var(--text-main); border-color: var(--border); }
  .run-nav-title { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .run-nav-meta { font-size: 11px; display: flex; justify-content: space-between; align-items: center; }
  .run-nav-status { display: flex; align-items: center; gap: 4px; }
  .status-dot { width: 6px; height: 6px; border-radius: 50%; }

  /* Main View Common */
  .main-content { flex: 1; overflow-y: auto; position: relative; display: flex; flex-direction: column; }
  .muted { color: var(--text-muted); }
  
  /* Scrollbars */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #3f3f46; border-radius: 10px; }
  ::-webkit-scrollbar-thumb:hover { background: #52525b; }
`;

function buildHomePageShell(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Unity · Home</title>
    <style>
      ${GLOBAL_CSS}
      .home-container {
        max-width: 900px; margin: 0 auto; width: 100%;
        padding: 80px 48px; display: flex; flex-direction: column; gap: 48px;
      }
      .greeting h1 { font-size: 32px; font-weight: 400; letter-spacing: -0.02em; margin: 0 0 12px 0; }
      .greeting p { color: var(--text-muted); font-size: 15px; margin: 0; line-height: 1.6; max-width: 600px; }
      .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }
      .stat-card {
        background: var(--bg-surface); border: 1px solid var(--border);
        border-radius: var(--radius); padding: 24px;
        display: flex; flex-direction: column; gap: 8px;
      }
      .stat-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); font-weight: 600; }
      .stat-value { font-size: 32px; font-weight: 300; }
      .hidden-tools { display: none; }
    </style>
  </head>
  <body>
    <aside class="sidenav">
      <div class="sidenav-header">
        <h2>Unity Deck</h2>
      </div>
      <input id="runs-search" class="search-box" type="text" placeholder="Search runs..." />
      <div id="runs" class="runs-list"></div>
    </aside>

    <main class="main-content">
      <div class="home-container">
        <div class="greeting">
          <h1>Good morning.</h1>
          <p>Here is the current state of your autonomous agents. Select a run from the sidebar to inspect its execution graph, approve plans, or review artifacts.</p>
        </div>
        <div class="stats-grid" id="hero-metrics"></div>
      </div>
    </main>

    <script>
      let allRuns = [];
      const statusColors = { completed: '#4ade80', completed_with_warnings: '#f59e0b', succeeded: '#4ade80', awaiting_plan_approval: '#facc15', pending: '#facc15', failed: '#f87171', blocked: '#f87171', plan_rejected: '#f87171', running: '#60a5fa', healing: '#60a5fa', cancelled: '#9ca3af' };
      
      function safe(value) { return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

      function renderMetrics(items) {
        const awaiting = items.filter(({ run }) => run.status === 'awaiting_plan_approval').length;
        const active = items.filter(({ run }) => run.status === 'running' || run.status === 'healing').length;
        const completed = items.filter(({ run }) => run.status === 'completed').length;
        const needsReview = items.filter(({ run }) => run.status === 'completed_with_warnings').length;
        const failed = items.filter(({ run }) => run.status === 'failed').length;

        document.getElementById('hero-metrics').innerHTML = [
          ['Awaiting Approval', awaiting],
          ['Active Runs', active],
          ['Completed', completed],
          ['Needs Review', needsReview],
          ['Failed', failed],
        ].map(m => \`<div class="stat-card"><div class="stat-label">\${m[0]}</div><div class="stat-value">\${m[1]}</div></div>\`).join('');
      }

      function filterRuns(items) {
        const search = (document.getElementById('runs-search').value || '').toLowerCase().trim();
        return items.filter(item => {
          const haystack = [item.run.projectName, item.run.id, item.run.prompt].join(' ').toLowerCase();
          return !search || haystack.includes(search);
        });
      }

      function renderRunsList(items) {
        const container = document.getElementById('runs');
        if (!items.length) {
          container.innerHTML = '<div class="muted" style="font-size:12px; padding:12px; text-align:center;">No runs found.</div>';
          return;
        }

        container.innerHTML = items.map(item => {
          const color = statusColors[item.run.status] || '#d1d5db';
          const formatStat = item.run.status.replaceAll('_', ' ');
          return \`<a class="run-nav-item" href="/runs/\${encodeURIComponent(item.run.id)}">
            <div class="run-nav-title">\${safe(item.run.projectName)}</div>
            <div class="run-nav-meta">
              <div class="run-nav-status"><div class="status-dot" style="background:\${color}"></div><span>\${safe(formatStat)}</span></div>
              <span>\${item.taskCounts?.progress || 0}%</span>
            </div>
          </a>\`;
        }).join('');
      }

      async function loadRuns() {
        const response = await fetch('/api/runs');
        allRuns = await response.json();
        renderMetrics(allRuns);
        renderRunsList(filterRuns(allRuns));
      }

      document.getElementById('runs-search').addEventListener('input', () => renderRunsList(filterRuns(allRuns)));
      loadRuns(); setInterval(loadRuns, 5000);
    </script>
  </body>
</html>`;
}

function renderRunPage(
  runId: string,
  initialPayload?: ReturnType<typeof buildRunPayload> | null,
  requestedTaskId?: string | null,
): string {
  const vm = initialPayload ? buildRunViewModel(initialPayload, requestedTaskId) : null;
  const safeRunId = escapeHtml(runId);
  const initialSummary = vm?.plan?.summary || vm?.run?.summary || vm?.run?.prompt || 'Loading run details...';
  const actionsHtml = vm ? buildActionsHtml(vm.run, vm.plan) : '';
  const metaHtml = vm ? buildMetaGridHtml(vm) : '';
  const planMetaHtml = vm ? buildPlanMetaHtml(vm) : '';
  const eventsHtml = vm ? buildEventsHtml(vm.events) : '';
  const taskListHtml = vm ? buildTaskListHtml(vm.tasks, vm.selectedTaskId) : '<div class="muted" style="padding:16px;">Loading tasks…</div>';
  const inspectorHtml = vm ? buildInspectorHtml(vm) : '<div class="muted" style="padding:16px;">Waiting for selection…</div>';
  const artifactsHtml = vm ? buildArtifactsHtml(vm) : '<div class="muted" style="padding:16px;">No artifacts.</div>';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Run ${safeRunId}</title>
    <style>
      ${GLOBAL_CSS}
      
      .topbar { padding: 32px 48px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 24px; }
      .topbar-main { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; flex-wrap: wrap; }
      .topbar-titles h1 { margin: 0 0 8px 0; font-size: 24px; font-weight: 500; letter-spacing: -0.02em; }
      .topbar-titles .subtle { font-size: 14px; line-height: 1.5; color: var(--text-muted); max-width: 800px; }
      
      .actions { display: flex; gap: 12px; }
      button { border: none; border-radius: 8px; padding: 10px 16px; font-size: 13px; font-weight: 600; cursor: pointer; transition: opacity 0.2s; }
      button:hover { opacity: 0.9; }
      button:disabled { opacity: 0.5; cursor: not-allowed; }
      .btn-primary { background: var(--text-main); color: var(--bg-app); }
      .btn-secondary { background: var(--bg-surface); border: 1px solid var(--border); color: var(--text-main); }
      .btn-danger { background: #ef4444; color: white; }

      .progress-track { width: 100%; height: 6px; border-radius: 99px; background: var(--bg-surface); overflow: hidden; margin-top: 8px; }
      .progress-bar { height: 100%; background: #4ade80; transition: width 0.3s ease; }

      .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
      .meta-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; display: flex; flex-direction: column; gap: 4px; }
      .meta-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); font-weight: 600; }
      .meta-value { font-size: 14px; font-weight: 500; }
      
      .status-badge { display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 99px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }

      .dashboard-layout { display: grid; grid-template-columns: minmax(0, 1fr) 400px; gap: 24px; padding: 32px 48px; align-items: start; }
      @media (max-width: 1200px) { .dashboard-layout { grid-template-columns: 1fr; } }
      
      .section { display: flex; flex-direction: column; gap: 16px; margin-bottom: 32px; }
      .section-header h2 { margin: 0; font-size: 16px; font-weight: 500; }
      .section-note { font-size: 13px; color: var(--text-muted); }

      .graph-shell { position: relative; background: var(--bg-app); border: 1px solid var(--border); border-radius: var(--radius); min-height: 400px; overflow: hidden; }
      .graph-shell::before { content: ''; position: absolute; inset: 0; background-image: radial-gradient(circle at center, #27272a 1px, transparent 1px); background-size: 24px 24px; opacity: 0.4; pointer-events: none; }
      .graph-toolbar { position: absolute; top: 16px; left: 16px; display: flex; gap: 8px; z-index: 2; }
      .toolbar-chip { background: rgba(24,24,27,0.8); backdrop-filter: blur(8px); border: 1px solid var(--border); padding: 6px 12px; border-radius: 99px; font-size: 12px; font-weight: 500; color: var(--text-muted); }
      .graph-scroll { overflow: auto; padding: 60px 20px 20px; }
      
      .lane-label { fill: var(--text-main); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
      .lane-sub { fill: var(--text-muted); font-size: 11px; }
      .node-group { cursor: pointer; transition: transform 0.1s; }
      .node-group:hover { transform: translateY(-2px); }
      .node-title { fill: var(--text-main); font-size: 14px; font-weight: 600; }
      .node-subtitle { fill: var(--text-muted); font-size: 11px; font-family: monospace; }
      .node-foot { fill: var(--text-muted); font-size: 12px; }

      .kv-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .task-card, .event-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
      .task-title { font-weight: 600; margin-bottom: 8px; }
      
      .chip-row { display: flex; gap: 8px; flex-wrap: wrap; }
      .chip { padding: 4px 10px; border-radius: 99px; background: var(--bg-app); border: 1px solid var(--border); font-size: 11px; color: var(--text-muted); }
      
      .task-list { display: flex; flex-direction: column; gap: 8px; }
      .task-list-item { display: flex; flex-direction: column; padding: 16px; background: var(--bg-surface); border: 1px solid transparent; border-radius: 10px; transition: all 0.15s; }
      .task-list-item:hover { border-color: var(--border); }
      .task-list-item.active { border-color: var(--border); background: #27272a40; }
      .task-list-top { display: flex; justify-content: space-between; align-items: flex-start; }
      .task-list-title { font-weight: 500; font-size: 14px; }
      .task-list-meta { display: flex; justify-content: space-between; font-size: 12px; color: var(--text-muted); }
      
      .timeline { position: relative; display: flex; flex-direction: column; gap: 16px; }
      .timeline::before { content: ''; position: absolute; left: 7px; top: 8px; bottom: 8px; width: 2px; background: var(--border); }
      .timeline-item { position: relative; padding-left: 28px; }
      .timeline-dot { position: absolute; left: 0; top: 12px; width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--border); }
      .event-top { display: flex; justify-content: space-between; align-items: center; }

      .filters-row { display: flex; gap: 12px; margin-bottom: 12px; }
      .input-base { background: var(--bg-surface); border: 1px solid var(--border); color: var(--text-main); padding: 10px 14px; border-radius: 8px; font-size: 13px; flex: 1; outline: none; }
      .input-base:focus { border-color: #52525b; }
      select.input-base { flex: 0 0 auto; padding-right: 32px; }
      textarea.input-base { min-height: 80px; resize: vertical; width: 100%; margin-bottom: 12px; }
    </style>
  </head>
  <body>
    <aside class="sidenav">
      <div class="sidenav-header">
        <a href="/">Unity Deck</a>
      </div>
      <input id="runs-search" class="search-box" type="text" placeholder="Search runs..." />
      <div id="runs" class="runs-list"></div>
    </aside>

    <main class="main-content">
      <header class="topbar">
        <div class="topbar-main">
          <div class="topbar-titles">
            <h1 id="hero-title">${safeText(vm?.run.projectName)} · ${safeRunId}</h1>
            <div id="hero-summary" class="subtle">${escapeHtml(initialSummary)}</div>
          </div>
          <div id="actions">${actionsHtml}</div>
        </div>
        <div>
          <div style="display:flex; justify-content:space-between; font-size:12px; color:var(--text-muted); font-weight:600; margin-bottom:4px;">
            <span>RUN PROGRESS</span>
            <span id="progress-value">${vm ? vm.counts.progress : 0}%</span>
          </div>
          <div class="progress-track">
            <div id="progress-bar" class="progress-bar" style="width:${vm ? vm.counts.progress : 0}%;"></div>
          </div>
        </div>
        <div id="meta-grid" class="meta-grid">${metaHtml}</div>
      </header>

      <div class="dashboard-layout">
        <div class="stack">
          <section class="section">
            <div class="section-header">
              <h2>Execution Flow</h2>
              <div class="section-note">Dependency graph and live execution posture.</div>
            </div>
            <div class="graph-shell">
              <div class="graph-toolbar">
                <div class="toolbar-chip" id="graph-mode-chip">Loading phase...</div>
                <div class="toolbar-chip" id="graph-selection-chip">No selection</div>
              </div>
              <div class="graph-scroll" id="graph-scroll">
                <svg id="graph-stage" role="img" aria-label="Run task graph" viewBox="${escapeHtml(vm?.graph.viewBox || '0 0 1200 620')}" width="${escapeHtml(String(vm?.graph.width || 1200))}" height="${escapeHtml(String(vm?.graph.height || 620))}">${vm?.graph.svgInner || ''}</svg>
              </div>
            </div>
          </section>

          <section class="section">
            <div class="section-header">
              <h2>Task List</h2>
            </div>
            <div class="filters-row">
              <input id="task-search" class="input-base" type="text" placeholder="Search tasks..." />
              <select id="task-status-filter" class="input-base">
                <option value="all">All Statuses</option>
                <option value="pending">Pending</option>
                <option value="running">Running</option>
                <option value="succeeded">Succeeded</option>
                <option value="failed">Failed</option>
              </select>
            </div>
            <div id="task-list" class="task-list">${taskListHtml}</div>
          </section>
          
          <section class="section">
            <div class="section-header"><h2>Timeline</h2></div>
            <div id="events" class="timeline">${eventsHtml}</div>
          </section>
        </div>

        <aside class="inspector">
          <section class="section">
            <div class="section-header"><h2>Selected Task</h2></div>
            <div id="task-inspector">${inspectorHtml}</div>
          </section>

          <section class="section">
            <div class="section-header"><h2>Artifacts</h2></div>
            <div id="task-artifacts">${artifactsHtml}</div>
          </section>

          <section class="section">
            <div class="section-header"><h2>Plan Details</h2></div>
            <div id="plan-meta">${planMetaHtml}</div>
            <div style="margin-top:16px;">
              <textarea id="reject-reason" class="input-base" placeholder="Reason for rejection (if applicable)..."></textarea>
            </div>
          </section>
        </aside>
      </div>
    </main>

    <script>
      const currentRunId = ${JSON.stringify(runId)};
      let latestPayload = ${serializeForScript(initialPayload || null)};
      let selectedTaskId = ${serializeForScript(vm?.selectedTaskId || null)};
      let taskSearch = '';
      let taskStatusFilter = 'all';

      const statusColors = { completed: '#4ade80', completed_with_warnings: '#f59e0b', succeeded: '#4ade80', awaiting_plan_approval: '#facc15', pending: '#facc15', failed: '#f87171', blocked: '#f87171', plan_rejected: '#f87171', running: '#60a5fa', healing: '#60a5fa', cancelled: '#9ca3af' };
      
      function safe(v) { return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
      function truncate(v, m) { const s=String(v||''); return s.length>m ? s.slice(0,m-1)+'…' : s; }
      function formatDate(v) { return v ? new Date(v).toLocaleString() : '—'; }
      function statusBadge(s) { const c = statusColors[s]||'#d1d5db'; return \`<span class="status-badge" style="background:\${c}15;color:\${c};border:1px solid \${c}30;">\${safe(s.replaceAll('_',' '))}</span>\`; }

      // --- Sidenav Logic ---
      let allRuns = [];
      function renderRunsList(items) {
        const container = document.getElementById('runs');
        if (!items.length) { container.innerHTML = '<div class="muted" style="font-size:12px; padding:12px;">No runs found.</div>'; return; }
        container.innerHTML = items.map(item => {
          const color = statusColors[item.run.status] || '#d1d5db';
          const isActive = item.run.id === currentRunId ? ' active' : '';
          return \`<a class="run-nav-item\${isActive}" href="/runs/\${encodeURIComponent(item.run.id)}">
            <div class="run-nav-title">\${safe(item.run.projectName)}</div>
            <div class="run-nav-meta">
              <div class="run-nav-status"><div class="status-dot" style="background:\${color}"></div><span>\${safe(item.run.status.replaceAll('_',' '))}</span></div>
              <span>\${item.taskCounts?.progress || 0}%</span>
            </div>
          </a>\`;
        }).join('');
      }
      async function loadSidenavRuns() {
        const res = await fetch('/api/runs');
        allRuns = await res.json();
        const search = document.getElementById('runs-search').value.toLowerCase().trim();
        const filtered = allRuns.filter(i => !search || [i.run.projectName, i.run.id].join(' ').toLowerCase().includes(search));
        renderRunsList(filtered);
      }
      document.getElementById('runs-search').addEventListener('input', loadSidenavRuns);

      // --- Data Processing Helpers ---
      function normalizeTasks(run, plan, tasks) {
        if (tasks && tasks.length) return tasks.slice().sort((l,r)=>l.orderIndex-r.orderIndex).map(t=>({...t, writeScope: t.writeScope||['.'], dependencies: t.dependencies||[]}));
        const drafts = plan?.rawPlan?.tasks || [];
        const t2id = {}; drafts.forEach((t,i) => t2id[t.title]='draft-'+i);
        return drafts.map((t,i) => ({
          id: t2id[t.title]||'draft-'+i, runId: run.id, parentTaskId: null, title: t.title, prompt: t.prompt, role: t.role||'executor', kind: t.kind||'implement',
          status: run.status==='plan_rejected'?'blocked':'pending', writeScope: t.writeScope||['.'], dependencies: (t.dependencies||[]).map(d=>t2id[d]).filter(Boolean),
          attempts: 0, branchName: null, worktreePath: null, commitSha: null, commitMessage: null, outputSummary: t.rationale||null, validationSummary: null,
          orderIndex: i, createdAt: run.createdAt, updatedAt: run.updatedAt, startedAt: null, finishedAt: null, planOnly: true
        }));
      }

      function buildLevels(tasks) {
        const byId = new Map(tasks.map(t => [t.id, t]));
        const memo = new Map();
        function compute(id, trail) {
          if(memo.has(id)) return memo.get(id);
          if(trail.has(id)) return 0;
          const t = byId.get(id); if(!t) return 0;
          trail.add(id);
          const deps = (t.dependencies||[]).filter(d => byId.has(d));
          const lvl = deps.length ? Math.max(...deps.map(d => compute(d, trail))) + 1 : 0;
          trail.delete(id); memo.set(id, lvl); return lvl;
        }
        tasks.forEach(t => compute(t.id, new Set()));
        const lvls = [];
        tasks.forEach(t => { const l = memo.get(t.id)||0; if(!lvls[l]) lvls[l]=[]; lvls[l].push(t); });
        lvls.forEach(c => c.sort((l,r)=>l.orderIndex-r.orderIndex));
        return lvls.filter(Boolean);
      }

      function getCounts(tasks) {
        const c = { total: tasks.length, pending:0, running:0, succeeded:0, failed:0, blocked:0, skipped:0, done:0, progress:0 };
        tasks.forEach(t => { if(c[t.status]!==undefined) c[t.status]++; });
        c.done = c.succeeded + c.failed + c.blocked + c.skipped;
        c.progress = c.total ? Math.round((c.done/c.total)*100) : 0;
        return c;
      }

      function syncUrl() {
        const u = new URL(window.location.href);
        if(selectedTaskId) u.searchParams.set('task', selectedTaskId); else u.searchParams.delete('task');
        window.history.replaceState({}, '', u.toString());
      }

      // --- UI Renderers ---
      function updateTopbar(run, plan, counts) {
        document.getElementById('hero-title').textContent = run.projectName + ' · ' + run.id;
        document.getElementById('hero-summary').textContent = plan?.summary || run.summary || run.prompt;
        document.getElementById('progress-value').textContent = counts.progress + '%';
        document.getElementById('progress-bar').style.width = counts.progress + '%';

        const cards = [
          ['Status', statusBadge(run.status)], ['Mode', safe(run.mode)], ['Branch', safe(run.branchName)],
          ['Plan', plan ? statusBadge(plan.status) : '<span class="muted">Missing</span>'],
          ['Progress', counts.progress+'%'], ['Tasks', counts.total], ['Running', counts.running], ['Failed', counts.failed]
        ];
        document.getElementById('meta-grid').innerHTML = cards.map(c => \`<div class="meta-card"><div class="meta-label">\${c[0]}</div><div class="meta-value">\${c[1]}</div></div>\`).join('');

        const actions = document.getElementById('actions');
        let actHtml = '';
        if (run.status === 'awaiting_plan_approval' && plan?.status === 'proposed') {
          actHtml = \`<button class="btn-primary" id="approve-plan">Approve Plan</button> <button class="btn-danger" id="reject-plan">Reject</button>\`;
        } else if (run.status === 'running' || run.status === 'healing') {
          actHtml = \`<button class="btn-secondary" id="cancel-run">Cancel Run</button>\`;
        }
        actions.innerHTML = actHtml;

        const bind = (id, fn) => { const el = document.getElementById(id); if(el) el.onclick = async () => { el.disabled = true; await fn(); await loadRunData(); }; }
        bind('approve-plan', () => fetch('/api/runs/'+currentRunId+'/approve-plan', {method:'POST', body:'{}'}));
        bind('reject-plan', () => fetch('/api/runs/'+currentRunId+'/reject-plan', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({reason: document.getElementById('reject-reason').value})}));
        bind('cancel-run', () => fetch('/api/runs/'+currentRunId+'/cancel', {method:'POST', body:'{}'}));
      }

      function renderGraph(tasks, run) {
        const stage = document.getElementById('graph-stage');
        if (!tasks.length) {
          stage.innerHTML = '<text x="100" y="180" fill="var(--text-muted)">No tasks generated yet.</text>';
          return;
        }

        const levels = buildLevels(tasks);
        const nw = 280, nh = 110, cg = 120, rg = 140, mx = 60, my = 80;
        const pos = new Map(); let maxR = 1;
        levels.forEach((col, ci) => { maxR = Math.max(maxR, col.length); col.forEach((t, ri) => pos.set(t.id, {x: mx+ci*(nw+cg), y: my+ri*rg})); });
        
        const w = mx*2 + levels.length*nw + Math.max(0, levels.length-1)*cg;
        const h = my + maxR*rg + 90;
        stage.setAttribute('viewBox', \`0 0 \${w} \${h}\`); stage.setAttribute('width', w); stage.setAttribute('height', h);

        const lanes = levels.map((c, i) => \`<text x="\${mx+i*(nw+cg)}" y="36" class="lane-label">Phase \${i+1}</text><text x="\${mx+i*(nw+cg)}" y="56" class="lane-sub">\${c.length} nodes</text>\`).join('');
        const edges = tasks.flatMap(t => {
          const tgt = pos.get(t.id); if(!tgt) return [];
          return (t.dependencies||[]).map(d => {
            const src = pos.get(d); if(!src) return '';
            const sx=src.x+nw, sy=src.y+nh/2, ex=tgt.x, ey=tgt.y+nh/2, cv=Math.max(40, (ex-sx)/2);
            return \`<path class="edge" stroke="#3f3f46" d="M \${sx} \${sy} C \${sx+cv} \${sy}, \${ex-cv} \${ey}, \${ex} \${ey}" />\`;
          });
        }).join('');

        const nodes = tasks.map(t => {
          const p = pos.get(t.id), c = statusColors[t.status]||'#d1d5db', act = selectedTaskId===t.id;
          const stroke = act ? c : '#3f3f46', glow = act ? \`drop-shadow(0 0 10px \${c}40)\` : 'none';
          return \`<g class="node-group\${act?' active':''}" data-task-id="\${safe(t.id)}" transform="translate(\${p.x} \${p.y})" style="filter:\${glow}">
            <rect x="0" y="0" rx="12" ry="12" width="\${nw}" height="\${nh}" fill="#18181b" stroke="\${stroke}" stroke-width="1.5"/>
            <rect x="16" y="16" rx="6" ry="6" width="68" height="24" fill="\${c}15" stroke="\${c}30" />
            <text x="26" y="32" class="node-subtitle" fill="\${c}">\${safe(t.status.toUpperCase())}</text>
            <circle cx="250" cy="28" r="4" fill="\${c}" />
            <text x="16" y="64" class="node-title">\${safe(truncate(t.title, 28))}</text>
            <text x="16" y="84" class="node-subtitle">scope: \${safe(truncate((t.writeScope||['.']).join(', '), 26))}</text>
          </g>\`;
        }).join('');

        stage.innerHTML = lanes + edges + nodes;
        const selT = tasks.find(t=>t.id===selectedTaskId);
        document.getElementById('graph-mode-chip').textContent = run.status.replaceAll('_',' ');
        document.getElementById('graph-selection-chip').textContent = selT ? 'Inspecting: '+selT.title : 'No selection';

        stage.querySelectorAll('.node-group').forEach(n => {
          n.addEventListener('click', () => { selectedTaskId = n.getAttribute('data-task-id'); syncUrl(); renderAll(); });
        });
      }

      function renderLists(tasks, events, artifacts) {
        // Tasks
        const visibleT = tasks.filter(t => {
          const s = !taskSearch || [t.title, t.prompt].join(' ').toLowerCase().includes(taskSearch);
          const f = taskStatusFilter === 'all' || t.status === taskStatusFilter;
          return s && f;
        });
        document.getElementById('task-list').innerHTML = visibleT.length ? visibleT.map(t => {
          const act = selectedTaskId === t.id ? ' active' : '';
          return \`<button class="task-list-item\${act}" data-tl-id="\${safe(t.id)}" style="text-align:left; cursor:pointer; width:100%; font-family:inherit;">
            <div class="task-list-top"><div class="task-list-title">\${safe(t.title)}</div>\${statusBadge(t.status)}</div>
            <div class="chip-row" style="margin-top:8px;"><span class="chip">\${safe(t.kind||'implement')}</span><span class="chip">attempts \${t.attempts||0}</span></div>
          </button>\`;
        }).join('') : '<div class="muted">No tasks match.</div>';
        document.querySelectorAll('[data-tl-id]').forEach(b => b.addEventListener('click', () => { selectedTaskId = b.getAttribute('data-tl-id'); syncUrl(); renderAll(); }));

        // Events
        document.getElementById('events').innerHTML = events.length ? events.slice().reverse().map(e => {
          const c = e.level==='error'?'#f87171':e.level==='warning'?'#facc15':'#60a5fa';
          return \`<div class="timeline-item"><div class="timeline-dot" style="background:\${c}; box-shadow:0 0 0 4px #09090b"></div>
            <div class="event-card"><div class="event-top"><strong style="font-size:13px">\${safe(e.type)}</strong><span class="muted" style="font-size:11px">\${formatDate(e.createdAt)}</span></div>
            <div style="font-size:13px; margin-top:6px; color:var(--text-muted)">\${safe(e.message)}</div></div></div>\`;
        }).join('') : '<div class="muted">No events.</div>';

        // Inspector & Artifacts
        const t = tasks.find(c => c.id === selectedTaskId);
        if(!t) {
          document.getElementById('task-inspector').innerHTML = '<div class="muted">Select a task.</div>';
          document.getElementById('task-artifacts').innerHTML = '<div class="muted">Select a task.</div>';
          return;
        }
        
        document.getElementById('task-inspector').innerHTML = \`<div style="display:flex; flex-direction:column; gap:16px;">
          <div style="display:flex; justify-content:space-between; font-weight:600;">\${safe(t.title)}\${statusBadge(t.status)}</div>
          <div class="kv-grid">
            <div class="meta-card"><div class="meta-label">Scope</div><div class="meta-value" style="font-size:12px; font-weight:normal">\${safe((t.writeScope||['.']).join(', '))}</div></div>
            <div class="meta-card"><div class="meta-label">Dependencies</div><div class="meta-value" style="font-size:12px; font-weight:normal">\${t.dependencies.length?t.dependencies.length:'None'}</div></div>
          </div>
          <div class="task-card"><div class="meta-label">Summary</div><pre>\${safe(t.outputSummary || t.prompt || 'No summary.')}</pre></div>
        </div>\`;

        const arts = artifacts.filter(a => a.taskId === t.id);
        document.getElementById('task-artifacts').innerHTML = arts.length ? arts.map(a => \`<div class="task-card" style="margin-bottom:8px;">
          <div style="display:flex; justify-content:space-between; margin-bottom:8px; font-size:12px;"><strong>\${safe(a.type)}</strong><span class="muted">\${formatDate(a.createdAt)}</span></div>
          <pre>\${safe(a.content ? a.content.slice(0,800) : 'binary')}</pre></div>\`).join('') : '<div class="muted">No artifacts stored.</div>';
      }

      function renderAll() {
        if(!latestPayload) return;
        const run = latestPayload.run, plan = latestPayload.plan;
        const tasks = normalizeTasks(run, plan, latestPayload.tasks||[]);
        const events = latestPayload.events||[], artifacts = latestPayload.artifacts||[];
        const counts = getCounts(tasks);

        updateTopbar(run, plan, counts);
        renderGraph(tasks, run);
        renderLists(tasks, events, artifacts);
      }

      async function loadRunData() {
        try {
          const res = await fetch('/api/runs/'+currentRunId);
          if(!res.ok) return;
          latestPayload = await res.json();
          renderAll();
        } catch(e) { console.error(e); }
      }

      document.getElementById('task-search').addEventListener('input', e => { taskSearch = e.target.value.toLowerCase(); renderAll(); });
      document.getElementById('task-status-filter').addEventListener('change', e => { taskStatusFilter = e.target.value; renderAll(); });

      loadSidenavRuns(); setInterval(loadSidenavRuns, 5000);
      if(latestPayload) renderAll(); else loadRunData();
      setInterval(loadRunData, 4000);
    </script>
  </body>
</html>`;
}

export function startUnityHttpServer(runtime: RuntimeState) {
  const config = getRuntimeConfig();

  const server = createServer(async (req, res) => {
    if (!req.url || !req.method) {
      sendJson(res, 400, { error: 'Missing request metadata.' });
      return;
    }

    const url = new URL(req.url, `http://localhost:${config.localConsolePort}`);
    const pathname = url.pathname;

    try {
      if (req.method === 'GET' && pathname === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && pathname === '/') {
        sendHtml(res, buildHomePageShell());
        return;
      }

      if (req.method === 'GET' && pathname.startsWith('/runs/')) {
        const runId = pathname.slice('/runs/'.length);
        sendHtml(res, renderRunPage(runId, buildRunPayload(runId), url.searchParams.get('task')));
        return;
      }

      if (req.method === 'POST' && extractConsoleRunId(pathname, '/approve-plan')) {
        const runId = extractConsoleRunId(pathname, '/approve-plan') as string;

        if (runtime.isProcessing()) {
          redirect(res, `/runs/${runId}`);
          return;
        }

        const abortController = runtime.startProcessing();
        try {
          approveAutonomousRunPlan(runId, 'local-ui-form');
        } catch (error) {
          runtime.finishProcessing();
          throw error;
        }

        void resumeAutonomousRun({
          runId,
          signal: abortController.signal,
          onProgress: async (message) => {
            console.log(`[unity-console][${runId}] ${message}`);
            unityStore.addEvent(createEntityId('event'), runId, null, 'info', 'run.progress', message);
          },
        })
          .catch((error: any) => {
            console.error(error);
            const message = error?.message || String(error);
            unityStore.updateRun(runId, {
              status: message === 'AbortError' ? 'cancelled' : 'failed',
              finishedAt: new Date().toISOString(),
              summary: message,
            });
            unityStore.addEvent(
              createEntityId('event'),
              runId,
              null,
              message === 'AbortError' ? 'warning' : 'error',
              message === 'AbortError' ? 'run.cancelled' : 'run.failed',
              message,
            );
          })
          .finally(() => {
            runtime.finishProcessing();
          });

        redirect(res, `/runs/${runId}`);
        return;
      }

      if (req.method === 'POST' && extractConsoleRunId(pathname, '/reject-plan')) {
        const runId = extractConsoleRunId(pathname, '/reject-plan') as string;
        const body = await readFormBody(req);
        const reason = body.reason?.trim() || 'Plan rejected from the local console.';
        rejectAutonomousRunPlan(runId, 'local-ui-form', reason);
        redirect(res, `/runs/${runId}`);
        return;
      }

      if (req.method === 'POST' && extractConsoleRunId(pathname, '/cancel')) {
        runtime.abortCurrentTask();
        redirect(res, `/runs/${extractConsoleRunId(pathname, '/cancel')}`);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/runs') {
        sendJson(res, 200, buildRunsListPayload());
        return;
      }

      if (req.method === 'GET' && extractRunId(pathname)) {
        const runId = extractRunId(pathname) as string;
        const payload = buildRunPayload(runId);
        if (!payload) {
          sendJson(res, 404, { error: `Run ${runId} was not found.` });
          return;
        }

        sendJson(res, 200, payload);
        return;
      }

      if (req.method === 'GET' && extractRunId(pathname, '/plan')) {
        const runId = extractRunId(pathname, '/plan') as string;
        sendJson(res, 200, unityStore.getLatestPlanByRun(runId));
        return;
      }

      if (req.method === 'GET' && extractRunId(pathname, '/tasks')) {
        const runId = extractRunId(pathname, '/tasks') as string;
        sendJson(res, 200, unityStore.listTasksByRun(runId));
        return;
      }

      if (req.method === 'GET' && extractRunId(pathname, '/events')) {
        const runId = extractRunId(pathname, '/events') as string;
        sendJson(res, 200, unityStore.listEventsByRun(runId));
        return;
      }

      if (req.method === 'GET' && extractRunId(pathname, '/artifacts')) {
        const runId = extractRunId(pathname, '/artifacts') as string;
        sendJson(res, 200, unityStore.listArtifactsByRun(runId));
        return;
      }

      if (req.method === 'POST' && extractRunId(pathname, '/approve-plan')) {
        const runId = extractRunId(pathname, '/approve-plan') as string;
        const body = await readJsonBody(req);
        const approvedBy = typeof body.approvedBy === 'string' && body.approvedBy.trim() ? body.approvedBy : 'local-ui';

        if (runtime.isProcessing()) {
          sendJson(res, 409, { error: 'Unity Agent is already processing another run.' });
          return;
        }

        const abortController = runtime.startProcessing();
        try {
          approveAutonomousRunPlan(runId, approvedBy);
        } catch (error) {
          runtime.finishProcessing();
          throw error;
        }

        void resumeAutonomousRun({
          runId,
          signal: abortController.signal,
          onProgress: async (message) => {
            console.log(`[unity-console][${runId}] ${message}`);
            unityStore.addEvent(createEntityId('event'), runId, null, 'info', 'run.progress', message);
          },
        })
          .catch((error: any) => {
            console.error(error);
            const message = error?.message || String(error);
            unityStore.updateRun(runId, {
              status: message === 'AbortError' ? 'cancelled' : 'failed',
              finishedAt: new Date().toISOString(),
              summary: message,
            });
            unityStore.addEvent(
              createEntityId('event'),
              runId,
              null,
              message === 'AbortError' ? 'warning' : 'error',
              message === 'AbortError' ? 'run.cancelled' : 'run.failed',
              message,
            );
          })
          .finally(() => {
            runtime.finishProcessing();
          });

        sendJson(res, 202, {
          ok: true,
          runId,
          message: 'Plan approved. Run resumed in the background.',
        });
        return;
      }

      if (req.method === 'POST' && extractRunId(pathname, '/reject-plan')) {
        const runId = extractRunId(pathname, '/reject-plan') as string;
        const body = await readJsonBody(req);
        const rejectedBy =
          typeof body.rejectedBy === 'string' && body.rejectedBy.trim() ? body.rejectedBy : 'local-ui';
        const reason =
          typeof body.reason === 'string' && body.reason.trim()
            ? body.reason
            : 'Plan rejected from the local console.';

        rejectAutonomousRunPlan(runId, rejectedBy, reason);
        sendJson(res, 200, {
          ok: true,
          runId,
          message: 'Plan rejected.',
        });
        return;
      }

      if (req.method === 'POST' && extractRunId(pathname, '/cancel')) {
        if (!runtime.abortCurrentTask()) {
          sendJson(res, 409, { error: 'No active run is currently executing.' });
          return;
        }

        sendJson(res, 202, { ok: true, message: 'Abort requested.' });
        return;
      }

      sendJson(res, 404, { error: 'Route not found.' });
    } catch (error: any) {
      sendJson(res, 500, { error: error?.message || 'Unhandled server error.' });
    }
  });

  server.listen(config.localConsolePort, () => {
    console.log(`🌐 Unity Console listening on http://localhost:${config.localConsolePort}`);
  });

  return server;
}
