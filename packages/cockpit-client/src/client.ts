import type {
  Agent,
  AgentLifecycle,
  AgentState,
  AgentRosterDraft,
  AgentRosterValidationResult,
  RuntimeAuthProvider,
  RuntimeLogLevel,
  RuntimeReadiness,
  RuntimeLogEntry,
  RuntimeStatus,
  RunSession,
  TakeoverPreview,
  Artifact,
  ContextEntry,
  HealthResult,
  HumanAction,
  HumanActionKind,
  LoopInfo,
  RuntimeStats,
  SendMessageInput,
  Story,
  Task,
  TaskScopeType,
  TaskStatus,
  Thread,
  ThreadMessage,
  StartRunInput,
  StartTakeoverInput,
} from './view-models.js';
import { mapArtifactsToTask } from './workflow.js';

// ── Wire shapes from supervisor ──

interface RawAgentEntry {
  name: string;
  state: string;
  lifecycle: string;
  model?: string;
  runtime?: 'claude' | 'codex';
}

interface RawHealthResponse {
  status: string;
  agents: RawAgentEntry[];
  timestamp: string;
  loop?: { runId: string; currentLoop: number };
  runtime?: {
    completedRuns?: number;
    completedRunsByAgent?: Record<string, number>;
    initiatives?: number;
    activeInitiatives?: number;
    capsules?: number;
    activeCapsules?: number;
  };
}

interface RawTask {
  id: string;
  title: string;
  description?: string;
  scope?: { paths: string[]; patterns?: string[] };
  status: string;
  assignee?: string | null;
  priority?: number;
  createdAt?: number;
  updatedAt?: number;
  dependsOn?: string[];
  result?: string | null;
  initiativeId?: string | null;
  capsuleId?: string | null;
  subsystem?: string | null;
  scopeType?: TaskScopeType | null;
}

interface RawContextEntry {
  key: string;
  value: string;
  updatedBy: string;
  updatedAt: number;
}

// db9 executeSQL returns an unknown shape; we handle both array and {rows:[]} forms.
type SqlResult = unknown;

// ── Wire shapes for thread / human RPCs ──

interface RawThreadMessage {
  id: string;
  from: string;
  to: string;
  type: string;
  priority: 'steer' | 'normal';
  payload: unknown;
  timestamp: number;
  delivered: boolean;
}

interface RawThread {
  id: string;
  participants: string[];
  lastMessage: RawThreadMessage | null;
  messageCount: number;
  pendingForHuman: boolean;
}

interface RawHumanInboxItem {
  id: string;
  from: string;
  type: string;
  payload: unknown;
  priority: 'steer' | 'normal';
  timestamp: number;
  handled: boolean;
  handledAt: number | null;
}

function mapThreadMessage(raw: RawThreadMessage): ThreadMessage {
  return {
    id: raw.id,
    from: raw.from,
    to: raw.to,
    type: raw.type,
    priority: raw.priority,
    payload: raw.payload,
    timestamp: raw.timestamp,
    delivered: raw.delivered,
  };
}

function mapThread(raw: RawThread): Thread {
  return {
    id: raw.id,
    participants: raw.participants,
    lastMessage: raw.lastMessage ? mapThreadMessage(raw.lastMessage) : null,
    messageCount: raw.messageCount,
    pendingForHuman: raw.pendingForHuman,
  };
}

function humanInboxItemToAction(item: RawHumanInboxItem): HumanAction {
  const kind: HumanActionKind =
    item.type === 'decision' ? 'decision' :
    item.type === 'blocker' || item.type === 'access_request' ? item.type as HumanActionKind :
    'decision';

  let summary = `${item.from} → human: ${item.type}`;
  if (item.payload && typeof item.payload === 'object') {
    const p = item.payload as Record<string, unknown>;
    if (typeof p['message'] === 'string') summary = p['message'].slice(0, 120);
    else if (typeof p['summary'] === 'string') summary = p['summary'].slice(0, 120);
    else if (typeof p['text'] === 'string') summary = p['text'].slice(0, 120);
  } else if (typeof item.payload === 'string') {
    summary = (item.payload as string).slice(0, 120);
  }

  return {
    id: `human_inbox:${item.id}`,
    kind,
    summary,
    originator: item.from,
    relatedAgent: item.from,
    relatedThreadId: `human|${item.from}`,
    priority: item.priority,
    createdAt: item.timestamp,
    payload: item.payload,
    handled: item.handled,
    handledAt: item.handledAt,
  };
}

