import { describe, it, expect, vi } from 'vitest';
import { WanmanCockpitClient, BrainAbsentError, isBrainAbsentError } from './client.js';

// ── Test helpers ──

interface FetchRoute {
  health?: unknown;
  [rpcMethod: string]: unknown;
}

/** Creates a fetch mock that routes GET /health and POST /rpc by RPC method name. */
function makeFetch(routes: FetchRoute) {
  return vi.fn(async (url: string | URL | Request, opts?: RequestInit) => {
    const urlStr = String(url);

    if (urlStr.endsWith('/health') && (!opts || opts.method !== 'POST')) {
      return {
        ok: true,
        status: 200,
        json: async () => routes.health ?? { status: 'ok', agents: [], timestamp: new Date().toISOString() },
      } as Response;
    }

    if (urlStr.endsWith('/rpc') && opts?.body) {
      const body = JSON.parse(opts.body as string) as { method: string };
      const routeKey = body.method;
      const result = routes[routeKey];
      if (result instanceof Error) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32603, message: result.message },
          }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: result ?? {} }),
      } as Response;
    }

    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
}

const baseHealth = {
  status: 'ok',
  agents: [],
  timestamp: '2024-01-01T00:00:00.000Z',
  runtime: {
    completedRuns: 0,
    completedRunsByAgent: {},
    activeInitiatives: 0,
    activeCapsules: 0,
  },
};

// ── getHealth ──

describe('getHealth', () => {
  it('maps status, agents, loop, and runtime stats', async () => {
    const fetchImpl = makeFetch({
      health: {
        status: 'ok',
        agents: [
          { name: 'ceo', state: 'running', lifecycle: '24/7' },
          { name: 'dev', state: 'idle', lifecycle: 'on-demand' },
        ],
        timestamp: '2024-06-01T10:00:00.000Z',
        loop: { runId: 'run-abc', currentLoop: 42 },
        runtime: {
          completedRuns: 7,
          completedRunsByAgent: { ceo: 5, dev: 2 },
          activeInitiatives: 3,
          activeCapsules: 1,
        },
      },
    });

    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    const health = await client.getHealth();

    expect(health.status).toBe('ok');
    expect(health.agents).toHaveLength(2);
    expect(health.agents[0]?.name).toBe('ceo');
    expect(health.agents[0]?.completedRuns).toBe(5);
    expect(health.agents[1]?.completedRuns).toBe(2);
    expect(health.runtime.completedRuns).toBe(7);
    expect(health.runtime.activeInitiatives).toBe(3);
    expect(health.runtime.activeCapsules).toBe(1);
    expect(health.loop).toEqual({ runId: 'run-abc', currentLoop: 42 });
  });

  it('returns null loop when not present', async () => {
    const fetchImpl = makeFetch({ health: baseHealth });
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    const health = await client.getHealth();
    expect(health.loop).toBeNull();
  });

  it('throws when supervisor is unreachable', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    await expect(client.getHealth()).rejects.toThrow('ECONNREFUSED');
  });
});

// ── listTasks / blocked derivation ──

