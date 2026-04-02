import { createDeepseekChatCompletion } from '../ai/client.js';
import { parseJsonObject } from '../ai/edit-operations.js';
import type { GateResult, PlanTaskDraft, ReviewFinding, ReviewResult } from '../../domain/orchestration.js';

interface ReviewTaskParams {
  runPrompt: string;
  taskTitle: string;
  diff: string;
  gateResults: GateResult[];
}

interface PartialReviewResult {
  approved?: unknown;
  summary?: unknown;
  findings?: unknown;
  followUpTasks?: unknown;
}

function getGateByName(gateResults: GateResult[], name: string): GateResult | undefined {
  return gateResults.find((gate) => gate.name === name);
}

function shouldApproveFromGates(gateResults: GateResult[]): boolean {
  const scopeGate = getGateByName(gateResults, 'scope');
  if (scopeGate?.status === 'failed') {
    return false;
  }

  const baselineDeltaGate = getGateByName(gateResults, 'baseline-delta');
  if (baselineDeltaGate?.status === 'failed') {
    return false;
  }

  return true;
}

function normalizeWriteScope(writeScope: unknown): string[] {
  if (!Array.isArray(writeScope) || writeScope.length === 0) {
    return ['.'];
  }

  const normalized = writeScope
    .map((scope) => (typeof scope === 'string' ? scope.trim().replace(/^\.?\//, '').replace(/\/+$/, '') : ''))
    .filter(Boolean);

  return normalized.length ? normalized : ['.'];
}

function normalizeDependencies(dependencies: unknown): string[] {
  if (!Array.isArray(dependencies)) {
    return [];
  }

  return dependencies
    .map((dependency) => (typeof dependency === 'string' ? dependency.trim() : ''))
    .filter(Boolean);
}

function normalizeFinding(finding: unknown): ReviewFinding | null {
  if (!finding || typeof finding !== 'object') {
    return null;
  }

  const record = finding as Record<string, unknown>;
  const severity =
    record.severity === 'high' || record.severity === 'medium' || record.severity === 'low'
      ? record.severity
      : 'low';
  const message = typeof record.message === 'string' ? record.message.trim() : '';

  if (!message) {
    return null;
  }

  const normalized: ReviewFinding = {
    severity,
    message,
  };

  if (typeof record.file === 'string' && record.file.trim()) {
    normalized.file = record.file.trim();
  }

  return normalized;
}

function normalizeFollowUpTask(task: unknown): PlanTaskDraft | null {
  if (!task || typeof task !== 'object') {
    return null;
  }

  const record = task as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';

  if (!title || !prompt) {
    return null;
  }

  const kind =
    record.kind === 'implement' || record.kind === 'improve' || record.kind === 'heal'
      ? record.kind
      : 'improve';

  return {
    title,
    prompt,
    role: 'executor',
    kind,
    writeScope: normalizeWriteScope(record.writeScope),
    dependencies: normalizeDependencies(record.dependencies),
    rationale: typeof record.rationale === 'string' ? record.rationale.trim() : undefined,
  };
}

function coerceReviewResult(review: PartialReviewResult): ReviewResult {
  return {
    approved: Boolean(review.approved),
    summary:
      typeof review.summary === 'string' && review.summary.trim()
        ? review.summary.trim()
        : 'Review completed.',
    findings: Array.isArray(review.findings)
      ? review.findings.map(normalizeFinding).filter((finding): finding is ReviewFinding => Boolean(finding))
      : [],
    followUpTasks: Array.isArray(review.followUpTasks)
      ? review.followUpTasks
          .map(normalizeFollowUpTask)
          .filter((task): task is PlanTaskDraft => Boolean(task))
      : [],
  };
}

function parseReviewResponse(content: string): ReviewResult {
  return coerceReviewResult(parseJsonObject<PartialReviewResult>(content));
}

async function repairReviewResponse(rawContent: string): Promise<ReviewResult> {
  const response = await createDeepseekChatCompletion({
    model: 'deepseek-chat',
    temperature: 0,
    max_tokens: 900,
    response_format: { type: 'json_object' } as any,
    messages: [
      {
        role: 'user',
        content: `Normalize the following reviewer output into one strict JSON object.
Return JSON only.

Required shape:
{
  "approved": true,
  "summary": "short review summary",
  "findings": [
    { "severity": "low|medium|high", "message": "finding", "file": "optional/file.ts" }
  ],
  "followUpTasks": [
    {
      "title": "optional improvement task",
      "prompt": "executor prompt",
      "role": "executor",
      "kind": "implement|improve|heal",
      "writeScope": ["path"],
      "dependencies": [],
      "rationale": "why"
    }
  ]
}

Reviewer output:
${rawContent || '(empty)'}`,
      },
    ],
  });

  return parseReviewResponse(response.choices[0]?.message?.content || '');
}

function extractChangedFiles(diff: string): string[] {
  return Array.from(
    new Set(
      diff
        .split('\n')
        .filter((line) => line.startsWith('+++ b/'))
        .map((line) => line.replace('+++ b/', '').trim())
        .filter((filePath) => filePath && filePath !== '/dev/null'),
    ),
  );
}

function buildDeterministicFallbackReview(params: ReviewTaskParams): ReviewResult {
  const approved = shouldApproveFromGates(params.gateResults);
  const findings: ReviewFinding[] = [];
  const changedFiles = extractChangedFiles(params.diff);
  const failedGates = params.gateResults.filter((gate) => gate.status === 'failed');

  for (const gate of failedGates) {
    const severity =
      gate.name === 'scope' || gate.name === 'baseline-delta'
        ? 'high'
        : gate.name === 'runtime'
          ? 'medium'
          : 'low';

    findings.push({
      severity,
      message: `${gate.name} gate failed: ${gate.details}`,
    });
  }

  if (changedFiles.length > 8) {
    findings.push({
      severity: 'low',
      message: `Task touched ${changedFiles.length} files. Consider splitting future work into smaller slices.`,
    });
  }

  if (/\b(TODO|FIXME|HACK)\b/.test(params.diff)) {
    findings.push({
      severity: 'low',
      message: 'Diff contains TODO/FIXME/HACK markers that may need cleanup before merge.',
    });
  }

  const authoritativeSummary = approved
    ? 'Approved by authoritative deterministic gates.'
    : 'Rejected by authoritative deterministic gates.';
  const failedGateSummary = failedGates.length
    ? ` Failed gates: ${failedGates.map((gate) => gate.name).join(', ')}.`
    : ' No authoritative gate failures detected.';
  const changedFilesSummary = changedFiles.length
    ? ` Changed files: ${changedFiles.slice(0, 5).join(', ')}${changedFiles.length > 5 ? ', ...' : ''}.`
    : '';

  return {
    approved,
    summary: `${authoritativeSummary}${failedGateSummary}${changedFilesSummary}`.trim(),
    findings,
    followUpTasks: [],
  };
}

function buildReviewPrompt({ runPrompt, taskTitle, diff, gateResults }: ReviewTaskParams): string {
  return `You are the reviewer agent of Unity.
Review this autonomous task result.

RUN GOAL
${runPrompt}

TASK
${taskTitle}

GATES
${gateResults.map((gate) => `- ${gate.name}: ${gate.status} -> ${gate.details}`).join('\n')}

REVIEW RULES
- Treat the "scope" gate as a hard boundary. If it fails, reject the task.
- Treat the "baseline-delta" gate as the authoritative signal for newly introduced static gate regressions.
- Do not reject a task only because a normal gate is failing if that same gate was already failing in baseline and "baseline-delta" passed.

DIFF
\`\`\`diff
${diff.substring(0, 12000)}
\`\`\`

Return JSON only:
{
  "approved": true,
  "summary": "short review summary",
  "findings": [
    { "severity": "low|medium|high", "message": "finding", "file": "optional/file.ts" }
  ],
  "followUpTasks": [
    {
      "title": "optional improvement task",
      "prompt": "executor prompt",
      "role": "executor",
      "kind": "improve",
      "writeScope": ["path"],
      "dependencies": [],
      "rationale": "why"
    }
  ]
}`;
}

export async function reviewTaskResult(params: ReviewTaskParams): Promise<ReviewResult> {
  if (!params.diff.trim()) {
    return {
      approved: true,
      summary: 'No diff generated by task.',
      findings: [],
      followUpTasks: [],
    };
  }

  let rawReviewerContent = '';

  try {
    const response = await createDeepseekChatCompletion({
      model: 'deepseek-chat',
      temperature: 0,
      max_tokens: 1800,
      response_format: { type: 'json_object' } as any,
      messages: [{ role: 'user', content: buildReviewPrompt(params) }],
    });

    rawReviewerContent = response.choices[0]?.message?.content || '';
    return parseReviewResponse(rawReviewerContent);
  } catch (error) {
    console.error('Reviewer primary pass failed, attempting repair:', error);
  }

  try {
    if (!rawReviewerContent.trim()) {
      throw new Error('Reviewer returned no parseable content for repair.');
    }

    const repairReview = await repairReviewResponse(rawReviewerContent);
    return {
      ...repairReview,
      summary: `Repaired reviewer output. ${repairReview.summary}`,
    };
  } catch (error) {
    console.error('Reviewer failed, falling back to deterministic review:', error);
    return buildDeterministicFallbackReview(params);
  }
}
