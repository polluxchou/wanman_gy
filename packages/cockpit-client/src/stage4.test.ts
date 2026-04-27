import { describe, expect, it, vi } from 'vitest';
import { WanmanCockpitClient } from './client.js';
import {
  validateAgentRosterDraft,
  validateGoal,
  validateProjectPath,
} from './workflow.js';
import type { AgentRosterDraft } from './view-models.js';

function makeFetch(routes: Record<string, unknown>, calls: Array<{ url: string; method: string; body: unknown }>) {
  return vi.fn(async (url: string | URL | Request, opts?: RequestInit) => {
    const urlText = String(url);
    const method = opts?.method ?? 'GET';
    const body = opts?.body ? JSON.parse(String(opts.body)) : null;
    calls.push({ url: urlText, method, body });

    if (urlText.endsWith('/health')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          agents: [{ name: 'ceo', state: 'running', lifecycle: '24/7', model: 'high', runtime: 'codex' }],
          timestamp: '2026-04-27T00:00:00.000Z',
          loop: { runId: 'run-1', currentLoop: 4 },
          runtime: { completedRuns: 2, completedRunsByAgent: { ceo: 2 } },
        }),
      } as Response;
    }

    if (urlText.endsWith('/rpc')) {
      const rpcBody = body as { method: string; params?: Record<string, unknown> };
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: routes[rpcBody.method] ?? {} }),
      } as Response;
    }

    const key = urlText.replace(/^https?:\/\/[^/]+/, '');
    const result = routes[key];
    if (result === undefined) {
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) } as Response;
    }
    return { ok: true, status: 200, json: async () => result } as Response;
  });
}