describe('listTasks – blocked derivation', () => {
  const rawTasks = [
    {
      id: 'aaa-111-222',
      title: 'Foundation',
      status: 'failed',
      priority: 5,
      createdAt: 1000,
      updatedAt: 2000,
      description: '',
      scope: { paths: [] },
      dependsOn: [],
    },
    {
      id: 'bbb-333-444',
      title: 'Feature',
      status: 'pending',
      priority: 3,
      createdAt: 1001,
      updatedAt: 2001,
      description: '',
      scope: { paths: [] },
      dependsOn: ['aaa-111-222'],
    },
    {
      id: 'ccc-555-666',
      title: 'Docs',
      status: 'pending',
      priority: 4,
      createdAt: 1002,
      updatedAt: 2002,
      description: '',
      scope: { paths: [] },
      dependsOn: ['aaa-111-222'],
    },
    {
      id: 'ddd-777-888',
      title: 'Tests',
      status: 'assigned',
      priority: 2,
      createdAt: 1003,
      updatedAt: 2003,
      description: '',
      scope: { paths: [] },
      dependsOn: [],
    },
  ];

  it('marks tasks with failed dependencies as blocked', async () => {
    const fetchImpl = makeFetch({
      health: baseHealth,
      'task.list': { tasks: rawTasks },
    });
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    const tasks = await client.listTasks();

    const feature = tasks.find(t => t.id === 'bbb-333-444');
    const docs = tasks.find(t => t.id === 'ccc-555-666');
    const assigned = tasks.find(t => t.id === 'ddd-777-888');

    expect(feature?.status).toBe('blocked');
    expect(docs?.status).toBe('blocked');
    expect(assigned?.status).toBe('assigned');
  });

  it('preserves failed status on the dependency itself', async () => {
    const fetchImpl = makeFetch({
      health: baseHealth,
      'task.list': { tasks: rawTasks },
    });
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    const tasks = await client.listTasks();
    const foundation = tasks.find(t => t.id === 'aaa-111-222');
    expect(foundation?.status).toBe('failed');
  });

  it('does not mark blocked when dependency is done', async () => {
    const doneTasks = [
      { ...rawTasks[0]!, status: 'done' },
      { ...rawTasks[1]!, status: 'pending' },
    ];
    const fetchImpl = makeFetch({
      health: baseHealth,
      'task.list': { tasks: doneTasks },
    });
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    const tasks = await client.listTasks();
    const feature = tasks.find(t => t.id === 'bbb-333-444');
    expect(feature?.status).toBe('pending');
  });

  it('filters by status after derivation', async () => {
    const fetchImpl = makeFetch({
      health: baseHealth,
      'task.list': { tasks: rawTasks },
    });
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    const blocked = await client.listTasks({ status: 'blocked' });
    expect(blocked.every(t => t.status === 'blocked')).toBe(true);
    expect(blocked.length).toBe(2);
  });

  it('computes shortId as first 8 chars of id', async () => {
    const fetchImpl = makeFetch({
      health: baseHealth,
      'task.list': { tasks: [rawTasks[0]!] },
    });
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    const tasks = await client.listTasks();
    expect(tasks[0]?.shortId).toBe('aaa-111-');
  });
});

// ── listArtifacts ──

