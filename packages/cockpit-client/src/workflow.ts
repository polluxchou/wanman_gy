import type {
  Agent,
  AgentCurrentWork,
  AgentRosterDraft,
  AgentRosterValidationResult,
  Artifact,
  Task,
  TaskScopeType,
  TaskStatus,
  Thread,
} from './view-models.js';

const ACTIVE_STATUSES: TaskStatus[] = ['pending', 'assigned', 'in_progress', 'review'];

const ALLOWED_TRANSITIONS: Partial<Record<TaskStatus, TaskStatus[]>> = {
  pending: ['assigned', 'failed'],
  assigned: ['in_progress', 'failed'],
  in_progress: ['review', 'failed'],
  review: ['done', 'in_progress', 'failed'],
};

const MARKDOWN_KINDS = new Set(['research', 'plan', 'report', 'summary', 'spec', 'markdown']);

export function isTaskTransitionAllowed(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function nextTaskStatuses(status: TaskStatus): TaskStatus[] {
  return ALLOWED_TRANSITIONS[status] ?? [];
}

export function agentAssignmentWarning(agent: Agent | null | undefined): string | null {
  if (!agent) return null;
  if (agent.state === 'stopped') {
    return `${agent.name} is stopped. Assignment is allowed, but the agent will not pick it up until it is running.`;
  }
  if (agent.state === 'error') {
    return `${agent.name} is in error state. Assignment is allowed, but the task may not progress until the error clears.`;
  }
  return null;
}

export function validateTaskCreate(input: {
  title: string;
  scopeType?: TaskScopeType;
  scope?: { paths: string[]; patterns?: string[] };
}): string | null {
  if (!input.title.trim()) return 'Task title is required.';
  const hasScope =
    (input.scope?.paths?.length ?? 0) > 0 || (input.scope?.patterns?.length ?? 0) > 0;
  if (input.scopeType && ['code', 'docs', 'tests'].includes(input.scopeType) && !hasScope) {
    return `${input.scopeType} tasks should include at least one scope path or pattern.`;
  }
  return null;
}

export function validateMarkComplete(result: string): string | null {
  return result.trim() ? null : 'A result summary is required before marking the task complete.';
}

export function validateReturnForRevision(reason: string): string | null {
  return reason.trim() ? null : 'A revision reason is required before returning the task.';
}

export function validateGoal(goal: string): string | null {
  return goal.trim() ? null : 'Goal is required before starting a run.';
}

const SHELL_CONTROL_PATTERN = /[;&|`$<>]/;

export function validateProjectPath(projectPath: string): string | null {
  const value = projectPath.trim();
  if (!value) return 'Project path is required before starting takeover.';
  if (SHELL_CONTROL_PATTERN.test(value)) {
    return 'Project path cannot contain shell control characters.';
  }
  return null;
}

export function validateAgentRosterDraft(draft: AgentRosterDraft): AgentRosterValidationResult {
  const errors: AgentRosterValidationResult['errors'] = [];
  const warnings: AgentRosterValidationResult['warnings'] = [];
  const seen = new Map<string, number>();

  draft.agents.forEach((agent, index) => {
    if (!agent.enabled) return;
    const fieldPrefix = `agents[${index}]`;
    if (!/^[A-Za-z][A-Za-z0-9_-]{1,31}$/.test(agent.name)) {
      errors.push({
        field: `${fieldPrefix}.name`,
        message: 'Agent name must be a safe identifier: letters, numbers, underscore, or dash.',
      });
    }

    const previous = seen.get(agent.name);
    if (previous !== undefined) {
      errors.push({
        field: `${fieldPrefix}.name`,
        message: `Agent name duplicates agents[${previous}].name.`,
      });
    } else {
      seen.set(agent.name, index);
    }

    const runtime = agent.runtime ?? draft.runtime;
    if (runtime === 'codex' && agent.lifecycle === 'idle_cached') {
      errors.push({
        field: `${fieldPrefix}.lifecycle`,
        message: 'idle_cached is Claude-only because Codex does not support Claude resume semantics.',
      });
    }

    if (!agent.roleSummary.trim()) {
      warnings.push({
        field: `${fieldPrefix}.roleSummary`,
        message: 'A short role summary helps the run coordinator assign work.',
      });
    }
  });

  if (draft.agents.filter(agent => agent.enabled).length === 0) {
    errors.push({ field: 'agents', message: 'At least one enabled agent is required.' });
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function mapArtifactsToTask(task: Task, artifacts: Artifact[]): Artifact[] {
  const resultText = task.result ?? '';
  const scopePaths = new Set(task.scope?.paths ?? []);
  const scopePatterns = task.scope?.patterns ?? [];

  return artifacts.filter(artifact => {
    if (artifact.taskId === task.id) return true;
    if (artifact.taskId && task.id.startsWith(artifact.taskId)) return true;
    const metadataTaskId = artifact.metadata['taskId'];
    if (typeof metadataTaskId === 'string' && (metadataTaskId === task.id || task.id.startsWith(metadataTaskId))) {
      return true;
    }
    if (!artifact.path) return false;
    if (scopePaths.has(artifact.path)) return true;
    if (resultText.includes(artifact.path)) return true;
    return scopePatterns.some(pattern => pathMatchesPattern(artifact.path!, pattern));
  });
}

export function artifactPreviewMode(artifact: Pick<Artifact, 'kind' | 'path' | 'content'>): 'markdown' | 'plain' | 'missing' {
  if (!artifact.content) return 'missing';
  if (artifact.path?.toLowerCase().endsWith('.md')) return 'markdown';
  if (MARKDOWN_KINDS.has(artifact.kind.toLowerCase())) return 'markdown';
  return 'plain';
}

export function deriveAgentCurrentWork(
  agent: Agent,
  tasks: Task[],
  artifacts: Artifact[],
  threads: Thread[],
): AgentCurrentWork {
  const ownedTasks = tasks.filter(task => task.assignee === agent.name);
  const recentThreads = threads.filter(thread => thread.participants.includes(agent.name));
  const recentArtifacts = artifacts
    .filter(artifact => artifact.agent === agent.name)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 8);

  return {
    agent,
    assignedTasks: ownedTasks.filter(task => task.status === 'assigned'),
    inProgressTasks: ownedTasks.filter(task => task.status === 'in_progress'),
    reviewTasks: ownedTasks.filter(task => task.status === 'review'),
    recentThreads,
    recentArtifacts,
    errorState: agent.state === 'error' ? `${agent.name} is currently in error state.` : null,
  };
}

export function activeTaskCount(tasks: Task[], agentName: string): number {
  return tasks.filter(task => task.assignee === agentName && ACTIVE_STATUSES.includes(task.status)).length;
}

function patternToPrefix(pattern: string): string {
  return pattern.replace(/\/\*\*$/, '').replace(/\/\*$/, '');
}

function pathMatchesPattern(path: string, pattern: string): boolean {
  const prefix = patternToPrefix(pattern);
  return path === prefix || path.startsWith(`${prefix}/`);
}