interface ArtifactRow {
  id: number;
  agent: string;
  kind: string;
  path?: string | null;
  content_length?: number | null;
  content?: string | null;
  metadata?: unknown;
  created_at?: string | null;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  assignee?: string;
  priority?: number;
  scope?: {
    paths: string[];
    patterns?: string[];
  };
  dependsOn?: string[];
  initiativeId?: string;
  capsuleId?: string;
  subsystem?: string;
  scopeType?: TaskScopeType;
}

export interface UpdateTaskInput {
  id: string;
  status?: string;
  assignee?: string;
  result?: string;
  initiativeId?: string;
  capsuleId?: string;
  subsystem?: string;
  scopeType?: TaskScopeType;
}

export interface ReviewArtifactInput {
  artifactId: string;
  status: 'accepted' | 'revision_needed';
  note?: string;
  relatedTaskId?: string;
}

// ── Helpers ──

const BRAIN_ERROR_PHRASES = ['brain not initialized', 'brain not configured'];

function isBrainError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return BRAIN_ERROR_PHRASES.some(p => lower.includes(p));
}

/** Thrown by listArtifacts when the db9 brain is not configured. Distinct from real errors. */
export class BrainAbsentError extends Error {
  readonly isBrainAbsent = true as const;
  constructor() {
    super('Artifact brain not configured — start supervisor with a brain config block');
    this.name = 'BrainAbsentError';
  }
}

export function isBrainAbsentError(err: unknown): err is BrainAbsentError {
  return err instanceof BrainAbsentError;
}

function extractRows(result: SqlResult): ArtifactRow[] {
  if (Array.isArray(result)) return result as ArtifactRow[];
  if (
    result !== null &&
    typeof result === 'object' &&
    'rows' in result &&
    Array.isArray((result as Record<string, unknown>)['rows'])
  ) {
    return (result as { rows: ArtifactRow[] }).rows;
  }
  return [];
}