describe('listArtifacts', () => {
  it('throws BrainAbsentError when brain is not initialized', async () => {
    const fetchImpl = makeFetch({
      'artifact.list': new Error('Brain not initialized'),
    });
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    await expect(client.listArtifacts()).rejects.toBeInstanceOf(BrainAbsentError);
  });

  it('throws BrainAbsentError for "Brain not configured" variant', async () => {
    const fetchImpl = makeFetch({
      'artifact.list': new Error('Brain not configured'),
    });
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    const err = await client.listArtifacts().catch(e => e);
    expect(isBrainAbsentError(err)).toBe(true);
  });

  it('rethrows non-brain errors', async () => {
    const fetchImpl = makeFetch({
      'artifact.list': new Error('SQL execution failed: table corruption'),
    });
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    await expect(client.listArtifacts()).rejects.toThrow('SQL execution failed');
  });

  it('maps artifact rows from array result', async () => {
    const rows = [
      {
        id: 42,
        agent: 'dev',
        kind: 'research',
        path: '/docs/research.md',
        content_length: 512,
        metadata: { confidence: 0.85, verified: true, taskId: 'task-abc' },
        created_at: '2024-06-01T12:00:00.000Z',
      },
    ];
    const fetchImpl = makeFetch({ 'artifact.list': rows });
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    const artifacts = await client.listArtifacts();

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.id).toBe('42');
    expect(artifacts[0]?.kind).toBe('research');
    expect(artifacts[0]?.agent).toBe('dev');
    expect(artifacts[0]?.path).toBe('/docs/research.md');
    expect(artifacts[0]?.contentLength).toBe(512);
    expect(artifacts[0]?.confidence).toBe(0.85);
    expect(artifacts[0]?.verified).toBe(true);
    expect(artifacts[0]?.taskId).toBe('task-abc');
    expect(artifacts[0]?.createdAt).toBeGreaterThan(0);
  });

  it('maps artifact rows from {rows:[]} shaped result', async () => {
    const result = {
      rows: [
        {
          id: 7,
          agent: 'ceo',
          kind: 'plan',
          path: null,
          content_length: 200,
          metadata: {},
          created_at: null,
        },
      ],
    };
    const fetchImpl = makeFetch({ 'artifact.list': result });
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    const artifacts = await client.listArtifacts();
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.id).toBe('7');
    expect(artifacts[0]?.confidence).toBe(0);
    expect(artifacts[0]?.verified).toBe(false);
  });

  it('getArtifact returns null when brain is absent', async () => {
    const fetchImpl = makeFetch({
      'artifact.get': new Error('Brain not initialized'),
    });
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    const result = await client.getArtifact('42');
    expect(result).toBeNull();
  });

  it('getArtifact rethrows non-brain errors', async () => {
    const fetchImpl = makeFetch({
      'artifact.get': new Error('Unexpected database error'),
    });
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    await expect(client.getArtifact('42')).rejects.toThrow('Unexpected database error');
  });

  it('returns empty array (not brain error) when artifacts list is actually empty', async () => {
    const fetchImpl = makeFetch({ 'artifact.list': [] });
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    const result = await client.listArtifacts();
    expect(result).toEqual([]);
  });
});

// ── listThreads — must never call agent.recv ──

describe('listThreads', () => {
  it('never calls agent.recv regardless of what the server returns', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, opts?: RequestInit) => {
      if (opts?.body) {
        const body = JSON.parse(opts.body as string) as { method: string };
        if (body.method === 'agent.recv') {
          throw new Error('agent.recv must never be called by the cockpit');
        }
        // Simulate thread.list method-not-found (graceful degradation)
        if (body.method === 'thread.list') {
          return {
            ok: true, status: 200,
            json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Unknown method: thread.list' } }),
          } as Response;
        }
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });

    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    const threads = await client.listThreads();
    expect(threads).toEqual([]);
  });

  it('returns threads from thread.list RPC when available', async () => {
    const rawThreads = [
      {
        id: 'ceo|dev',
        participants: ['ceo', 'dev'],
        lastMessage: {
          id: 'msg-1',
          from: 'ceo',
          to: 'dev',
          type: 'message',
          priority: 'normal',
          payload: { text: 'Please implement feature X' },
          timestamp: 1000,
          delivered: true,
        },
        messageCount: 3,
        pendingForHuman: false,
      },
    ];

    const fetchImpl = makeFetch({
      health: baseHealth,
      'thread.list': { threads: rawThreads },
    });
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    const threads = await client.listThreads();

    expect(threads).toHaveLength(1);
    expect(threads[0]!.id).toBe('ceo|dev');
    expect(threads[0]!.participants).toEqual(['ceo', 'dev']);
    expect(threads[0]!.messageCount).toBe(3);
    expect(threads[0]!.pendingForHuman).toBe(false);
  });

  it('getThread returns null when method not found (graceful)', async () => {
    const fetchImpl = makeFetch({
      'thread.get': new Error('Unknown method: thread.get'),
    });
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    const result = await client.getThread('ceo|dev');
    expect(result).toBeNull();
  });

  it('getThread returns thread and messages', async () => {
    const messages = [
      { id: 'msg-1', from: 'ceo', to: 'dev', type: 'message', priority: 'normal', payload: 'hello', timestamp: 1000, delivered: true },
      { id: 'msg-2', from: 'dev', to: 'ceo', type: 'message', priority: 'normal', payload: 'got it', timestamp: 2000, delivered: true },
    ];
    const thread = { id: 'ceo|dev', participants: ['ceo', 'dev'], lastMessage: messages[1], messageCount: 2, pendingForHuman: false };
    const fetchImpl = makeFetch({ 'thread.get': { thread, messages } });
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    const result = await client.getThread('ceo|dev');

    expect(result).not.toBeNull();
    expect(result!.thread.id).toBe('ceo|dev');
    expect(result!.messages).toHaveLength(2);
    expect(result!.messages[0]!.from).toBe('ceo');
  });
});

