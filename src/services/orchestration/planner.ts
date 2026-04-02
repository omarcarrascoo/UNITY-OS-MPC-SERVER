import { createDeepseekChatCompletion } from '../ai/client.js';
import { parseJsonObject } from '../ai/edit-operations.js';
import type { PlanTaskDraft, RunPlanDraft } from '../../domain/orchestration.js';

interface PlanRunParams {
  prompt: string;
  projectTree: string;
  projectMemory: string | null;
}

const ADVISORY_TITLE_PATTERN =
  /^(analy[sz]e|analy[sz]ing|analysis|analizar|revisar|review|inspect|investigate|diagnose|audit|explore)\b/i;

const EXECUTION_VERB_PATTERN =
  /\b(create|implement|fix|update|edit|add|remove|refactor|wire|connect|build|write|modify|repair|redesign|crear|implementar|corregir|actualizar|editar|agregar|eliminar|refactorizar|conectar|modificar|reparar|redisenar|rediseñar)\b/i;

function normalizeWriteScope(writeScope: unknown): string[] {
  if (!Array.isArray(writeScope) || writeScope.length === 0) {
    return ['.'];
  }

  const normalized = writeScope
    .map((scope) => (typeof scope === 'string' ? scope.trim().replace(/^\.?\//, '').replace(/\/+$/, '') : ''))
    .filter(Boolean);

  return normalized.length ? normalized : ['.'];
}

function looksAdvisoryTask(task: Partial<PlanTaskDraft>): boolean {
  const title = (task.title || '').trim();
  const prompt = (task.prompt || '').trim();
  return ADVISORY_TITLE_PATTERN.test(title) && !EXECUTION_VERB_PATTERN.test(`${title} ${prompt}`);
}

function buildExecutionContract(prompt: string, writeScope: string[]): string {
  return `Execution contract:
- Produce concrete code changes, not analysis-only output.
- Prioritize the requested outcome over adjacent cleanup.
- Stay within these write scopes unless a directly-related fix is strictly required: ${writeScope.join(', ')}.
- Do not chase unrelated repo errors outside your scope.
- If you notice unrelated issues, leave them untouched and focus on making this task healthy.

Task instruction:
${prompt}`;
}

function normalizePlanTasks(tasks: Partial<PlanTaskDraft>[], fallbackPrompt: string): PlanTaskDraft[] {
  const fallbackTasks = tasks.map((task, index) => ({
    title: task.title || `Implementation Task ${index + 1}`,
    prompt: task.prompt || fallbackPrompt,
    role: 'executor' as const,
    kind: task.kind || 'implement',
    writeScope: normalizeWriteScope(task.writeScope),
    dependencies: Array.isArray(task.dependencies) ? task.dependencies.filter(Boolean) : [],
    rationale: task.rationale,
  }));

  const executableTasks = fallbackTasks.filter((task) => !looksAdvisoryTask(task));
  const selectedTasks = executableTasks.length > 0 ? executableTasks : fallbackTasks;
  const allowedTitles = new Set(selectedTasks.map((task) => task.title));

  return selectedTasks.map((task, index) => {
    const writeScope = normalizeWriteScope(task.writeScope);

    return {
      ...task,
      title: task.title || `Implementation Task ${index + 1}`,
      prompt: buildExecutionContract(task.prompt || fallbackPrompt, writeScope),
      role: 'executor',
      kind: task.kind || 'implement',
      writeScope,
      dependencies: (task.dependencies || []).filter((dependency) => allowedTitles.has(dependency)),
    };
  });
}

function buildPlannerPrompt({ prompt, projectTree, projectMemory }: PlanRunParams): string {
  return `You are the planner agent of Unity.
Create an execution plan for an autonomous coding system.

PROJECT TREE
${projectTree || '(empty)'}

PROJECT MEMORY
${projectMemory || '(none)'}

USER REQUEST
${prompt}

GOALS
- Split the work into implementation tasks that can run in parallel when safe.
- Prefer strong parallelism from the start.
- Each task must have a narrow write scope.
- Only add dependencies when truly required.
- Keep tasks practical for real code execution.
- Return strict JSON with double quotes and no trailing commas.
- Do not wrap the JSON in markdown or commentary.

RETURN JSON ONLY:
{
  "summary": "short plan summary",
  "tasks": [
    {
      "title": "task title",
      "prompt": "full task instruction for the executor",
      "role": "executor",
      "kind": "implement",
      "writeScope": ["path/or/module", "another/path"],
      "dependencies": ["optional task title dependency"],
      "rationale": "why this task exists"
    }
  ]
}`;
}

export async function planAutonomousRun(params: PlanRunParams): Promise<RunPlanDraft> {
  try {
    const response = await createDeepseekChatCompletion({
      model: 'deepseek-chat',
      temperature: 0.2,
      max_tokens: 2200,
      messages: [{ role: 'user', content: buildPlannerPrompt(params) }],
    });

    const content = response.choices[0]?.message?.content || '';
    const plan = parseJsonObject<RunPlanDraft>(content);

    if (!plan.tasks?.length) {
      throw new Error('Planner returned no tasks.');
    }

    return {
      summary: plan.summary || 'Autonomous execution plan',
      tasks: normalizePlanTasks(plan.tasks, params.prompt),
    };
  } catch (error) {
    console.error('Planner failed, falling back to single-task plan:', error);

    return {
      summary: 'Fallback single-task autonomous plan',
      tasks: [
        {
          title: 'Primary Implementation',
          prompt: buildExecutionContract(params.prompt, ['.']),
          role: 'executor',
          kind: 'implement',
          writeScope: ['.'],
          dependencies: [],
          rationale: 'Fallback task when planning fails.',
        },
      ],
    };
  }
}