describe('Stage 4 runtime control client', () => {
  it('maps host runtime status and preserves supervisor health fields', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = makeFetch({
      '/runtime/status': {
        hostBridge: true,
        supervisor: { connection: 'connected', url: 'http://127.0.0.1:3999', status: 'running' },
        activeSession: { id: 'session-1', kind: 'run', status: 'running', goal: 'Ship', runtime: 'codex', startedAt: 1000 },
        currentGoal: 'Ship',
        currentRuntime: 'codex',
        agents: [{ name: 'ceo', state: 'running', lifecycle: '24/7', model: 'high', runtime: 'codex', completedRuns: 2 }],
        loop: { runId: 'run-1', currentLoop: 4 },
        lastEvent: { id: 'log-1', timestamp: 2000, level: 'info', source: 'host', message: 'started' },
        auth: [],
        capabilities: { startRun: true, startTakeover: true, stopSession: true, pause: true, resume: true, logs: true },
      },
    }, calls);
    const client = new WanmanCockpitClient({ fetchImpl, controlUrl: '' });

    const status = await client.getRuntimeStatus();

    expect(status.hostBridge).toBe(true);
    expect(status.supervisor.connection).toBe('connected');
    expect(status.activeSession?.kind).toBe('run');
    expect(status.currentRuntime).toBe('codex');
    expect(status.loop?.currentLoop).toBe(4);
  });

  it('falls back to health when the host bridge is unavailable', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = makeFetch({ 'auth.providers': { providers: [{ name: 'codex', status: 'authenticated' }] } }, calls);
    const client = new WanmanCockpitClient({ fetchImpl, controlUrl: '' });

    const status = await client.getRuntimeStatus();

    expect(status.hostBridge).toBe(false);
    expect(status.supervisor.connection).toBe('connected');
    expect(status.agents[0]?.runtime).toBe('codex');
    expect(status.auth[0]?.name).toBe('codex');
  });

  it('wraps start run, takeover, stop, pause, resume, and logs with typed endpoints', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = makeFetch({
      '/runtime/start-run': { id: 'run-session', kind: 'run', status: 'starting', goal: 'Build', runtime: 'claude', startedAt: 100 },
      '/runtime/start-takeover': { id: 'takeover-session', kind: 'takeover', status: 'starting', goal: 'Improve repo', runtime: 'codex', startedAt: 200 },
      '/runtime/stop': { status: 'stopping' },
      '/runtime/pause': { status: 'paused' },
      '/runtime/resume': { status: 'running' },
      '/runtime/logs?level=warn&limit=5': {
        logs: [{ id: '1', timestamp: 1, level: 'warn', source: 'supervisor', message: 'careful' }],
      },
    }, calls);
    const client = new WanmanCockpitClient({ fetchImpl, controlUrl: '' });

    await client.startRun({ goal: 'Build', runtime: 'claude', loopMode: 'finite', loops: 4, pollInterval: 10, errorLimit: 2, roster: { agents: [], runtime: 'claude', goal: 'Build', source: 'default' } });
    await client.startTakeover({ projectPath: '/tmp/project', runtime: 'codex', dryRun: false, infinite: true, pollInterval: 15, noBrain: true });
    await client.stopSession({ reason: 'operator stop' });
    await client.pauseSupervisor();
    await client.resumeSupervisor();
    const logs = await client.getRuntimeLogs({ level: 'warn', limit: 5 });

    expect(calls.map(call => call.url)).toContain('/runtime/start-run');
    expect(calls.map(call => call.url)).toContain('/runtime/start-takeover');
    expect(calls.map(call => call.url)).toContain('/runtime/stop');
    expect(calls.map(call => call.url)).toContain('/runtime/pause');
    expect(calls.map(call => call.url)).toContain('/runtime/resume');
    expect(logs[0]?.level).toBe('warn');
  });

  it('wraps stage 5 sessions, events, readiness, preview, and roster validation endpoints', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = makeFetch({
      '/runtime/sessions?kind=run': {
        sessions: [{ id: 's1', kind: 'run', status: 'stale', goal: 'Ship', runtime: 'codex', startedAt: 1 }],
      },
      '/runtime/sessions/s1': {
        session: { id: 's1', kind: 'run', status: 'stale', goal: 'Ship', runtime: 'codex', startedAt: 1 },
      },
      '/runtime/events?sessionId=s1&eventType=runtime.started&limit=10': {
        events: [{ id: 'e1', sessionId: 's1', timestamp: 2, level: 'info', source: 'host', eventType: 'runtime.started', message: 'started' }],
      },
      '/runtime/readiness': {
        providers: {
          claude: { name: 'claude', available: true, authenticated: false, ready: false, message: 'login required' },
          codex: { name: 'codex', available: true, authenticated: true, ready: true, message: 'ready' },
          github: { name: 'github', available: true, authenticated: true, ready: true, message: 'ready' },
        },
        selectedRuntimeReady: { claude: false, codex: true },
      },
      '/runtime/takeover-preview': {
        projectPath: '/repo',
        projectName: 'repo',
        languages: ['typescript'],
        frameworks: ['react'],
        packageManagers: ['pnpm'],
        packageScripts: ['test'],
        ciProviders: ['github-actions'],
        testFrameworks: ['vitest'],
        hasReadme: true,
        hasDocs: false,
        codeRoots: ['src'],
        issueTracker: 'github',
        inferredGoal: 'Advance repo',
        generatedAgentRoster: { runtime: 'codex', goal: 'Advance repo', source: 'takeover-preview', projectPath: '/repo', agents: [] },
        warnings: ['docs directory not detected.'],
      },
      '/runtime/validate-roster': { valid: true, errors: [], warnings: [] },
    }, calls);
    const client = new WanmanCockpitClient({ fetchImpl, controlUrl: '' });

    const sessions = await client.listSessions({ kind: 'run' });
    const session = await client.getSession('s1');
    const events = await client.getRuntimeEvents({ sessionId: 's1', eventType: 'runtime.started', limit: 10 });
    const readiness = await client.getRuntimeReadiness();
    const preview = await client.previewTakeover({ projectPath: '/repo', runtime: 'codex' });
    const validation = await client.validateAgentRoster({ runtime: 'codex', goal: 'Ship', source: 'default', agents: [] });

    expect(sessions[0]?.status).toBe('stale');
    expect(session?.id).toBe('s1');
    expect(events[0]?.eventType).toBe('runtime.started');
    expect(readiness.selectedRuntimeReady.codex).toBe(true);
    expect(preview.generatedAgentRoster.goal).toBe('Advance repo');
    expect(validation.valid).toBe(true);
  });
});

describe('Stage 4 runtime validation helpers', () => {
  it('validates goals and project paths without executing shell commands', () => {
    expect(validateGoal('')).toContain('Goal');
    expect(validateGoal('  ship it  ')).toBeNull();
    expect(validateProjectPath('')).toContain('Project path');
    expect(validateProjectPath('~/repo && rm -rf /')).toContain('shell control');
    expect(validateProjectPath('/Users/example/repo')).toBeNull();
  });

  it('rejects duplicate names, unsafe names, and codex idle_cached agents', () => {
    const draft: AgentRosterDraft = {
      runtime: 'codex',
      goal: 'Build',
      source: 'default',
      agents: [
        { name: 'ceo', enabled: true, lifecycle: '24/7', runtime: 'codex', model: 'high', roleSummary: 'Lead' },
        { name: 'ceo', enabled: true, lifecycle: 'on-demand', runtime: 'codex', model: 'standard', roleSummary: 'Duplicate' },
        { name: 'bad name', enabled: true, lifecycle: 'on-demand', runtime: 'codex', model: 'standard', roleSummary: 'Unsafe' },
        { name: 'memory', enabled: true, lifecycle: 'idle_cached', runtime: 'codex', model: 'standard', roleSummary: 'Invalid' },
      ],
    };

    const result = validateAgentRosterDraft(draft);

    expect(result.valid).toBe(false);
    expect(result.errors.map(error => error.field)).toContain('agents[1].name');
    expect(result.errors.map(error => error.field)).toContain('agents[2].name');
    expect(result.errors.map(error => error.field)).toContain('agents[3].lifecycle');
  });
});
