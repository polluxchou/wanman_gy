import { describe, expect, it, vi } from 'vitest';
import { WanmanCockpitClient } from './client.js';
import {
  agentAssignmentWarning,
  artifactPreviewMode,
  deriveAgentCurrentWork,
  isTaskTransitionAllowed,
  mapArtifactsToTask,
  validateMarkComplete,
  validateReturnForRevision,
} from './workflow.js';
import type { Agent, Artifact, Task } from './view-models.js';

interface FetchRoute {
  [rpcMethod: string]: unknown;
}

function makeRpcFetch(routes: FetchRoute, calls: Array<{ method: string; params: Record<string, unknown> }>) {
  return vi.fn(async (_url: string | URL | Request, opts?: RequestInit) => {
    const body = JSON.parse(String(opts?.body ?? '{}')) as {
      method: string;
      params?: Record<string, unknown>;
    };
    calls.push({ method: body.method, params: body.params ?? {} });
    const result = routes[body.method] ?? {};
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result }),
    } as Response;
  });
}

function task(overrides: Partial<Task>): Task {
  return {
    id: 'task-12345678',
    shortId: 'task-123',
    title: 'Implement feature',
    description: '',
    status: 'pending',
    assignee: null,
    priority: 5,
    scope: { paths: [] },
    dependsOn: [],
    result: null,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

describe('Stage 3 client task operations', () => {
  it('createTask calls task.create with cockpit as creator and maps the task', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const fetchImpl = makeRpcFetch({
      'task.create': {
        id: 'created-task-id',
        title: 'Review artifact flow',
        description: 'Add the review workbench',
        status: 'pending',
        assignee: 'dev',
        priority: 7,
        scope: { paths: ['apps/cockpit/src/pages/Artifacts.tsx'], patterns: ['apps/cockpit/src/**/*.tsx'] },
        dependsOn: ['dep-1'],
        initiativeId: 'init-1',
        capsuleId: 'cap-1',
        subsystem: 'web-cockpit',
        scopeType: 'code',
        createdAt: 100,
        updatedAt: 100,
      },
    }, calls);
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });

    const created = await client.createTask({
      title: 'Review artifact flow',
      description: 'Add the review workbench',
      assignee: 'dev',
      priority: 7,
      scope: { paths: ['apps/cockpit/src/pages/Artifacts.tsx'], patterns: ['apps/cockpit/src/**/*.tsx'] },
      dependsOn: ['dep-1'],
      initiativeId: 'init-1',
      capsuleId: 'cap-1',
      subsystem: 'web-cockpit',
      scopeType: 'code',
    });

    expect(calls[0]).toEqual({
      method: 'task.create',
      params: expect.objectContaining({
        title: 'Review artifact flow',
        agent: 'cockpit',
        assignee: 'dev',
        priority: 7,
        dependsOn: ['dep-1'],
        subsystem: 'web-cockpit',
        scopeType: 'code',
      }),
    });
    expect(created.id).toBe('created-task-id');
    expect(created.shortId).toBe('created-');
    expect(created.subsystem).toBe('web-cockpit');
    expect(created.scopeType).toBe('code');
  });

  it('updateTask and assignTask call task.update', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const fetchImpl = makeRpcFetch({
      'task.update': {
        id: 'task-1',
        title: 'Task',
        status: 'assigned',
        assignee: 'qa',
        priority: 5,
        description: '',
        scope: { paths: [] },
        dependsOn: [],
        createdAt: 100,
        updatedAt: 200,
      },
    }, calls);
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });

    await client.updateTask({ id: 'task-1', status: 'assigned', assignee: 'dev' });
    await client.assignTask({ taskId: 'task-1', assignee: 'qa' });

    expect(calls.map(c => c.method)).toEqual(['task.update', 'task.update']);
    expect(calls[0]?.params).toMatchObject({ id: 'task-1', status: 'assigned', assignee: 'dev', agent: 'cockpit' });
    expect(calls[1]?.params).toMatchObject({ id: 'task-1', assignee: 'qa', agent: 'cockpit' });
  });

  it('markTaskComplete requires the caller result and records artifact ids in the result text', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const fetchImpl = makeRpcFetch({
      'task.update': {
        id: 'task-1',
        title: 'Task',
        status: 'done',
        assignee: 'dev',
        priority: 5,
        description: '',
        scope: { paths: [] },
        dependsOn: [],
        result: 'Looks good\n\nArtifacts: 42, 43',
        createdAt: 100,
        updatedAt: 200,
      },
    }, calls);
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });

    const updated = await client.markTaskComplete({
      taskId: 'task-1',
      result: 'Looks good',
      artifactIds: ['42', '43'],
    });

    expect(calls[0]?.method).toBe('task.update');
    expect(calls[0]?.params).toMatchObject({
      id: 'task-1',
      status: 'done',
      result: 'Looks good\n\nArtifacts: 42, 43',
      agent: 'cockpit',
    });
    expect(updated.status).toBe('done');
  });

  it('returnTaskForRevision updates status and can notify the assignee', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const fetchImpl = makeRpcFetch({
      'task.update': {
        id: 'task-1',
        title: 'Task',
        status: 'in_progress',
        assignee: 'dev',
        priority: 5,
        description: '',
        scope: { paths: [] },
        dependsOn: [],
        result: 'Needs tests',
        createdAt: 100,
        updatedAt: 200,
      },
      'agent.send': { id: 'msg-1', status: 'queued' },
    }, calls);
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });

    await client.returnTaskForRevision({
      taskId: 'task-1',
      assignee: 'dev',
      reason: 'Needs tests',
      notifyAssignee: true,
    });

    expect(calls[0]?.params).toMatchObject({
      id: 'task-1',
      status: 'in_progress',
      result: 'Needs tests',
      agent: 'cockpit',
    });
    expect(calls[1]?.method).toBe('agent.send');
    expect(calls[1]?.params).toMatchObject({ to: 'dev', type: 'blocker_response', priority: 'normal' });
  });

  it('listArtifactsForTask combines metadata links with best-effort path/result references', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const fetchImpl = makeRpcFetch({
      'artifact.list': {
        rows: [
          { id: 1, agent: 'dev', kind: 'plan', path: 'docs/plan.md', metadata: { taskId: 'task-1' }, created_at: '2024-01-01T00:00:00Z' },
          { id: 2, agent: 'dev', kind: 'report', path: 'reports/output.md', metadata: {}, created_at: '2024-01-01T00:00:00Z' },
        ],
      },
      'task.get': {
        id: 'task-1',
        title: 'Task',
        status: 'review',
        priority: 5,
        description: '',
        scope: { paths: ['reports/output.md'] },
        dependsOn: [],
        result: 'See reports/output.md',
        createdAt: 100,
        updatedAt: 200,
      },
      'task.list': { tasks: [] },
    }, calls);
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });

    const artifacts = await client.listArtifactsForTask('task-1');

    expect(artifacts.map(a => a.id)).toEqual(['1', '2']);
  });

  it('reviewArtifact is UI-only when no stable artifact mutation API exists', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const fetchImpl = makeRpcFetch({}, calls);
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });

    const result = await client.reviewArtifact({ artifactId: '42', status: 'accepted', note: 'ok' });

    expect(result).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('Stage 3 workflow helpers', () => {
  it('allows only explicit Stage 3 task transitions', () => {
    expect(isTaskTransitionAllowed('pending', 'assigned')).toBe(true);
    expect(isTaskTransitionAllowed('assigned', 'in_progress')).toBe(true);
    expect(isTaskTransitionAllowed('in_progress', 'review')).toBe(true);
    expect(isTaskTransitionAllowed('review', 'done')).toBe(true);
    expect(isTaskTransitionAllowed('review', 'in_progress')).toBe(true);
    expect(isTaskTransitionAllowed('pending', 'review')).toBe(false);
    expect(isTaskTransitionAllowed('done', 'failed')).toBe(false);
    expect(isTaskTransitionAllowed('assigned', 'failed')).toBe(true);
  });

  it('warns before assigning stopped or error agents', () => {
    expect(agentAssignmentWarning({ name: 'dev', state: 'stopped' } as Agent)).toContain('stopped');
    expect(agentAssignmentWarning({ name: 'qa', state: 'error' } as Agent)).toContain('error');
    expect(agentAssignmentWarning({ name: 'ops', state: 'idle' } as Agent)).toBeNull();
  });

  it('validates mark-complete and return-for-revision required text', () => {
    expect(validateMarkComplete('')).toContain('result summary');
    expect(validateMarkComplete('Shipped')).toBeNull();
    expect(validateReturnForRevision('')).toContain('reason');
    expect(validateReturnForRevision('Needs a narrower diff')).toBeNull();
  });

  it('maps artifacts to a task using metadata, path, and result references', () => {
    const artifacts: Artifact[] = [
      { id: '1', kind: 'plan', agent: 'dev', path: 'docs/plan.md', contentLength: 10, content: null, metadata: { taskId: 'task-1' }, confidence: 0, verified: false, taskId: 'task-1', createdAt: 1 },
      { id: '2', kind: 'report', agent: 'dev', path: 'reports/output.md', contentLength: 10, content: null, metadata: {}, confidence: 0, verified: false, createdAt: 2 },
      { id: '3', kind: 'note', agent: 'qa', path: 'other.md', contentLength: 10, content: null, metadata: {}, confidence: 0, verified: false, createdAt: 3 },
    ];
    const related = mapArtifactsToTask(task({
      id: 'task-1',
      scope: { paths: ['reports/output.md'] },
      result: 'Output: reports/output.md',
    }), artifacts);

    expect(related.map(a => a.id)).toEqual(['1', '2']);
  });

  it('chooses markdown preview only for markdown-like artifacts with content', () => {
    expect(artifactPreviewMode({ kind: 'plan', path: 'plan.md', content: '# Plan' } as Artifact)).toBe('markdown');
    expect(artifactPreviewMode({ kind: 'log', path: 'run.txt', content: 'plain' } as Artifact)).toBe('plain');
    expect(artifactPreviewMode({ kind: 'plan', path: 'plan.md', content: null } as Artifact)).toBe('missing');
  });

  it('derives current work and recent agent artifacts', () => {
    const work = deriveAgentCurrentWork(
      { name: 'dev', state: 'running' } as Agent,
      [
        task({ id: 'a', assignee: 'dev', status: 'assigned' }),
        task({ id: 'b', assignee: 'dev', status: 'in_progress' }),
        task({ id: 'c', assignee: 'dev', status: 'review' }),
        task({ id: 'd', assignee: 'dev', status: 'done' }),
      ],
      [
        { id: '1', kind: 'plan', agent: 'dev', path: 'a.md', contentLength: 1, content: null, metadata: {}, confidence: 0, verified: false, createdAt: 10 },
        { id: '2', kind: 'plan', agent: 'qa', path: 'b.md', contentLength: 1, content: null, metadata: {}, confidence: 0, verified: false, createdAt: 20 },
      ],
      [],
    );

    expect(work.assignedTasks).toHaveLength(1);
    expect(work.inProgressTasks).toHaveLength(1);
    expect(work.reviewTasks).toHaveLength(1);
    expect(work.recentArtifacts.map(a => a.id)).toEqual(['1']);
  });
});