function mapArtifactRow(row: ArtifactRow): Artifact {
  const meta =
    row.metadata !== null && typeof row.metadata === 'object'
      ? (row.metadata as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const confidence = typeof meta['confidence'] === 'number' ? meta['confidence'] : 0;
  const verified = meta['verified'] === true;
  const taskId = typeof meta['taskId'] === 'string' ? meta['taskId'] : null;
  const reviewStatus =
    meta['reviewStatus'] === 'accepted' || meta['reviewStatus'] === 'revision_needed'
      ? meta['reviewStatus']
      : null;
  const reviewNote = typeof meta['reviewNote'] === 'string' ? meta['reviewNote'] : null;
  const createdMs = row.created_at ? new Date(row.created_at).getTime() : 0;
  return {
    id: String(row.id),
    kind: row.kind ?? 'unknown',
    agent: row.agent ?? 'unknown',
    path: row.path ?? null,
    contentLength: row.content_length ?? null,
    content: row.content ?? null,
    metadata: meta,
    confidence,
    verified,
    taskId,
    reviewStatus,
    reviewNote,
    createdAt: createdMs,
  };
}

function mapTask(raw: RawTask, allTasks: RawTask[]): Task {
  const dependsOn = raw.dependsOn ?? [];
  let status = raw.status as TaskStatus;

  // Derive 'blocked': task is pending/assigned and at least one dependency has failed.
  if ((status === 'pending' || status === 'assigned') && dependsOn.length > 0) {
    const hasFailedDep = dependsOn.some(depId => {
      const dep = allTasks.find(t => t.id === depId || t.id.startsWith(depId));
      return dep !== undefined && dep.status === 'failed';
    });
    if (hasFailedDep) status = 'blocked';
  }

  return {
    id: raw.id,
    shortId: raw.id.slice(0, 8),
    title: raw.title ?? '(untitled)',
    description: raw.description ?? '',
    status,
    assignee: raw.assignee ?? null,
    priority: raw.priority ?? 5,
    scope: raw.scope,
    dependsOn,
    initiativeId: raw.initiativeId ?? null,
    capsuleId: raw.capsuleId ?? null,
    subsystem: raw.subsystem ?? null,
    scopeType: raw.scopeType ?? null,
    result: raw.result ?? null,
    createdAt: raw.createdAt ?? 0,
    updatedAt: raw.updatedAt ?? 0,
  };
}

// ── Client ──

export interface WanmanCockpitClientOptions {
  /**
   * Supervisor base URL. Defaults to '' (relative paths, proxied by Vite in dev).
   * Set VITE_WANMAN_URL to override at build time.
   */
  baseUrl?: string;
  /** Local host-control bridge URL. Defaults to '' (same-origin Vite bridge). */
  controlUrl?: string;
  /** Fetch implementation override — useful for tests. */
  fetchImpl?: typeof fetch;
}

export class WanmanCockpitClient {
  readonly baseUrl: string;
  readonly controlUrl: string;
  private readonly _fetch: typeof fetch;
  private _idCounter = 0;

  constructor(opts: WanmanCockpitClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? '';
    this.controlUrl = opts.controlUrl ?? '';
    this._fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private nextId(): number {
    return ++this._idCounter;
  }

  private async rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const res = await this._fetch(`${this.baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId(), method, params }),
    });
    if (!res.ok) {
      throw Object.assign(new Error(`HTTP ${res.status} from supervisor`), {
        code: res.status,
        isRpcError: true,
      });
    }
    const json = (await res.json()) as {
      result?: T;
      error?: { code: number; message: string };
    };
    if (json.error) {
      const rpcErr = Object.assign(new Error(json.error.message), {
        code: json.error.code,
        isRpcError: true,
      });
      throw rpcErr;
    }
    return json.result as T;
  }

  private async control<T>(
    path: string,
    opts: { method?: 'GET' | 'POST'; body?: unknown } = {},
  ): Promise<T> {
    const res = await this._fetch(`${this.controlUrl}${path}`, {
      method: opts.method ?? 'GET',
      headers: opts.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    if (!res.ok) {
      let message = `HTTP ${res.status} from ${path}`;
      try {
        const json = await res.json() as { error?: { message?: string } | string };
        if (typeof json.error === 'string') message = json.error;
        else if (json.error?.message) message = json.error.message;
      } catch {
        // keep HTTP fallback
      }
      throw Object.assign(new Error(`HTTP ${res.status} from ${path}`), {
        code: res.status,
        isControlError: true,
        message,
      });
    }
    return await res.json() as T;
  }

  // ── Health ──

  async getHealth(): Promise<HealthResult> {
    const res = await this._fetch(`${this.baseUrl}/health`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from /health`);
    }
    const h = (await res.json()) as RawHealthResponse;
    const runsByAgent = h.runtime?.completedRunsByAgent ?? {};

    const agents: Agent[] = (h.agents ?? []).map(a => ({
      name: a.name,
      state: a.state as AgentState,
      lifecycle: a.lifecycle as AgentLifecycle,
      runtime: a.runtime,
      model: a.model ?? '',
      completedRuns: runsByAgent[a.name] ?? 0,
    }));

    const runtime: RuntimeStats = {
      completedRuns: h.runtime?.completedRuns ?? 0,
      agents: agents.length,
      activeInitiatives: h.runtime?.activeInitiatives ?? 0,
      activeCapsules: h.runtime?.activeCapsules ?? 0,
    };

    const loop: LoopInfo | null = h.loop
      ? { runId: h.loop.runId, currentLoop: h.loop.currentLoop }
      : null;

    return {
      status: h.status === 'ok' ? 'ok' : 'degraded',
      agents,
      loop,
      runtime,
      timestamp: new Date(h.timestamp).getTime() || Date.now(),
    };
  }

  // ── Story ──

  async getStory(storyId?: string): Promise<Story> {
    const health = await this.getHealth();
    return {
      id: storyId ?? 'local',
      title: 'Wanman Supervisor',
      goal: null,
      supervisorUrl: this.baseUrl || 'http://localhost:3120',
      connection: 'connected',
      runtimeStats: health.runtime,
      loop: health.loop,
      lastUpdatedAt: health.timestamp,
    };
  }

  // ── Agents ──

  async listAgents(): Promise<Agent[]> {
    const [listResult, health] = await Promise.all([
      this.rpc<{ agents: RawAgentEntry[] }>('agent.list'),
      this.getHealth().catch(() => null),
    ]);

    const runsByAgent: Record<string, number> = health
      ? Object.fromEntries(health.agents.map(a => [a.name, a.completedRuns]))
      : {};
    const stateByName: Record<string, AgentState> = health
      ? Object.fromEntries(health.agents.map(a => [a.name, a.state]))
      : {};

    return (listResult.agents ?? []).map(a => ({
      name: a.name,
      state: (stateByName[a.name] ?? a.state) as AgentState,
      lifecycle: a.lifecycle as AgentLifecycle,
      runtime: a.runtime,
      model: a.model ?? '',
      completedRuns: runsByAgent[a.name] ?? 0,
    }));
  }

  // ── Runtime control ──

  async getRuntimeStatus(): Promise<RuntimeStatus> {
    try {
      return await this.control<RuntimeStatus>('/runtime/status');
    } catch {
      try {
        const [health, authResult] = await Promise.all([
          this.getHealth(),
          this.rpc<{ providers: RuntimeAuthProvider[] }>('auth.providers').catch(() => ({ providers: [] })),
        ]);
        const paused = health.agents.length > 0 && health.agents.every(agent => agent.state === 'paused');
        return {
          hostBridge: false,
          supervisor: {
            connection: 'connected',
            url: this.baseUrl || 'http://localhost:3120',
            status: paused ? 'paused' : 'running',
            error: null,
          },
          activeSession: health.loop
            ? {
                id: health.loop.runId,
                kind: 'run',
                status: paused ? 'paused' : 'running',
                goal: '',
                runtime: health.agents.find(agent => agent.runtime)?.runtime ?? 'claude',
                supervisorUrl: this.baseUrl || 'http://localhost:3120',
                startedAt: health.timestamp,
              }
            : null,
          currentGoal: null,
          currentRuntime: health.agents.find(agent => agent.runtime)?.runtime ?? null,
          agents: health.agents,
          loop: health.loop,
          lastEvent: null,
          auth: authResult.providers ?? [],
          capabilities: {
            startRun: false,
            startTakeover: false,
            stopSession: false,
            pause: true,
            resume: true,
            logs: false,
            events: false,
            sessions: false,
            takeoverPreview: false,
          },
        };
      } catch (err) {
        return {
          hostBridge: false,
          supervisor: {
            connection: 'not_running',
            url: this.baseUrl || 'http://localhost:3120',
            status: 'stopped',
            error: err instanceof Error ? err.message : String(err),
          },
          activeSession: null,
          currentGoal: null,
          currentRuntime: null,
          agents: [],
          loop: null,
          lastEvent: null,
          auth: [],
          capabilities: {
            startRun: false,
            startTakeover: false,
            stopSession: false,
            pause: false,
            resume: false,
            logs: false,
            events: false,
            sessions: false,
            takeoverPreview: false,
          },
        };
      }
    }
  }

  async listSessions(filter?: {
    status?: string;
    kind?: 'run' | 'takeover';
  }): Promise<RunSession[]> {
    const params = new URLSearchParams();
    if (filter?.status) params.set('status', filter.status);
    if (filter?.kind) params.set('kind', filter.kind);
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    const result = await this.control<{ sessions: RunSession[] }>(`/runtime/sessions${suffix}`);
    return result.sessions ?? [];
  }

  async getSession(id: string): Promise<RunSession | null> {
    const result = await this.control<{ session: RunSession | null }>(`/runtime/sessions/${encodeURIComponent(id)}`);
    return result.session ?? null;
  }

  async startRun(input: StartRunInput): Promise<RunSession> {
    return await this.control<RunSession>('/runtime/start-run', { method: 'POST', body: input });
  }

  async startTakeover(input: StartTakeoverInput): Promise<RunSession> {
    return await this.control<RunSession>('/runtime/start-takeover', { method: 'POST', body: input });
  }

  async stopSession(input: { sessionId?: string; reason?: string } = {}): Promise<void> {
    await this.control<{ status: string }>('/runtime/stop', { method: 'POST', body: input });
  }

  async getLogStatus(): Promise<{
    currentSizeBytes: number
    archiveCount: number
    totalSizeBytes: number
    maxSizeBytes: number
    maxFiles: number
    archiveFiles: string[]
  }> {
    return await this.control('/runtime/log-status');
  }

  async forkSession(input: { sessionId: string; goalOverride?: string }): Promise<RunSession> {
    const result = await this.control<{ session: RunSession }>('/runtime/sessions/fork', { method: 'POST', body: input });
    return result.session;
  }

  async pauseSupervisor(input?: { sessionId?: string }): Promise<void> {
    await this.control<{ status: string }>('/runtime/pause', { method: 'POST', body: input ?? {} });
  }

  async resumeSupervisor(input?: { sessionId?: string }): Promise<void> {
    await this.control<{ status: string }>('/runtime/resume', { method: 'POST', body: input ?? {} });
  }

  async getRuntimeEvents(filter?: {
    sessionId?: string;
    agent?: string;
    level?: RuntimeLogLevel;
    eventType?: string;
    since?: number;
    limit?: number;
  }): Promise<RuntimeLogEntry[]> {
    const params = new URLSearchParams();
    if (filter?.sessionId) params.set('sessionId', filter.sessionId);
    if (filter?.agent) params.set('agent', filter.agent);
    if (filter?.level) params.set('level', filter.level);
    if (filter?.eventType) params.set('eventType', filter.eventType);
    if (filter?.since !== undefined) params.set('since', String(filter.since));
    if (filter?.limit !== undefined) params.set('limit', String(filter.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    const result = await this.control<{ events: RuntimeLogEntry[] }>(`/runtime/events${suffix}`);
    return result.events ?? [];
  }

  async getRuntimeLogs(filter?: {
    sessionId?: string;
    agent?: string;
    level?: RuntimeLogLevel;
    eventType?: string;
    since?: number;
    limit?: number;
  }): Promise<RuntimeLogEntry[]> {
    const params = new URLSearchParams();
    if (filter?.sessionId) params.set('sessionId', filter.sessionId);
    if (filter?.agent) params.set('agent', filter.agent);
    if (filter?.level) params.set('level', filter.level);
    if (filter?.eventType) params.set('eventType', filter.eventType);
    if (filter?.since !== undefined) params.set('since', String(filter.since));
    if (filter?.limit !== undefined) params.set('limit', String(filter.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    try {
      const result = await this.control<{ logs: RuntimeLogEntry[] }>(`/runtime/logs${suffix}`);
      return result.logs ?? [];
    } catch {
      const result = await this.rpc<{ logs: RuntimeLogEntry[] }>(
        'runtime.logs',
        filter as Record<string, unknown> | undefined,
      );
      return result.logs ?? [];
    }
  }

  async previewTakeover(input: {
    projectPath: string;
    goalOverride?: string;
    runtime: 'claude' | 'codex';
  }): Promise<TakeoverPreview> {
    return await this.control<TakeoverPreview>('/runtime/takeover-preview', { method: 'POST', body: input });
  }

  async getRuntimeReadiness(): Promise<RuntimeReadiness> {
    return await this.control<RuntimeReadiness>('/runtime/readiness');
  }

  async getAgentRosterDraft(input?: {
    projectPath?: string;
    runtime?: 'claude' | 'codex';
    goal?: string;
  }): Promise<AgentRosterDraft> {
    const params = new URLSearchParams();
    if (input?.projectPath) params.set('projectPath', input.projectPath);
    if (input?.runtime) params.set('runtime', input.runtime);
    if (input?.goal) params.set('goal', input.goal);
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return await this.control<AgentRosterDraft>(`/runtime/roster-draft${suffix}`);
  }

  async validateAgentRoster(input: AgentRosterDraft): Promise<AgentRosterValidationResult> {
    return await this.control<AgentRosterValidationResult>('/runtime/validate-roster', { method: 'POST', body: input });
  }

  // ── Tasks ──

  async listTasks(filter?: {
    status?: TaskStatus;
    assignee?: string;
    initiativeId?: string;
    capsuleId?: string;
  }): Promise<Task[]> {
    // Fetch all tasks so we can derive 'blocked' client-side before filtering.
    const params: Record<string, unknown> = {};
    if (filter?.assignee) params['assignee'] = filter.assignee;
    if (filter?.initiativeId) params['initiativeId'] = filter.initiativeId;
    if (filter?.capsuleId) params['capsuleId'] = filter.capsuleId;

    const result = await this.rpc<{ tasks: RawTask[] }>(
      'task.list',
      Object.keys(params).length > 0 ? params : undefined,
    );
    const rawTasks = result.tasks ?? [];
    const mapped = rawTasks.map(t => mapTask(t, rawTasks));

    if (filter?.status !== undefined) {
      return mapped.filter(t => t.status === filter.status);
    }
    return mapped;
  }

  async getTask(id: string): Promise<Task | null> {
    try {
      const [raw, allResult] = await Promise.all([
        this.rpc<RawTask>('task.get', { id }),
        this.rpc<{ tasks: RawTask[] }>('task.list').catch(() => ({ tasks: [] as RawTask[] })),
      ]);
      if (!raw) return null;
      return mapTask(raw, allResult.tasks);
    } catch {
      return null;
    }
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const result = await this.rpc<RawTask>('task.create', {
      ...input,
      agent: 'cockpit',
    });
    return mapTask(result, [result]);
  }

  async updateTask(input: UpdateTaskInput): Promise<Task> {
    const { id, ...updates } = input;
    const result = await this.rpc<RawTask>('task.update', {
      id,
      ...updates,
      agent: 'cockpit',
    });
    return mapTask(result, [result]);
  }

  async assignTask(input: { taskId: string; assignee: string }): Promise<Task> {
    return this.updateTask({ id: input.taskId, assignee: input.assignee });
  }

  async markTaskComplete(input: {
    taskId: string;
    result: string;
    artifactIds?: string[];
  }): Promise<Task> {
    const artifactSuffix =
      input.artifactIds && input.artifactIds.length > 0
        ? `\n\nArtifacts: ${input.artifactIds.join(', ')}`
        : '';
    return this.updateTask({
      id: input.taskId,
      status: 'done',
      result: `${input.result.trim()}${artifactSuffix}`,
    });
  }

  async returnTaskForRevision(input: {
    taskId: string;
    reason: string;
    assignee?: string | null;
    notifyAssignee?: boolean;
  }): Promise<Task> {
    const updated = await this.updateTask({
      id: input.taskId,
      status: 'in_progress',
      result: input.reason.trim(),
    });
    const assignee = input.assignee ?? updated.assignee;
    if (input.notifyAssignee && assignee) {
      await this.sendMessage({
        to: assignee,
        type: 'blocker_response',
        payload: {
          message: input.reason.trim(),
          relatedTaskId: input.taskId,
          reviewAction: 'revision_needed',
        },
        priority: 'normal',
        relatedTaskId: input.taskId,
      });
    }
    return updated;
  }

  // ── Threads / messages (read-only, non-destructive) ──

  /**
   * List message threads. Uses thread.list RPC (non-destructive — never calls agent.recv).
   * Returns [] gracefully if the RPC is unavailable.
   */
  async listThreads(filter?: {
    agent?: string;
    taskId?: string;
    humanOnly?: boolean;
  }): Promise<Thread[]> {
    try {
      const params: Record<string, unknown> = {};
      if (filter?.agent) params['agent'] = filter.agent;
      if (filter?.humanOnly) params['humanOnly'] = true;
      const result = await this.rpc<{ threads: RawThread[] }>(
        'thread.list',
        Object.keys(params).length > 0 ? params : undefined,
      );
      let threads = (result.threads ?? []).map(mapThread);
      // Best-effort: if taskId filter requested, match messages that mention the task id
      if (filter?.taskId) {
        threads = threads.filter(t =>
          JSON.stringify(t.lastMessage?.payload ?? '').includes(filter.taskId!)
        );
      }
      return threads;
    } catch (err) {
      // Gracefully degrade if thread.list is not available
      if (err instanceof Error && (err.message.includes('METHOD_NOT_FOUND') || err.message.includes('-32601') || err.message.includes('Unknown method'))) {
        return [];
      }
      throw err;
    }
  }

  /** Get a thread with its full message timeline. Returns null if not found or RPC unavailable. */
  async getThread(id: string): Promise<{ thread: Thread; messages: ThreadMessage[] } | null> {
    try {
      const result = await this.rpc<{ thread: RawThread; messages: RawThreadMessage[] }>(
        'thread.get',
        { id },
      );
      if (!result?.thread) return null;
      return {
        thread: mapThread(result.thread),
        messages: (result.messages ?? []).map(mapThreadMessage),
      };
    } catch (err) {
      if (err instanceof Error && (err.message.includes('METHOD_NOT_FOUND') || err.message.includes('-32601') || err.message.includes('Unknown method'))) {
        return null;
      }
      throw err;
    }
  }

  // ── Artifacts ──

  /**
   * Returns [] gracefully when the db9 brain is not configured.
   * Never throws for brain-not-initialized errors.
   */
  async listArtifacts(filter?: {
    agent?: string;
    kind?: string;
    verified?: boolean;
  }): Promise<Artifact[]> {
    const params: Record<string, unknown> = {};
    if (filter?.agent) params['agent'] = filter.agent;
    if (filter?.kind) params['kind'] = filter.kind;
    if (filter?.verified !== undefined) params['verified'] = filter.verified;

    try {
      const result = await this.rpc<SqlResult>(
        'artifact.list',
        Object.keys(params).length > 0 ? params : undefined,
      );
      return extractRows(result).map(mapArtifactRow);
    } catch (err) {
      if (err instanceof Error && isBrainError(err.message)) throw new BrainAbsentError();
      throw err;
    }
  }

  async getArtifact(id: string): Promise<Artifact | null> {
    try {
      const result = await this.rpc<SqlResult>('artifact.get', {
        id: parseInt(id, 10),
      });
      const rows = extractRows(result);
      const first = rows[0];
      if (!first) return null;
      return mapArtifactRow(first);
    } catch (err) {
      if (err instanceof Error && isBrainError(err.message)) return null;
      throw err;
    }
  }

  async listArtifactsForTask(taskId: string): Promise<Artifact[]> {
    const [artifacts, task] = await Promise.all([
      this.listArtifacts(),
      this.getTask(taskId),
    ]);
    if (!task) {
      return artifacts.filter(artifact => artifact.taskId === taskId);
    }
    return mapArtifactsToTask(task, artifacts);
  }

  async reviewArtifact(_input: ReviewArtifactInput): Promise<Artifact | null> {
    // Stage 3 has no stable artifact metadata mutation RPC. The cockpit keeps
    // review state locally until a minimal artifact.updateMetadata endpoint exists.
    return null;
  }

  // ── Context ──

  async listContext(): Promise<ContextEntry[]> {
    const result = await this.rpc<{ entries?: RawContextEntry[] }>('context.list');
    return (result.entries ?? []).map(e => ({
      key: e.key,
      value: e.value,
      updatedBy: e.updatedBy,
      updatedAt: e.updatedAt,
    }));
  }

  // ── Human Inbox ──

  /**
   * Lists HumanActions from:
   *   1. human.list RPC (persisted human-bound messages) — rich, handled state included
   *   2. Derived from live agent + task state — best-effort fallback
   *
   * Merges both sources; human.list entries take precedence by id.
   */
  async listHumanActions(filter?: {
    status?: 'open' | 'handled';
    kind?: HumanActionKind;
  }): Promise<HumanAction[]> {
    const [agents, tasks, humanItems] = await Promise.all([
      this.listAgents().catch((): Agent[] => []),
      this.listTasks().catch((): Task[] => []),
      this.rpc<{ items: RawHumanInboxItem[] }>('human.list', filter?.status ? { status: filter.status } : undefined)
        .then(r => r.items ?? [])
        .catch((): RawHumanInboxItem[] => []),
    ]);

    const actions: HumanAction[] = [];
    const seenIds = new Set<string>();

    // Human inbox items from human.list take precedence
    for (const item of humanItems) {
      const action = humanInboxItemToAction(item);
      if (filter?.kind && action.kind !== filter.kind) continue;
      actions.push(action);
      seenIds.add(action.id);
    }

    // Only add derived actions when not filtering for 'handled' (derived never have handled state)
    if (filter?.status !== 'handled') {
      for (const agent of agents) {
        if (agent.state === 'error') {
          const id = `agent_error:${agent.name}`;
          if (!seenIds.has(id)) {
            actions.push({
              id,
              kind: 'agent_error',
              summary: `${agent.name} is in error state — supervisor will retry`,
              originator: 'system',
              relatedAgent: agent.name,
              priority: 'steer',
              createdAt: Date.now(),
              handled: false,
            });
          }
        }
      }

      for (const task of tasks) {
        if (task.status === 'review') {
          const id = `task_review:${task.id}`;
          if (!seenIds.has(id) && (!filter?.kind || filter.kind === 'task_review')) {
            actions.push({
              id,
              kind: 'task_review',
              summary: `Review needed: "${task.title}"`,
              originator: task.assignee ?? 'system',
              relatedTaskId: task.id,
              relatedAgent: task.assignee,
              priority: 'normal',
              createdAt: task.updatedAt,
              handled: false,
            });
          }
        }
        if (task.status === 'failed') {
          const id = `task_failed:${task.id}`;
          if (!seenIds.has(id) && (!filter?.kind || filter.kind === 'task_review')) {
            actions.push({
              id,
              kind: 'task_review',
              summary: `Task failed: "${task.title}"`,
              originator: task.assignee ?? 'system',
              relatedTaskId: task.id,
              relatedAgent: task.assignee,
              priority: 'normal',
              createdAt: task.updatedAt,
              handled: false,
            });
          }
        }
        if (task.status === 'blocked') {
          const id = `task_blocked:${task.id}`;
          if (!seenIds.has(id) && (!filter?.kind || filter.kind === 'blocker')) {
            actions.push({
              id,
              kind: 'blocker',
              summary: `Blocked on failed dependency: "${task.title}"`,
              originator: 'system',
              relatedTaskId: task.id,
              relatedAgent: task.assignee,
              priority: 'normal',
              createdAt: task.updatedAt,
              handled: false,
            });
          }
        }
      }
    }

    // steer-priority first; within a bucket oldest-first
    return actions.sort((a, b) => {
      if (a.priority === 'steer' && b.priority !== 'steer') return -1;
      if (b.priority === 'steer' && a.priority !== 'steer') return 1;
      return a.createdAt - b.createdAt;
    });
  }

  // ── Message sending ──

  /** Send a message to an agent. Uses agent.send semantics. */
  async sendMessage(input: SendMessageInput): Promise<void> {
    const { to, from = 'human', type = 'message', payload, priority = 'normal' } = input;
    const params: Record<string, unknown> = {
      from,
      to,
      type,
      payload: typeof payload === 'string' ? payload : payload,
      priority,
    };
    if (input.relatedTaskId) {
      // Embed task reference in payload if it's an object
      if (typeof payload === 'object' && payload !== null) {
        params['payload'] = { ...payload, relatedTaskId: input.relatedTaskId };
      }
    }
    await this.rpc<{ id: string; status: string }>('agent.send', params);
  }

  /**
   * Mark a human inbox item as handled.
   * Only affects human.list items (prefixed human_inbox:).
   * Derived items (agent_error:, task_review:, etc.) auto-resolve when state changes.
   */
  async markHumanActionHandled(id: string): Promise<void> {
    const inboxId = id.startsWith('human_inbox:') ? id.slice('human_inbox:'.length) : id;
    await this.rpc<{ ok: boolean }>('human.ack', { id: inboxId });
  }

  /**
   * Subscribe to the host's SSE event stream (`GET /runtime/events/stream`).
   * Falls back silently if EventSource is unavailable (e.g. server-side / test env).
   *
   * @param callback - Called for each incoming RuntimeLogEntry
   * @param options.since - Only receive events after this timestamp (for reconnect)
   * @param options.onStreamStatus - Called when stream connectivity changes
   * @returns Unsubscribe function
   */
  subscribeToEvents(
    callback: (event: RuntimeLogEntry) => void,
    options?: {
      since?: number
      onStreamStatus?: (status: 'streaming' | 'fallback') => void
    },
  ): () => void {
    let closed = false
    let es: EventSource | null = null

    if (typeof EventSource !== 'undefined') {
      // Persist the last-seen event timestamp across page refreshes so we can
      // resume from the cursor instead of replaying the full history.
      const CURSOR_KEY = 'wanman:sse-cursor'
      const storedCursor = (() => {
        try {
          const raw = sessionStorage.getItem(CURSOR_KEY)
          const n = Number(raw)
          return Number.isFinite(n) && n > 0 ? n : undefined
        } catch { return undefined }
      })()

      // Caller-supplied 'since' takes priority; fall back to persisted cursor.
      const since = options?.since ?? storedCursor

      const params = new URLSearchParams()
      if (since !== undefined) params.set('since', String(since))
      const suffix = params.size > 0 ? `?${params.toString()}` : ''
      const url = `${this.controlUrl}/runtime/events/stream${suffix}`

      es = new EventSource(url)
      es.onmessage = (ev: MessageEvent) => {
        if (closed) return
        try {
          const event = JSON.parse(ev.data as string) as RuntimeLogEntry
          // Update the cursor so reconnects resume without duplicates.
          if (typeof event.timestamp === 'number') {
            try { sessionStorage.setItem(CURSOR_KEY, String(event.timestamp)) } catch { /* ignore */ }
          }
          callback(event)
          options?.onStreamStatus?.('streaming')
        } catch {
          // ignore malformed frames
        }
      }
      es.onerror = () => {
        options?.onStreamStatus?.('fallback')
      }
    } else {
      options?.onStreamStatus?.('fallback')
    }

    return () => {
      closed = true
      es?.close()
    }
  }

  /** No long-lived connections in MVP (polling only). */
  dispose(): void {}
}