// ── Thread grouping (task-to-message linking) ──

describe('listThreads – task id linking', () => {
  it('filters threads whose lastMessage payload contains the taskId', async () => {
    const threads = [
      {
        id: 'ceo|dev',
        participants: ['ceo', 'dev'],
        lastMessage: { id: 'm1', from: 'ceo', to: 'dev', type: 'message', priority: 'normal', payload: { taskId: 'abc-123' }, timestamp: 1000, delivered: true },
        messageCount: 1,
        pendingForHuman: false,
      },
      {
        id: 'ceo|qa',
        participants: ['ceo', 'qa'],
        lastMessage: { id: 'm2', from: 'ceo', to: 'qa', type: 'message', priority: 'normal', payload: 'unrelated', timestamp: 2000, delivered: true },
        messageCount: 1,
        pendingForHuman: false,
      },
    ];
    const fetchImpl = makeFetch({ 'thread.list': { threads } });
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    const result = await client.listThreads({ taskId: 'abc-123' });

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('ceo|dev');
  });
});

// ── sendMessage ──

describe('sendMessage', () => {
  it('calls agent.send with correct params', async () => {
    const sentCalls: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, opts?: RequestInit) => {
      if (opts?.body) {
        const body = JSON.parse(opts.body as string) as { method: string; params: unknown };
        sentCalls.push(body);
      }
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: { id: 'msg-x', status: 'queued' } }) } as Response;
    });

    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    await client.sendMessage({ to: 'dev', payload: 'please fix the bug', priority: 'normal' });

    expect(sentCalls).toHaveLength(1);
    const call = sentCalls[0] as { method: string; params: Record<string, unknown> };
    expect(call.method).toBe('agent.send');
    expect(call.params['to']).toBe('dev');
    expect(call.params['from']).toBe('human');
    expect(call.params['payload']).toBe('please fix the bug');
  });

  it('never calls agent.recv', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, opts?: RequestInit) => {
      if (opts?.body) {
        const body = JSON.parse(opts.body as string) as { method: string };
        if (body.method === 'agent.recv') throw new Error('agent.recv must not be called');
      }
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: { id: 'x', status: 'queued' } }) } as Response;
    });

    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    await expect(client.sendMessage({ to: 'dev', payload: 'hi' })).resolves.toBeUndefined();
  });
});

// ── markHumanActionHandled ──

describe('markHumanActionHandled', () => {
  it('calls human.ack with the inbox item id stripped of prefix', async () => {
    const sentCalls: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, opts?: RequestInit) => {
      if (opts?.body) {
        const body = JSON.parse(opts.body as string) as { method: string; params: unknown };
        sentCalls.push(body);
      }
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: { ok: true, changed: true } }) } as Response;
    });

    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    await client.markHumanActionHandled('human_inbox:some-uuid-123');

    expect(sentCalls).toHaveLength(1);
    const call = sentCalls[0] as { method: string; params: { id: string } };
    expect(call.method).toBe('human.ack');
    expect(call.params['id']).toBe('some-uuid-123');
  });
});

// ── listHumanActions – handled field ──

