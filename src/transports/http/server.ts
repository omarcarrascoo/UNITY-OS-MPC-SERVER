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
type NormalizedServerTask = ReturnType<typeof normalizeServerTasks>[number];

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

function getStatusColor(status: string): string {
  switch (status) {
    case 'completed':
    case 'succeeded':
      return '#86efac';
    case 'awaiting_plan_approval':
    case 'pending':
      return '#facc15';
    case 'failed':
    case 'blocked':
    case 'plan_rejected':
      return '#fb7185';
    case 'cancelled':
    case 'skipped':
      return '#64748b';
    default:
      return '#cbd5e1';
  }
}

function renderStatusBadgeHtml(status: string): string {
  const color = getStatusColor(status);
  return `<span class="status-badge" style="background:${color}18;color:${color};">${escapeHtml(
    status.replaceAll('_', ' '),
  )}</span>`;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString('en-US');
}

function normalizeServerTasks(payload: RunPayload) {
  if (payload.tasks.length > 0) {
    return payload.tasks;
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

function buildServerLevels(tasks: ReturnType<typeof normalizeServerTasks>) {
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

  const levels: Array<NormalizedServerTask[]> = [];
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

function buildServerGraph(
  runId: string,
  tasks: ReturnType<typeof normalizeServerTasks>,
  selectedTaskId: string | null,
): {
  svgInner: string;
  viewBox: string;
  width: number;
  height: number;
  phasesCount: number;
} {
  if (tasks.length === 0) {
    return {
      width: 900,
      height: 420,
      viewBox: '0 0 900 420',
      phasesCount: 0,
      svgInner: `<text x="96" y="170" class="lane-label">No tasks yet</text><text x="96" y="202" class="lane-sub">The plan exists but no nodes were generated.</text>`,
    };
  }

  const levels = buildServerLevels(tasks);
  const nodeWidth = 286;
  const nodeHeight = 118;
  const columnGap = 170;
  const rowGap = 168;
  const marginX = 88;
  const marginY = 100;
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
  const height = marginY + maxRows * rowGap + 80;

  const laneLabels = levels
    .map((column, index) => {
      const x = marginX + index * (nodeWidth + columnGap);
      return `<text x="${x}" y="46" class="lane-label">Phase ${index + 1}</text><text x="${x}" y="68" class="lane-sub">${column.length} node(s)</text>`;
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
        const curve = Math.max(56, (endX - startX) / 2);
        return `<path class="edge" stroke="rgba(203,213,225,0.38)" d="M ${startX} ${startY} C ${startX + curve} ${startY}, ${endX - curve} ${endY}, ${endX} ${endY}" />`;
      });
    })
    .join('');

  const nodes = tasks
    .map((task) => {
      const position = positions.get(task.id) as { x: number; y: number };
      const color = getStatusColor(task.status);
      const active = selectedTaskId === task.id;
      const stroke = active ? '#ffffff' : 'rgba(255,255,255,0.1)';
      const glow = active ? '0 0 18px rgba(255,255,255,0.22)' : 'none';
      const scopeLabel = escapeHtml((task.writeScope || ['.']).join(', ').slice(0, 34));
      const summary = escapeHtml(String(task.outputSummary || task.validationSummary || task.prompt || '').slice(0, 74));
      const taskHref = `/runs/${encodeURIComponent(runId)}?task=${encodeURIComponent(task.id)}`;

      return `<a href="${taskHref}">
        <g class="node-group" data-task-id="${escapeHtml(task.id)}" transform="translate(${position.x} ${position.y})">
          <rect class="node-card" x="0" y="0" rx="26" ry="26" width="${nodeWidth}" height="${nodeHeight}" fill="rgba(7,16,25,0.85)" stroke="${stroke}" style="filter:${glow};" />
          <rect x="18" y="16" rx="14" ry="14" width="56" height="32" fill="${color}18" stroke="${color}" />
          <text x="33" y="37" class="node-subtitle" fill="${color}">${escapeHtml(task.status.toUpperCase())}</text>
          <circle cx="247" cy="31" r="12" class="status-ring" />
          <circle cx="247" cy="31" r="6" class="status-dot" fill="${color}" />
          <text x="18" y="66" class="node-title">${escapeHtml(task.title.slice(0, 29))}</text>
          <text x="18" y="88" class="node-subtitle">scope · ${scopeLabel}</text>
          <text x="18" y="106" class="node-foot">${summary}</text>
          <text x="230" y="105" class="node-foot" text-anchor="end">attempts ${task.attempts || 0}</text>
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

function buildInitialRunUi(payload: RunPayload, requestedTaskId?: string | null) {
  const tasks = normalizeServerTasks(payload);
  const selectedTask =
    tasks.find((task) => task.id === requestedTaskId) ||
    tasks[0] ||
    null;
  const taskArtifacts = selectedTask
    ? payload.artifacts.filter((artifact) => artifact.taskId === selectedTask.id)
    : [];
  const runId = encodeURIComponent(payload.run.id);

  const actionsHtml =
    payload.run.status === 'awaiting_plan_approval' && payload.plan?.status === 'proposed'
      ? `<form method="post" action="/runs/${runId}/approve-plan">
          <button class="primary" type="submit">Approve Plan</button>
        </form>
        <form method="post" action="/runs/${runId}/reject-plan">
          <input type="hidden" name="reason" value="Plan rejected from the local console." />
          <button class="danger" type="submit">Reject Plan</button>
        </form>`
      : payload.run.status === 'running' || payload.run.status === 'healing'
        ? `<form method="post" action="/runs/${runId}/cancel">
            <button class="secondary" type="submit">Cancel Active Run</button>
          </form>`
        : '';

  const metaHtml = [
    ['Status', renderStatusBadgeHtml(payload.run.status)],
    ['Mode', escapeHtml(payload.run.mode)],
    ['Branch', escapeHtml(payload.run.branchName)],
    ['Plan', payload.plan ? renderStatusBadgeHtml(payload.plan.status) : 'Missing'],
    ['Parallel', String(payload.run.maxParallelTasks)],
    ['Retries', String(payload.run.maxRetriesPerTask)],
    ['Tasks', String(tasks.length)],
    ['Events', String(payload.events.length)],
  ]
    .map(
      ([label, value]) =>
        `<div class="meta-card"><div class="meta-label">${label}</div><div class="meta-value">${value}</div></div>`,
    )
    .join('');

  const planMetaHtml = payload.plan
    ? [
        ['Run status', renderStatusBadgeHtml(payload.run.status)],
        ['Plan status', renderStatusBadgeHtml(payload.plan.status)],
        ['Created', formatDateTime(payload.plan.createdAt)],
        [
          'Approved',
          payload.plan.approvedAt
            ? `${formatDateTime(payload.plan.approvedAt)} · ${escapeHtml(payload.plan.approvedBy || 'unknown')}`
            : 'Pending',
        ],
        [
          'Rejected',
          payload.plan.rejectedAt
            ? `${formatDateTime(payload.plan.rejectedAt)} · ${escapeHtml(payload.plan.rejectedBy || 'unknown')}`
            : '—',
        ],
      ]
        .map(
          ([label, value]) =>
            `<div class="meta-card" style="margin-bottom:12px;"><div class="meta-label">${label}</div><div class="meta-value">${value}</div></div>`,
        )
        .join('') +
      `<div class="task-card"><div class="task-title">Plan Summary</div><pre>${escapeHtml(payload.plan.summary)}</pre></div>` +
      (payload.plan.rejectedReason
        ? `<div class="task-card"><div class="task-title">Rejected Because</div><pre>${escapeHtml(
            payload.plan.rejectedReason,
          )}</pre></div>`
        : '')
    : '<div class="muted">Plan not found.</div>';

  const eventsHtml = payload.events.length
    ? payload.events
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
            <div class="timeline-dot" style="background:${levelColor};"></div>
            <article class="event-card">
              <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;">
                <strong>${escapeHtml(event.type)}</strong>
                <span class="muted">${escapeHtml(formatDateTime(event.createdAt))}</span>
              </div>
              <div>${escapeHtml(event.message)}</div>
              ${event.payload ? `<pre>${escapeHtml(JSON.stringify(event.payload, null, 2))}</pre>` : ''}
            </article>
          </div>`;
        })
        .join('')
    : '<div class="event-card">No events yet.</div>';

  const inspectorHtml = selectedTask
    ? `<div class="task-card">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;">
          <div class="task-title">${escapeHtml(selectedTask.title)}</div>
          ${renderStatusBadgeHtml(selectedTask.status)}
        </div>
        <div class="chip-row">
          <span class="chip">${escapeHtml(selectedTask.kind || 'implement')}</span>
          <span class="chip">attempts ${escapeHtml(String(selectedTask.attempts || 0))}</span>
          ${'planOnly' in selectedTask && selectedTask.planOnly ? '<span class="chip">plan preview</span>' : ''}
        </div>
        <div class="chip-row">${(selectedTask.writeScope || ['.'])
          .map((scope) => `<span class="chip">${escapeHtml(scope)}</span>`)
          .join('')}</div>
        <div class="muted">${
          selectedTask.dependencies.length ? `Depends on ${selectedTask.dependencies.length} task(s)` : 'No dependencies'
        }</div>
        <pre>${escapeHtml(
          selectedTask.outputSummary || selectedTask.validationSummary || selectedTask.prompt || '',
        )}</pre>
      </div>`
    : '<div class="inspector-empty">Waiting for task selection…</div>';

  const artifactsHtml = taskArtifacts.length
    ? taskArtifacts
        .slice()
        .reverse()
        .map((artifact) => {
          const preview = artifact.content ? artifact.content.slice(0, 1000) : '(binary or path-only artifact)';
          return `<article class="artifact-card">
            <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;">
              <strong>${escapeHtml(artifact.type)}</strong>
              <span class="muted">${escapeHtml(formatDateTime(artifact.createdAt))}</span>
            </div>
            ${artifact.path ? `<div class="muted">${escapeHtml(artifact.path)}</div>` : ''}
            <pre>${escapeHtml(preview)}</pre>
          </article>`;
        })
        .join('')
    : '<div class="artifact-card">No artifacts stored for this task yet.</div>';

  const graph = buildServerGraph(payload.run.id, tasks, selectedTask?.id || null);

  const taskListHtml = tasks.length
    ? tasks
        .map((task) => {
          const active = selectedTask?.id === task.id;
          const href = `/runs/${encodeURIComponent(payload.run.id)}?task=${encodeURIComponent(task.id)}`;
          const dependencyCount = task.dependencies.length;
          return `<a class="task-list-item${active ? ' active' : ''}" href="${href}">
            <div class="task-list-top">
              <div class="task-list-title">${escapeHtml(task.title)}</div>
              ${renderStatusBadgeHtml(task.status)}
            </div>
            <div class="chip-row">
              <span class="chip">${escapeHtml(task.kind || 'implement')}</span>
              <span class="chip">attempts ${escapeHtml(String(task.attempts || 0))}</span>
              ${'planOnly' in task && task.planOnly ? '<span class="chip">plan preview</span>' : ''}
            </div>
            <div class="task-list-meta">
              <span>scope · ${escapeHtml((task.writeScope || ['.']).join(', '))}</span>
              <span>${dependencyCount ? `${dependencyCount} dependenc${dependencyCount === 1 ? 'y' : 'ies'}` : 'no dependencies'}</span>
            </div>
          </a>`;
        })
        .join('')
    : '<div class="task-list-empty">No tasks available yet.</div>';

  const graphSummaryHtml = [
    `<span class="chip">nodes ${tasks.length}</span>`,
    `<span class="chip">phases ${graph.phasesCount}</span>`,
    `<span class="chip">mode ${escapeHtml(payload.run.mode)}</span>`,
    `<span class="chip">events ${payload.events.length}</span>`,
  ].join('');

  const graphModeMessage =
    payload.run.status === 'awaiting_plan_approval'
      ? 'Awaiting approval before execution'
      : `Run is ${payload.run.status.replaceAll('_', ' ')}`;

  const graphSelectionMessage = selectedTask
    ? `Inspecting ${selectedTask.title}`
    : tasks.length
      ? 'Select a node to inspect it.'
      : 'Waiting for plan data';

  return {
    selectedTaskId: selectedTask?.id || null,
    actionsHtml,
    metaHtml,
    planMetaHtml,
    eventsHtml,
    inspectorHtml,
    artifactsHtml,
    graphSummaryHtml,
    graphModeMessage,
    graphSelectionMessage,
    graphSvgInner: graph.svgInner,
    graphViewBox: graph.viewBox,
    graphWidth: graph.width,
    graphHeight: graph.height,
    taskListHtml,
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

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }

  return JSON.parse(raw) as Record<string, unknown>;
}

async function readFormBody(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  return Object.fromEntries(new URLSearchParams(raw).entries());
}

function extractRunId(pathname: string, suffix = ''): string | null {
  const base = '/api/runs/';
  if (!pathname.startsWith(base)) {
    return null;
  }

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
  if (!pathname.startsWith(base)) {
    return null;
  }

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

    return {
      run,
      latestPlan,
      taskCounts: {
        pending: tasks.filter((task) => task.status === 'pending').length,
        running: tasks.filter((task) => task.status === 'running').length,
        succeeded: tasks.filter((task) => task.status === 'succeeded').length,
        failed: tasks.filter((task) => task.status === 'failed').length,
        blocked: tasks.filter((task) => task.status === 'blocked').length,
        skipped: tasks.filter((task) => task.status === 'skipped').length,
      },
    };
  });
}