describe('listHumanActions – handled field', () => {
  it('includes handled:false on derived actions', async () => {
    const fetchImpl = makeFetch({
      health: {
        ...baseHealth,
        agents: [{ name: 'worker', state: 'error', lifecycle: 'on-demand' }],
        runtime: { ...baseHealth.runtime, completedRunsByAgent: {} },
      },
      'agent.list': { agents: [{ name: 'worker', state: 'error', lifecycle: 'on-demand', model: '' }] },
      'task.list': { tasks: [] },
      'human.list': { items: [] },
    });
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    const actions = await client.listHumanActions();
    expect(actions[0]?.handled).toBe(false);
  });

  it('merges human.list items with handled state', async () => {
    const fetchImpl = makeFetch({
      health: baseHealth,
      'agent.list': { agents: [] },
      'task.list': { tasks: [] },
      'human.list': {
        items: [{
          id: 'inbox-uuid-1',
          from: 'ceo',
          type: 'decision',
          payload: { message: 'Should we proceed?' },
          priority: 'steer',
          timestamp: 5000,
          handled: false,
          handledAt: null,
        }],
      },
    });
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    const actions = await client.listHumanActions();
    const inbox = actions.find(a => a.id === 'human_inbox:inbox-uuid-1');
    expect(inbox).toBeDefined();
    expect(inbox?.kind).toBe('decision');
    expect(inbox?.handled).toBe(false);
    expect(inbox?.summary).toContain('Should we proceed?');
  });
});

// ── listHumanActions ──

describe('listHumanActions', () => {
  it('derives agent_error actions for agents in error state', async () => {
    const fetchImpl = makeFetch({
      health: {
        ...baseHealth,
        agents: [{ name: 'worker', state: 'error', lifecycle: 'on-demand' }],
        runtime: { ...baseHealth.runtime, completedRunsByAgent: { worker: 0 } },
      },
      'agent.list': { agents: [{ name: 'worker', state: 'error', lifecycle: 'on-demand', model: '' }] },
      'task.list': { tasks: [] },
    });
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    const actions = await client.listHumanActions();
    const errAction = actions.find(a => a.kind === 'agent_error');

    expect(errAction).toBeDefined();
    expect(errAction?.relatedAgent).toBe('worker');
    expect(errAction?.priority).toBe('steer');
    expect(errAction?.summary).toContain('worker');
  });

  it('derives task_review actions for tasks in review', async () => {
    const tasks = [
      {
        id: 'task-review-1',
        title: 'PR review',
        status: 'review',
        assignee: 'dev',
        priority: 5,
        createdAt: 100,
        updatedAt: 200,
        description: '',
        scope: { paths: [] },
        dependsOn: [],
      },
    ];
    const fetchImpl = makeFetch({
      health: baseHealth,
      'agent.list': { agents: [] },
      'task.list': { tasks },
    });
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    const actions = await client.listHumanActions();
    const reviewAction = actions.find(a => a.kind === 'task_review');

    expect(reviewAction).toBeDefined();
    expect(reviewAction?.relatedTaskId).toBe('task-review-1');
  });

  it('sorts steer-priority actions first', async () => {
    const fetchImpl = makeFetch({
      health: {
        ...baseHealth,
        agents: [{ name: 'worker', state: 'error', lifecycle: 'on-demand' }],
        runtime: { ...baseHealth.runtime, completedRunsByAgent: {} },
      },
      'agent.list': { agents: [{ name: 'worker', state: 'error', lifecycle: 'on-demand', model: '' }] },
      'task.list': {
        tasks: [
          {
            id: 'task-review-1',
            title: 'Old review',
            status: 'review',
            assignee: 'dev',
            priority: 5,
            createdAt: 1,
            updatedAt: 2,
            description: '',
            scope: { paths: [] },
            dependsOn: [],
          },
        ],
      },
    });
    const client = new WanmanCockpitClient({ fetchImpl, baseUrl: '' });
    const actions = await client.listHumanActions();

    expect(actions[0]?.priority).toBe('steer');
  });
});