function renderHomePage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Unity Command Deck</title>
    <style>
      :root {
        --bg-1: #0c1117;
        --bg-2: #141b24;
        --bg-3: #1a232e;
        --panel: rgba(17, 24, 33, 0.82);
        --panel-border: rgba(148, 163, 184, 0.14);
        --text: #edf2f7;
        --muted: #94a3b8;
        --accent: #cbd5e1;
        --accent-soft: rgba(203, 213, 225, 0.08);
        --success: #86efac;
        --warning: #facc15;
        --danger: #fb7185;
        --shadow: 0 24px 70px rgba(0, 0, 0, 0.36);
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Avenir Next", "SF Pro Display", "Segoe UI", sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(255,255,255,0.05), transparent 24%),
          radial-gradient(circle at bottom right, rgba(148,163,184,0.06), transparent 22%),
          linear-gradient(160deg, var(--bg-1) 0%, var(--bg-2) 54%, var(--bg-3) 100%);
      }

      body::before {
        content: '';
        position: fixed;
        inset: 0;
        background-image:
          linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px);
        background-size: 42px 42px;
        mask-image: radial-gradient(circle at center, black 30%, transparent 82%);
        pointer-events: none;
        opacity: 0.4;
      }

      .shell {
        position: relative;
        width: min(1240px, calc(100vw - 36px));
        margin: 28px auto 48px;
      }

      .hero, .card {
        background: var(--panel);
        border: 1px solid var(--panel-border);
        border-radius: 28px;
        backdrop-filter: blur(26px);
        box-shadow: var(--shadow);
      }

      .hero {
        padding: 28px;
        margin-bottom: 22px;
        overflow: hidden;
        position: relative;
      }

      .hero::after {
        content: '';
        position: absolute;
        width: 420px;
        height: 420px;
        right: -140px;
        top: -180px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(255,255,255,0.08) 0%, transparent 70%);
        pointer-events: none;
      }

      h1 {
        margin: 0 0 10px;
        font-size: clamp(34px, 5vw, 58px);
        letter-spacing: -0.04em;
        line-height: 0.95;
      }

      .subtle {
        margin: 0;
        color: var(--muted);
        max-width: 760px;
        line-height: 1.6;
      }

      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.08);
        color: var(--accent);
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        margin-bottom: 16px;
      }

      .hero-grid {
        display: grid;
        grid-template-columns: minmax(0, 1.2fr) 320px;
        gap: 20px;
        align-items: end;
      }

      .metric-stack {
        display: grid;
        gap: 12px;
      }

      .metric-card {
        padding: 16px 18px;
        border-radius: 22px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
      }

      .metric-label {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin-bottom: 8px;
      }

      .metric-value {
        font-size: 34px;
        font-weight: 800;
        line-height: 1;
      }

      .metric-note {
        font-size: 13px;
        color: var(--muted);
        margin-top: 8px;
      }

      .list {
        display: grid;
        gap: 16px;
      }

      .chat-card {
        display: grid;
        gap: 10px;
      }

      .chat-meta {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        color: var(--muted);
        font-size: 13px;
      }

      .bubble-row {
        display: flex;
      }

      .bubble-row.user {
        justify-content: flex-end;
      }

      .bubble-row.agent {
        justify-content: flex-start;
      }

      .card {
        padding: 18px 20px;
        display: grid;
        gap: 14px;
        position: relative;
        overflow: hidden;
        max-width: min(820px, 100%);
      }

      .bubble-user {
        margin-left: auto;
        background: linear-gradient(180deg, rgba(30,41,59,0.9), rgba(15,23,42,0.88));
      }

      .bubble-agent {
        background: linear-gradient(180deg, rgba(17,24,33,0.95), rgba(10,15,22,0.92));
      }

      .row {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: center;
        flex-wrap: wrap;
      }

      .title {
        font-size: 20px;
        font-weight: 800;
        position: relative;
        z-index: 1;
      }

      .badge {
        padding: 7px 11px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        background: var(--accent-soft);
        color: var(--accent);
        border: 1px solid rgba(255,255,255,0.08);
      }

      .meta {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        color: var(--muted);
        font-size: 14px;
      }

      a {
        color: var(--accent);
        text-decoration: none;
        font-weight: 800;
      }

      .link-chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        border-radius: 999px;
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.08);
      }

      .empty {
        padding: 36px;
        text-align: center;
        color: var(--muted);
      }

      .summary {
        position: relative;
        z-index: 1;
        color: rgba(238,247,255,0.92);
        line-height: 1.55;
      }

      .prompt-line {
        color: rgba(255,255,255,0.9);
        line-height: 1.55;
      }

      .feed-note {
        color: var(--muted);
        font-size: 13px;
      }

      @media (max-width: 920px) {
        .hero-grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="hero">
        <div class="hero-grid">
          <div>
            <div class="eyebrow">Unity Autonomous Deck</div>
            <h1>Plan first. Execute with intent.</h1>
            <p class="subtle">
              Revisa el DAG, aprueba planes interactivos y sigue la actividad multi-agent desde una consola local pensada para evolucionar más allá de Discord.
            </p>
          </div>
          <div class="metric-stack" id="hero-metrics">
            <div class="metric-card">
              <div class="metric-label">Awaiting Approval</div>
              <div class="metric-value">0</div>
              <div class="metric-note">Interactive runs paused after planning.</div>
            </div>
          </div>
        </div>
      </section>
      <section id="runs" class="list"></section>
    </main>
    <script>
      const statusColors = {
        queued: '#146c78',
        planning: '#146c78',
        awaiting_plan_approval: '#946200',
        plan_rejected: '#b33f33',
        running: '#146c78',
        healing: '#146c78',
        completed: '#1f7a4d',
        failed: '#b33f33',
        cancelled: '#7c8692',
      };

      function badge(status) {
        const color = statusColors[status] || '#146c78';
        return '<span class="badge" style="background:' + color + '18;color:' + color + ';">' + status.replaceAll('_', ' ') + '</span>';
      }

      function renderMetrics(items) {
        const awaiting = items.filter(({ run }) => run.status === 'awaiting_plan_approval').length;
        const active = items.filter(({ run }) => run.status === 'running' || run.status === 'healing').length;
        const completed = items.filter(({ run }) => run.status === 'completed').length;
        const failed = items.filter(({ run }) => run.status === 'failed').length;
        const container = document.getElementById('hero-metrics');

        container.innerHTML = [
          ['Awaiting Approval', awaiting, 'Interactive runs paused after planning.'],
          ['Live Runs', active, 'These runs are currently advancing tasks.'],
          ['Completed', completed, 'Healthy runs that closed their cycle.'],
          ['Failed', failed, 'Runs that need follow-up or replanning.'],
        ].map(function(metric) {
          return '<div class="metric-card">' +
            '<div class="metric-label">' + metric[0] + '</div>' +
            '<div class="metric-value">' + metric[1] + '</div>' +
            '<div class="metric-note">' + metric[2] + '</div>' +
          '</div>';
        }).join('');
      }

      function renderRuns(items) {
        const container = document.getElementById('runs');
        if (!items.length) {
          container.innerHTML = '<div class="card empty">Todavía no hay runs persistidos.</div>';
          return;
        }

        container.innerHTML = items.map(({ run, latestPlan, taskCounts }) => {
          const primaryAction = run.status === 'awaiting_plan_approval' ? 'Review plan' : 'Open command deck';
          return '<article class="chat-card">' +
            '<div class="chat-meta">' +
              '<div><strong>' + run.projectName + '</strong> · ' + run.id + '</div>' +
              '<div>' + new Date(run.updatedAt).toLocaleString() + '</div>' +
            '</div>' +
            '<div class="bubble-row user">' +
              '<div class="card bubble-user">' +
                '<div class="meta"><span>user request</span><span>mode: ' + run.mode + '</span></div>' +
                '<div class="prompt-line">' + run.prompt + '</div>' +
              '</div>' +
            '</div>' +
            '<div class="bubble-row agent">' +
              '<div class="card bubble-agent">' +
                '<div class="row">' +
                  '<div class="title">Unity Agent</div>' +
                  badge(run.status) +
                '</div>' +
                '<div class="summary">' + (latestPlan?.summary || run.summary || 'Waiting for plan synthesis.') + '</div>' +
                '<div class="meta">' +
                  '<span>plan: ' + (latestPlan ? latestPlan.status : 'missing') + '</span>' +
                  '<span>branch: ' + run.branchName + '</span>' +
                  '<span>ok: ' + taskCounts.succeeded + '</span>' +
                  '<span>failed: ' + taskCounts.failed + '</span>' +
                  '<span>blocked: ' + taskCounts.blocked + '</span>' +
                '</div>' +
                '<div class="feed-note">Open the run to inspect the graph, approval state and task details.</div>' +
                '<a class="link-chip" href="/runs/' + run.id + '">' + primaryAction + '</a>' +
              '</div>' +
            '</div>' +
          '</article>';
        }).join('');
      }

      async function loadRuns() {
        const response = await fetch('/api/runs');
        const items = await response.json();
        renderMetrics(items);
        renderRuns(items);
      }

      loadRuns();
      setInterval(loadRuns, 5000);
    </script>
  </body>
</html>`;
}

function renderRunPage(
  runId: string,
  initialPayload?: ReturnType<typeof buildRunPayload> | null,
  requestedTaskId?: string | null,
): string {
  const safeRunId = escapeHtml(runId);
  const initialSummary = initialPayload?.plan?.summary || initialPayload?.run?.summary || initialPayload?.run?.prompt || 'Loading run details...';
  const initialUi = initialPayload ? buildInitialRunUi(initialPayload, requestedTaskId) : null;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Unity Run ${safeRunId}</title>
    <style>
      :root {
        --bg-1: #0b1016;
        --bg-2: #121923;
        --bg-3: #19232f;
        --panel: rgba(16, 22, 30, 0.8);
        --panel-border: rgba(148, 163, 184, 0.14);
        --text: #edf2f7;
        --muted: #94a3b8;
        --accent: #cbd5e1;
        --accent-2: #94a3b8;
        --accent-3: #64748b;
        --success: #86efac;
        --warning: #facc15;
        --danger: #fb7185;
        --surface: rgba(255, 255, 255, 0.04);
        --surface-strong: rgba(255, 255, 255, 0.07);
        --shadow: 0 30px 80px rgba(0, 0, 0, 0.42);
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Avenir Next", "SF Pro Display", "Segoe UI", sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(255,255,255,0.05), transparent 20%),
          radial-gradient(circle at bottom right, rgba(148,163,184,0.06), transparent 24%),
          linear-gradient(150deg, var(--bg-1) 0%, var(--bg-2) 56%, var(--bg-3) 100%);
      }

      body::before {
        content: '';
        position: fixed;
        inset: 0;
        background-image:
          linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px);
        background-size: 40px 40px;
        mask-image: radial-gradient(circle at center, black 38%, transparent 90%);
        pointer-events: none;
        opacity: 0.4;
      }

      a { color: var(--accent); text-decoration: none; }

      .shell {
        position: relative;
        width: min(1400px, calc(100vw - 34px));
        margin: 20px auto 40px;
        display: grid;
        gap: 18px;
      }

      .panel {
        background: var(--panel);
        border: 1px solid var(--panel-border);
        border-radius: 28px;
        backdrop-filter: blur(24px);
        box-shadow: var(--shadow);
      }

      .hero {
        padding: 28px;
        display: grid;
        gap: 16px;
        overflow: hidden;
        position: relative;
      }

      .hero::after {
        content: '';
        position: absolute;
        right: -160px;
        top: -170px;
        width: 420px;
        height: 420px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(255,255,255,0.08) 0%, transparent 70%);
        pointer-events: none;
      }

      .hero-top {
        display: flex;
        justify-content: space-between;
        gap: 20px;
        flex-wrap: wrap;
        align-items: flex-start;
      }

      .hero h1 {
        margin: 8px 0 10px;
        font-size: clamp(32px, 4vw, 54px);
        letter-spacing: -0.04em;
        line-height: 0.94;
      }

      .subtle {
        color: var(--muted);
        line-height: 1.55;
      }

      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.08);
        color: var(--accent);
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }

      .meta-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 12px;
      }

      .meta-card, .task-card, .event-card, .artifact-card {
        background: var(--surface);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 20px;
      }

      .meta-card {
        padding: 14px 16px;
      }

      .meta-label {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--muted);
        margin-bottom: 6px;
      }

      .meta-value {
        font-size: 16px;
        font-weight: 700;
      }

      .actions {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        align-items: center;
      }

      button {
        border: 0;
        border-radius: 999px;
        padding: 12px 18px;
        font: inherit;
        font-weight: 800;
        cursor: pointer;
        transition: transform 140ms ease, opacity 140ms ease;
      }

      button:hover {
        transform: translateY(-1px);
      }

      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        transform: none;
      }

      .actions form {
        margin: 0;
      }

      .primary { background: linear-gradient(135deg, #e2e8f0, #94a3b8); color: #0f172a; }
      .secondary { background: rgba(255,255,255,0.07); color: var(--text); border: 1px solid rgba(255,255,255,0.08); }
      .danger { background: linear-gradient(135deg, #fb7185, #ef4444); color: white; }

      .layout {
        display: grid;
        grid-template-columns: minmax(0, 1.65fr) minmax(340px, 0.95fr);
        gap: 18px;
        align-items: start;
      }

      .stack {
        display: grid;
        gap: 18px;
      }

      .section {
        padding: 22px;
        display: grid;
        gap: 16px;
      }

      .section h2 {
        margin: 0;
        font-size: 20px;
      }

      .section-header {
        display: flex;
        justify-content: space-between;
        gap: 14px;
        flex-wrap: wrap;
        align-items: center;
      }

      .section-note {
        color: var(--muted);
        font-size: 14px;
      }

      .graph-shell {
        position: relative;
        min-height: 520px;
        border-radius: 24px;
        overflow: hidden;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.015)),
          radial-gradient(circle at top left, rgba(255,255,255,0.05), transparent 32%);
        border: 1px solid rgba(255,255,255,0.06);
      }

      .graph-shell::before {
        content: '';
        position: absolute;
        inset: 0;
        background-image:
          linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px);
        background-size: 28px 28px;
        opacity: 0.55;
        pointer-events: none;
      }

      .graph-toolbar {
        position: absolute;
        top: 16px;
        left: 16px;
        right: 16px;
        display: flex;
        justify-content: space-between;
        gap: 12px;
        z-index: 2;
        pointer-events: none;
      }

      .toolbar-chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 9px 12px;
        border-radius: 999px;
        background: rgba(4,16,25,0.7);
        border: 1px solid rgba(255,255,255,0.08);
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
      }

      .graph-scroll {
        overflow: auto;
        padding: 72px 20px 20px;
      }

      svg {
        display: block;
        min-width: 100%;
      }

      .lane-label {
        fill: rgba(255,255,255,0.92);
        font-size: 14px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .lane-sub {
        fill: var(--muted);
        font-size: 11px;
      }

      .edge {
        fill: none;
        stroke-width: 3;
        opacity: 0.68;
      }

      .node-group {
        cursor: pointer;
      }

      .node-card {
        stroke-width: 1.5;
      }

      .node-title {
        fill: white;
        font-size: 16px;
        font-weight: 800;
      }

      .node-subtitle,
      .node-foot {
        fill: rgba(241,248,255,0.78);
        font-size: 12px;
      }

      .status-ring {
        fill: rgba(255,255,255,0.12);
      }

      .status-dot {
        filter: drop-shadow(0 0 8px currentColor);
      }

      .inspector {
        position: sticky;
        top: 16px;
      }

      .inspector-stack {
        display: grid;
        gap: 16px;
      }

      .task-card {
        padding: 16px 18px;
        display: grid;
        gap: 10px;
      }

      .task-title {
        font-size: 17px;
        font-weight: 800;
      }

      .chip-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .chip {
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(255,255,255,0.06);
        color: var(--text);
        font-size: 12px;
        border: 1px solid rgba(255,255,255,0.08);
      }

      .event-list, .artifact-list {
        display: grid;
        gap: 12px;
        max-height: 420px;
        overflow: auto;
      }

      .event-card, .artifact-card {
        padding: 14px;
        display: grid;
        gap: 8px;
        position: relative;
      }

      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 13px;
        line-height: 1.45;
        font-family: "SFMono-Regular", "Consolas", monospace;
      }

      textarea {
        width: 100%;
        min-height: 88px;
        resize: vertical;
        border-radius: 18px;
        border: 1px solid rgba(255,255,255,0.1);
        padding: 14px;
        font: inherit;
        color: var(--text);
        background: rgba(255,255,255,0.05);
      }

      .status-badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        border: 1px solid rgba(255,255,255,0.08);
      }

      .muted {
        color: var(--muted);
      }

      .timeline {
        position: relative;
        display: grid;
        gap: 14px;
      }

      .timeline::before {
        content: '';
        position: absolute;
        left: 11px;
        top: 8px;
        bottom: 8px;
        width: 2px;
        background: linear-gradient(180deg, rgba(110,240,226,0.42), rgba(255,255,255,0.06));
      }

      .timeline-item {
        position: relative;
        padding-left: 30px;
      }

      .timeline-dot {
        position: absolute;
        left: 4px;
        top: 10px;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        border: 2px solid rgba(255,255,255,0.16);
        box-shadow: 0 0 0 6px rgba(255,255,255,0.02);
      }

      .inspector-empty {
        padding: 28px;
        text-align: center;
        color: var(--muted);
      }

      .artifact-mini {
        max-height: 280px;
        overflow: auto;
      }

      .task-list {
        display: grid;
        gap: 10px;
      }

      .task-list-item {
        display: grid;
        gap: 10px;
        padding: 14px 16px;
        border-radius: 18px;
        background: rgba(255,255,255,0.035);
        border: 1px solid rgba(255,255,255,0.08);
        transition: transform 140ms ease, border-color 140ms ease, background 140ms ease;
      }

      .task-list-item:hover {
        transform: translateY(-1px);
        border-color: rgba(255,255,255,0.18);
        background: rgba(255,255,255,0.05);
      }

      .task-list-item.active {
        border-color: rgba(255,255,255,0.32);
        background: rgba(255,255,255,0.07);
      }

      .task-list-top {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: flex-start;
      }

      .task-list-title {
        font-size: 15px;
        font-weight: 800;
        color: var(--text);
      }

      .task-list-meta {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        color: var(--muted);
        font-size: 12px;
      }

      .task-list-empty {
        padding: 18px;
        border-radius: 18px;
        background: rgba(255,255,255,0.035);
        border: 1px solid rgba(255,255,255,0.08);
        color: var(--muted);
      }

      .prompt-card {
        background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015));
      }

      @media (max-width: 980px) {
        .layout {
          grid-template-columns: 1fr;
        }

        .inspector {
          position: static;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="panel hero">
        <div class="hero-top">
          <div>
            <div class="eyebrow">Unity Interactive Command Deck</div>
            <a href="/">← Back to runs</a>
            <h1 id="hero-title">Run ${safeRunId}</h1>
            <div id="hero-summary" class="subtle">${escapeHtml(initialSummary)}</div>
          </div>
          <div class="actions" id="actions">${initialUi?.actionsHtml || ''}</div>
        </div>
        <div id="meta-grid" class="meta-grid">${initialUi?.metaHtml || ''}</div>
      </section>

      <section class="layout">
        <div class="stack">
          <section class="panel section">
              <div class="section-header">
                <div>
                  <h2>Execution Flow</h2>
                  <div class="section-note">Modern DAG view of the plan, dependencies and live task state.</div>
                </div>
              <div class="chip-row" id="graph-summary">${initialUi?.graphSummaryHtml || ''}</div>
            </div>
            <div class="graph-shell">
              <div class="graph-toolbar">
                <div class="toolbar-chip" id="graph-mode-chip">${escapeHtml(
                  initialUi?.graphModeMessage || 'Preparing graph…',
                )}</div>
                <div class="toolbar-chip" id="graph-selection-chip">${escapeHtml(
                  initialUi?.graphSelectionMessage || 'Select a node to inspect it.',
                )}</div>
              </div>
              <div class="graph-scroll">
                <svg
                  id="graph-stage"
                  role="img"
                  aria-label="Run task graph"
                  viewBox="${escapeHtml(initialUi?.graphViewBox || '0 0 1200 620')}"
                  width="${escapeHtml(String(initialUi?.graphWidth || 1200))}"
                  height="${escapeHtml(String(initialUi?.graphHeight || 620))}"
                >${initialUi?.graphSvgInner || ''}</svg>
              </div>
            </div>
          </section>

          <section class="panel section">
            <div class="section-header">
              <div>
                <h2>All Tasks</h2>
                <div class="section-note">Every task in the run, including plan-preview nodes before approval.</div>
              </div>
            </div>
            <div id="task-list" class="task-list">${initialUi?.taskListHtml || '<div class="task-list-empty">Loading tasks…</div>'}</div>
          </section>

          <section class="panel section prompt-card">
            <div class="section-header">
              <div>
                <h2>Run Prompt</h2>
                <div class="section-note">Original instruction that generated this plan.</div>
              </div>
            </div>
            <pre id="run-prompt">${escapeHtml(initialPayload?.run?.prompt || '')}</pre>
          </section>

          <section class="panel section">
            <div class="section-header">
              <div>
                <h2>Run Timeline</h2>
                <div class="section-note">Chronological stream of orchestration, validation and approval events.</div>
              </div>
            </div>
            <div id="events" class="timeline">${initialUi?.eventsHtml || ''}</div>
          </section>
        </div>

        <aside class="inspector">
          <div class="inspector-stack">
            <section class="panel section">
              <div class="section-header">
                <div>
                  <h2>Plan Lifecycle</h2>
                  <div class="section-note">Approval gate and execution posture for this run.</div>
                </div>
              </div>
              <div id="plan-meta">${initialUi?.planMetaHtml || ''}</div>
            </section>

            <section class="panel section">
              <div class="section-header">
                <div>
                  <h2>Selected Task</h2>
                  <div class="section-note">Click a node in the flowchart to inspect details here.</div>
                </div>
              </div>
              <div id="task-inspector">${initialUi?.inspectorHtml || '<div class="inspector-empty">Waiting for task selection…</div>'}</div>
            </section>

            <section class="panel section">
              <div class="section-header">
                <div>
                  <h2>Task Artifacts</h2>
                  <div class="section-note">Diffs, gate snapshots and other stored outputs for the selected task.</div>
                </div>
              </div>
              <div id="task-artifacts" class="artifact-mini">${initialUi?.artifactsHtml || ''}</div>
            </section>

            <section class="panel section">
              <div class="section-header">
                <div>
                  <h2>Reject Reason</h2>
                  <div class="section-note">Only used while the plan is waiting for approval.</div>
                </div>
              </div>
              <textarea id="reject-reason" placeholder="Explain why this plan should be rejected."></textarea>
            </section>
          </div>
        </aside>
      </section>
    </main>
    <script>
      const runId = ${JSON.stringify(runId)};
      const initialPayload = ${serializeForScript(initialPayload || null)};
      const initialSelectedTaskId = ${serializeForScript(initialUi?.selectedTaskId || null)};
      const statusColors = {
        queued: '#94a3b8',
        planning: '#cbd5e1',
        awaiting_plan_approval: '#facc15',
        plan_rejected: '#fb7185',
        running: '#e2e8f0',
        healing: '#cbd5e1',
        completed: '#86efac',
        failed: '#fb7185',
        cancelled: '#64748b',
        pending: '#facc15',
        succeeded: '#86efac',
        blocked: '#fb7185',
        skipped: '#64748b',
      };
      let latestPayload = null;
      let selectedTaskId = initialSelectedTaskId;

      function safe(value) {
        return String(value || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function statusBadge(status) {
        const color = statusColors[status] || '#146c78';
        return '<span class="status-badge" style="background:' + color + '18;color:' + color + ';">' + status.replaceAll('_', ' ') + '</span>';
      }

      function statusColor(status) {
        return statusColors[status] || '#cbd5e1';
      }

      function setGraphChrome(modeMessage, selectionMessage) {
        const modeChip = document.getElementById('graph-mode-chip');
        const selectionChip = document.getElementById('graph-selection-chip');
        if (modeChip) modeChip.textContent = modeMessage;
        if (selectionChip) selectionChip.textContent = selectionMessage;
      }

      function formatDate(value) {
        if (!value) return '—';
        return new Date(value).toLocaleString();
      }

      function normalizeTasks(run, plan, tasks) {
        if (tasks && tasks.length) {
          return tasks.slice().sort(function(left, right) {
            return left.orderIndex - right.orderIndex;
          });
        }

        const drafts = plan && plan.rawPlan && Array.isArray(plan.rawPlan.tasks) ? plan.rawPlan.tasks : [];
        const titleToId = {};

        drafts.forEach(function(task, index) {
          titleToId[task.title] = 'draft-' + index;
        });

        return drafts.map(function(task, index) {
          return {
            id: titleToId[task.title] || ('draft-' + index),
            runId: run.id,
            title: task.title,
            prompt: task.prompt,
            role: task.role || 'executor',
            kind: task.kind || 'implement',
            status: run.status === 'plan_rejected' ? 'blocked' : 'pending',
            writeScope: Array.isArray(task.writeScope) ? task.writeScope : ['.'],
            dependencies: Array.isArray(task.dependencies)
              ? task.dependencies.map(function(dependencyTitle) { return titleToId[dependencyTitle]; }).filter(Boolean)
              : [],
            attempts: 0,
            branchName: null,
            worktreePath: null,
            commitSha: null,
            commitMessage: null,
            outputSummary: task.rationale || null,
            validationSummary: null,
            orderIndex: index,
            createdAt: run.createdAt,
            updatedAt: run.updatedAt,
            startedAt: null,
            finishedAt: null,
            planOnly: true,
          };
        });
      }

      function buildLevels(tasks) {
        const byId = new Map(tasks.map(function(task) { return [task.id, task]; }));
        const levelMemo = new Map();

        function computeLevel(taskId, trail) {
          if (levelMemo.has(taskId)) {
            return levelMemo.get(taskId);
          }

          if (trail.has(taskId)) {
            return 0;
          }

          const task = byId.get(taskId);
          if (!task) {
            return 0;
          }

          trail.add(taskId);
          const deps = (task.dependencies || []).filter(function(dependencyId) { return byId.has(dependencyId); });
          const level = deps.length
            ? Math.max.apply(null, deps.map(function(dependencyId) { return computeLevel(dependencyId, trail); })) + 1
            : 0;
          trail.delete(taskId);
          levelMemo.set(taskId, level);
          return level;
        }

        tasks.forEach(function(task) {
          computeLevel(task.id, new Set());
        });

        const levels = [];
        tasks.forEach(function(task) {
          const level = levelMemo.get(task.id) || 0;
          if (!levels[level]) {
            levels[level] = [];
          }
          levels[level].push(task);
        });

        levels.forEach(function(column) {
          column.sort(function(left, right) {
            return left.orderIndex - right.orderIndex;
          });
        });

        return levels.filter(Boolean);
      }

      function truncate(value, maxLength) {
        const input = String(value || '');
        return input.length > maxLength ? input.slice(0, maxLength - 1) + '…' : input;
      }

      function renderGraph(tasks, run) {
        const stage = document.getElementById('graph-stage');
        const graphSummary = document.getElementById('graph-summary');
        const modeChip = document.getElementById('graph-mode-chip');
        const selectionChip = document.getElementById('graph-selection-chip');

        if (!tasks.length) {
          stage.setAttribute('viewBox', '0 0 900 420');
          stage.innerHTML = '<text x="100" y="180" class="lane-label">No tasks yet</text><text x="100" y="212" class="lane-sub">The plan exists but no nodes were generated.</text>';
          graphSummary.innerHTML = '';
          setGraphChrome('No DAG available', 'Waiting for plan data');
          return;
        }

        const levels = buildLevels(tasks);
        const nodeWidth = 286;
        const nodeHeight = 118;
        const columnGap = 170;
        const rowGap = 168;
        const marginX = 88;
        const marginY = 100;
        const positions = new Map();
        let maxRows = 1;

        levels.forEach(function(column, columnIndex) {
          maxRows = Math.max(maxRows, column.length);
          column.forEach(function(task, rowIndex) {
            positions.set(task.id, {
              x: marginX + columnIndex * (nodeWidth + columnGap),
              y: marginY + rowIndex * rowGap,
            });
          });
        });

        const width = marginX * 2 + Math.max(1, levels.length) * nodeWidth + Math.max(0, levels.length - 1) * columnGap;
        const height = marginY + maxRows * rowGap + 80;
        stage.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
        stage.setAttribute('width', String(width));
        stage.setAttribute('height', String(height));

        const laneLabels = levels.map(function(column, index) {
          const x = marginX + index * (nodeWidth + columnGap);
          return '<text x="' + x + '" y="46" class="lane-label">Phase ' + (index + 1) + '</text>' +
            '<text x="' + x + '" y="68" class="lane-sub">' + column.length + ' node(s)</text>';
        }).join('');

        const edges = tasks.flatMap(function(task) {
          const target = positions.get(task.id);
          if (!target) return [];

          return (task.dependencies || []).map(function(dependencyId) {
            const source = positions.get(dependencyId);
            if (!source) return '';
            const startX = source.x + nodeWidth;
            const startY = source.y + nodeHeight / 2;
            const endX = target.x;
            const endY = target.y + nodeHeight / 2;
            const curve = Math.max(56, (endX - startX) / 2);
            return '<path class="edge" stroke="rgba(203,213,225,0.38)" d="M ' + startX + ' ' + startY +
              ' C ' + (startX + curve) + ' ' + startY + ', ' + (endX - curve) + ' ' + endY + ', ' + endX + ' ' + endY + '" />';
          });
        }).join('');

        const nodes = tasks.map(function(task) {
          const position = positions.get(task.id);
          const color = statusColor(task.status);
          const active = selectedTaskId === task.id;
          const stroke = active ? '#ffffff' : 'rgba(255,255,255,0.1)';
          const glow = active ? '0 0 18px rgba(255,255,255,0.22)' : 'none';
          const scopeLabel = truncate((task.writeScope || ['.']).join(', '), 34);
          const summary = truncate(task.outputSummary || task.validationSummary || task.prompt, 74);
          const attempts = task.attempts || 0;
          return '<g class="node-group" data-task-id="' + safe(task.id) + '" transform="translate(' + position.x + ' ' + position.y + ')">' +
            '<rect class="node-card" x="0" y="0" rx="26" ry="26" width="' + nodeWidth + '" height="' + nodeHeight + '" fill="rgba(7,16,25,0.85)" stroke="' + stroke + '" style="filter:' + glow + ';" />' +
            '<rect x="18" y="16" rx="14" ry="14" width="56" height="32" fill="' + color + '18" stroke="' + color + '" />' +
            '<text x="33" y="37" class="node-subtitle" fill="' + color + '">' + safe(task.status.toUpperCase()) + '</text>' +
            '<circle cx="247" cy="31" r="12" class="status-ring" />' +
            '<circle cx="247" cy="31" r="6" class="status-dot" fill="' + color + '" />' +
            '<text x="18" y="66" class="node-title">' + safe(truncate(task.title, 29)) + '</text>' +
            '<text x="18" y="88" class="node-subtitle">scope · ' + safe(scopeLabel) + '</text>' +
            '<text x="18" y="106" class="node-foot">' + safe(summary) + '</text>' +
            '<text x="230" y="105" class="node-foot" text-anchor="end">attempts ' + attempts + '</text>' +
          '</g>';
        }).join('');

        stage.innerHTML = laneLabels + edges + nodes;
        graphSummary.innerHTML = [
          '<span class="chip">nodes ' + tasks.length + '</span>',
          '<span class="chip">phases ' + levels.length + '</span>',
          '<span class="chip">mode ' + safe(run.mode) + '</span>',
        ].join('');
        const selectedTask = tasks.find(function(task) { return task.id === selectedTaskId; });
        setGraphChrome(
          run.status === 'awaiting_plan_approval'
            ? 'Awaiting approval before execution'
            : 'Run is ' + run.status.replaceAll('_', ' '),
          selectedTask
          ? 'Inspecting ' + selectedTask.title
          : 'Select a node to inspect it.',
        );

        stage.querySelectorAll('[data-task-id]').forEach(function(node) {
          node.addEventListener('click', function() {
            selectedTaskId = node.getAttribute('data-task-id');
            syncSelectedTaskInUrl();
            renderAll();
          });
        });
      }

      function syncSelectedTaskInUrl() {
        const url = new URL(window.location.href);
        if (selectedTaskId) {
          url.searchParams.set('task', selectedTaskId);
        } else {
          url.searchParams.delete('task');
        }
        window.history.replaceState({}, '', url.toString());
      }

      async function sendAction(path, body) {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error || 'Request failed');
        }

        return payload;
      }

      function renderActions(run, plan) {
        const actions = document.getElementById('actions');
        const parts = [];

        if (run.status === 'awaiting_plan_approval' && plan?.status === 'proposed') {
          parts.push('<button class="primary" id="approve-plan">Approve Plan</button>');
          parts.push('<button class="danger" id="reject-plan">Reject Plan</button>');
        }

        if (run.status === 'running' || run.status === 'healing') {
          parts.push('<button class="secondary" id="cancel-run">Cancel Active Run</button>');
        }

        actions.innerHTML = parts.join('');

        const approveButton = document.getElementById('approve-plan');
        if (approveButton) {
          approveButton.onclick = async () => {
            approveButton.disabled = true;
            await sendAction('/api/runs/' + runId + '/approve-plan', {});
            await loadRun();
          };
        }

        const rejectButton = document.getElementById('reject-plan');
        if (rejectButton) {
          rejectButton.onclick = async () => {
            rejectButton.disabled = true;
            await sendAction('/api/runs/' + runId + '/reject-plan', {
              reason: document.getElementById('reject-reason').value || 'Plan rejected from the local console.',
            });
            await loadRun();
          };
        }

        const cancelButton = document.getElementById('cancel-run');
        if (cancelButton) {
          cancelButton.onclick = async () => {
            cancelButton.disabled = true;
            await sendAction('/api/runs/' + runId + '/cancel', {});
            await loadRun();
          };
        }
      }

      function renderMeta(run, plan, tasks) {
        const grid = document.getElementById('meta-grid');
        const counts = {
          succeeded: tasks.filter((task) => task.status === 'succeeded').length,
          failed: tasks.filter((task) => task.status === 'failed').length,
          blocked: tasks.filter((task) => task.status === 'blocked').length,
          pending: tasks.filter((task) => task.status === 'pending').length,
          running: tasks.filter((task) => task.status === 'running').length,
        };

        const cards = [
          ['Status', statusBadge(run.status)],
          ['Mode', run.mode],
          ['Branch', run.branchName],
          ['Plan', plan ? statusBadge(plan.status) : 'Missing'],
          ['Parallel', String(run.maxParallelTasks)],
          ['Retries', String(run.maxRetriesPerTask)],
          ['Succeeded', String(counts.succeeded)],
          ['Running', String(counts.running)],
          ['Failed', String(counts.failed)],
          ['Blocked', String(counts.blocked)],
          ['Pending', String(counts.pending)],
        ];

        grid.innerHTML = cards.map(([label, value]) =>
          '<div class="meta-card"><div class="meta-label">' + label + '</div><div class="meta-value">' + value + '</div></div>'
        ).join('');
      }

      function renderEvents(events) {
        const container = document.getElementById('events');
        container.innerHTML = events.slice().reverse().map((event) => {
          const levelColor = event.level === 'error'
            ? statusColor('failed')
            : event.level === 'warning'
              ? statusColor('pending')
              : statusColor('running');

          return '<div class="timeline-item">' +
            '<div class="timeline-dot" style="background:' + levelColor + ';"></div>' +
            '<article class="event-card">' +
              '<div style="display:flex;justify-content:space-between;gap:12px;align-items:center;">' +
                '<strong>' + safe(event.type) + '</strong>' +
                '<span class="muted">' + formatDate(event.createdAt) + '</span>' +
              '</div>' +
              '<div>' + safe(event.message) + '</div>' +
              (event.payload ? '<pre>' + safe(JSON.stringify(event.payload, null, 2)) + '</pre>' : '') +
            '</article>' +
          '</div>';
        }).join('') || '<div class="event-card">No events yet.</div>';
      }

      function renderPlanMeta(run, plan, tasks) {
        const container = document.getElementById('plan-meta');
        if (!plan) {
          container.innerHTML = '<div class="muted">Plan not found.</div>';
          return;
        }

        const runStateCards = [
          ['Run status', statusBadge(run.status)],
          ['Plan status', statusBadge(plan.status)],
          ['Created', formatDate(plan.createdAt)],
          ['Approved', plan.approvedAt ? (formatDate(plan.approvedAt) + ' · ' + (plan.approvedBy || 'unknown')) : 'Pending'],
          ['Rejected', plan.rejectedAt ? (formatDate(plan.rejectedAt) + ' · ' + (plan.rejectedBy || 'unknown')) : '—'],
          ['Tasks in view', String(tasks.length)],
        ];

        container.innerHTML =
          runStateCards.map(function(item) {
            return '<div class="meta-card" style="margin-bottom:12px;">' +
              '<div class="meta-label">' + item[0] + '</div>' +
              '<div class="meta-value">' + item[1] + '</div>' +
            '</div>';
          }).join('') +
          '<div class="task-card">' +
            '<div class="task-title">Plan Summary</div>' +
            '<pre>' + safe(plan.summary) + '</pre>' +
          '</div>' +
          (plan.rejectedReason
            ? '<div class="task-card"><div class="task-title">Rejected Because</div><pre>' + safe(plan.rejectedReason) + '</pre></div>'
            : '');
      }

      function renderTaskList(tasks) {
        const container = document.getElementById('task-list');
        if (!container) {
          return;
        }

        if (!tasks.length) {
          container.innerHTML = '<div class="task-list-empty">No tasks available yet.</div>';
          return;
        }

        container.innerHTML = tasks.map(function(task) {
          const active = selectedTaskId === task.id;
          const dependencyCount = (task.dependencies || []).length;
          return '<button type="button" class="task-list-item' + (active ? ' active' : '') + '" data-task-list-id="' + safe(task.id) + '">' +
            '<div class="task-list-top">' +
              '<div class="task-list-title">' + safe(task.title) + '</div>' +
              statusBadge(task.status) +
            '</div>' +
            '<div class="chip-row">' +
              '<span class="chip">' + safe(task.kind || 'implement') + '</span>' +
              '<span class="chip">attempts ' + safe(task.attempts || 0) + '</span>' +
              (task.planOnly ? '<span class="chip">plan preview</span>' : '') +
            '</div>' +
            '<div class="task-list-meta">' +
              '<span>scope · ' + safe((task.writeScope || ['.']).join(', ')) + '</span>' +
              '<span>' + (dependencyCount ? (dependencyCount + ' dependenc' + (dependencyCount === 1 ? 'y' : 'ies')) : 'no dependencies') + '</span>' +
            '</div>' +
          '</button>';
        }).join('');

        container.querySelectorAll('[data-task-list-id]').forEach(function(button) {
          button.addEventListener('click', function() {
            selectedTaskId = button.getAttribute('data-task-list-id');
            syncSelectedTaskInUrl();
            renderAll();
          });
        });
      }

      function renderTaskInspector(tasks, artifacts, events) {
        const container = document.getElementById('task-inspector');
        const artifactContainer = document.getElementById('task-artifacts');

        if (!tasks.length) {
          container.innerHTML = '<div class="inspector-empty">No task data available yet.</div>';
          artifactContainer.innerHTML = '<div class="artifact-card">No task artifacts yet.</div>';
          return;
        }

        if (!selectedTaskId || !tasks.some(function(task) { return task.id === selectedTaskId; })) {
          selectedTaskId = tasks[0].id;
        }

        const task = tasks.find(function(candidate) { return candidate.id === selectedTaskId; });
        if (!task) {
          container.innerHTML = '<div class="inspector-empty">Selected task is no longer available.</div>';
          artifactContainer.innerHTML = '<div class="artifact-card">No task artifacts yet.</div>';
          return;
        }

        const dependencyTitles = (task.dependencies || []).map(function(dependencyId) {
          const dependency = tasks.find(function(candidate) { return candidate.id === dependencyId; });
          return dependency ? dependency.title : dependencyId;
        });
        const scopedArtifacts = artifacts.filter(function(artifact) { return artifact.taskId === task.id; });
        const relatedEvents = events
          .filter(function(event) { return event.taskId === task.id; })
          .slice(-4)
          .reverse();

        container.innerHTML =
          '<div class="task-card">' +
            '<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;">' +
              '<div class="task-title">' + safe(task.title) + '</div>' +
              statusBadge(task.status) +
            '</div>' +
            '<div class="chip-row">' +
              '<span class="chip">' + safe(task.kind || 'implement') + '</span>' +
              '<span class="chip">attempts ' + safe(task.attempts || 0) + '</span>' +
              (task.planOnly ? '<span class="chip">plan preview</span>' : '') +
            '</div>' +
            '<div class="chip-row">' + (task.writeScope || ['.']).map(function(scope) {
              return '<span class="chip">' + safe(scope) + '</span>';
            }).join('') + '</div>' +
            '<div class="muted">' + (dependencyTitles.length ? 'Depends on: ' + dependencyTitles.join(', ') : 'No dependencies') + '</div>' +
            '<pre>' + safe(task.outputSummary || task.validationSummary || task.prompt || '') + '</pre>' +
            (task.commitMessage ? '<div class="meta-card"><div class="meta-label">Commit</div><div class="meta-value">' + safe(task.commitMessage) + '</div></div>' : '') +
            (relatedEvents.length
              ? '<div class="meta-card"><div class="meta-label">Recent task events</div><pre>' + safe(relatedEvents.map(function(event) {
                  return '[' + formatDate(event.createdAt) + '] ' + event.type + ' → ' + event.message;
                }).join('\n\n')) + '</pre></div>'
              : '') +
          '</div>';

        artifactContainer.innerHTML = scopedArtifacts.length
          ? scopedArtifacts.slice().reverse().map(function(artifact) {
              const preview = artifact.content ? artifact.content.slice(0, 1000) : '(binary or path-only artifact)';
              return '<article class="artifact-card">' +
                '<div style="display:flex;justify-content:space-between;gap:12px;align-items:center;">' +
                  '<strong>' + safe(artifact.type) + '</strong>' +
                  '<span class="muted">' + formatDate(artifact.createdAt) + '</span>' +
                '</div>' +
                (artifact.path ? '<div class="muted">' + safe(artifact.path) + '</div>' : '') +
                '<pre>' + safe(preview) + '</pre>' +
              '</article>';
            }).join('')
          : '<div class="artifact-card">No artifacts stored for this task yet.</div>';
      }

      function renderAll() {
        if (!latestPayload) {
          return;
        }

        try {
          const run = latestPayload.run;
          const plan = latestPayload.plan;
          const tasks = normalizeTasks(run, plan, latestPayload.tasks || []);
          const events = latestPayload.events || [];
          const artifacts = latestPayload.artifacts || [];

          document.getElementById('hero-title').textContent = run.projectName + ' · ' + run.id;
          document.getElementById('hero-summary').textContent = plan && plan.summary ? plan.summary : (run.summary || run.prompt);
          document.getElementById('run-prompt').textContent = run.prompt;
          renderActions(run, plan);
          renderMeta(run, plan, tasks);
          renderGraph(tasks, run);
          renderTaskList(tasks);
          renderEvents(events);
          renderPlanMeta(run, plan, tasks);
          renderTaskInspector(tasks, artifacts, events);
        } catch (error) {
          console.error('renderAll failed', error);
          setGraphChrome('Graph render failed', error && error.message ? error.message : 'Unknown render error');
        }
      }

      async function loadRun() {
        setGraphChrome('Loading graph…', 'Waiting for run data');
        try {
          const response = await fetch('/api/runs/' + runId);
          const payload = await response.json();

          if (!response.ok) {
            document.getElementById('hero-summary').textContent = payload.error || 'Run not found.';
            setGraphChrome('Run load failed', payload.error || 'Run not found');
            return;
          }

          latestPayload = payload;
          renderAll();
        } catch (error) {
          console.error('loadRun failed', error);
          document.getElementById('hero-summary').textContent = 'Failed to load run data.';
          setGraphChrome('Run load failed', error && error.message ? error.message : 'Network or parsing error');
        }
      }

      if (initialPayload) {
        latestPayload = initialPayload;
        renderAll();
      } else {
        loadRun();
      }

      setTimeout(loadRun, initialPayload ? 600 : 0);
      setInterval(loadRun, 5000);
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
        sendHtml(res, renderHomePage());
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
