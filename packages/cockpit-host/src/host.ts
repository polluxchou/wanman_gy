import * as fs from 'node:fs'
import * as path from 'node:path'
import * as http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentMatrixConfig } from '@wanman/core'
import { EventStore } from './event-store.js'
import { LocalProcessLauncher } from './launcher.js'
import { checkRuntimeReadiness } from './readiness.js'
import { createDefaultRoster, rosterToConfig, validateAgentRosterDraft } from './roster.js'
import { resolveSafePath, sanitizeMessage } from './safety.js'
import { SessionStore } from './session-store.js'
import { buildTakeoverPreview } from './takeover-preview.js'
import {
  validateStartRunInput,
  validateStartTakeoverInput,
} from './validation.js'
import type { LogStorageInfo } from './event-store.js'
import type {
  AgentRosterDraft,
  ForkSessionInput,
  ProcessLauncher,
  ReadinessRunner,
  RunSession,
  Runtime,
  RuntimeEventFilter,
  RuntimeEventLevel,
  RuntimeReadiness,
  RuntimeStatus,
  StartRunInput,
  StartTakeoverInput,
  SupervisorHandle,
} from './types.js'

// How many consecutive missed health checks before a session is marked stale.
const HEARTBEAT_STALE_AFTER = 3
// Interval between heartbeat health checks for active sessions.
const HEARTBEAT_INTERVAL_MS = 10_000
// SSE keepalive comment interval.
const SSE_KEEPALIVE_MS = 15_000

interface LocalControlHostOptions {
  repoRoot: string
  storageRoot?: string
  defaultSupervisorUrl?: string
  hostMode?: 'dev' | 'local'
  launcher?: ProcessLauncher
  readinessRunner?: ReadinessRunner
}

export class LocalControlHost {
  readonly repoRoot: string
  readonly storageRoot: string
  readonly sessions: SessionStore
  readonly events: EventStore
  private readonly defaultSupervisorUrl: string
  private readonly hostMode: 'dev' | 'local'
  private readonly launcher: ProcessLauncher
  private readonly readinessRunner?: ReadinessRunner
  private handles = new Map<string, SupervisorHandle>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private readonly heartbeatMisses = new Map<string, number>()

  constructor(options: LocalControlHostOptions) {
    this.repoRoot = path.resolve(options.repoRoot)
    this.storageRoot = path.resolve(options.storageRoot ?? path.join(this.repoRoot, '.wanman/cockpit'))
    this.sessions = new SessionStore(path.join(this.storageRoot, 'sessions'))
    this.events = new EventStore(path.join(this.storageRoot, 'events'))
    this.defaultSupervisorUrl = options.defaultSupervisorUrl ?? process.env['VITE_WANMAN_URL'] ?? 'http://localhost:3120'
    this.hostMode = options.hostMode ?? 'local'
    this.launcher = options.launcher ?? new LocalProcessLauncher(this.repoRoot)
    this.readinessRunner = options.readinessRunner
    this.startHeartbeat()
  }

  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  async getRuntimeStatus(): Promise<RuntimeStatus> {
    const active = this.sessions.active()
    const health = await this.fetchHealth(active).catch(() => null)
    const readiness = await this.getRuntimeReadiness()
    const agents = Array.isArray(health?.agents) ? health.agents as Array<Record<string, unknown>> : []
    const paused = agents.length > 0 && agents.every(agent => agent['state'] === 'paused')
    const running = Boolean(health)
    const activeStatus = active?.status === 'running' && paused ? 'paused' : active?.status

    return {
      hostBridge: true,
      hostMode: this.hostMode,
      supervisor: {
        connection: running ? 'connected' : active?.status === 'stale' ? 'error' : 'not_running',
        url: active?.supervisorUrl ?? this.defaultSupervisorUrl,
        status: running ? (paused ? 'paused' : 'running') : active?.status === 'stale' ? 'stale' : 'stopped',
        error: running ? null : active?.error ?? 'Supervisor is not reachable.',
      },
      activeSession: active ? { ...active, status: activeStatus ?? active.status } : null,
      currentGoal: active?.goal ?? null,
      currentRuntime: active?.runtime ?? null,
      agents,
      loop: health?.loop && typeof health.loop === 'object' ? health.loop as Record<string, unknown> : null,
      lastEvent: this.events.last(),
      auth: Object.values(readiness.providers),
      readiness,
      capabilities: {
        startRun: !active || ['stopped', 'error', 'stale'].includes(active.status),
        startTakeover: !active || ['stopped', 'error', 'stale'].includes(active.status),
        stopSession: active ? ['starting', 'running', 'paused'].includes(active.status) : false,
        pause: Boolean(active),
        resume: Boolean(active),
        logs: true,
        events: true,
        sessions: true,
        takeoverPreview: true,
      },
    }
  }

  listSessions(filter?: { status?: string; kind?: 'run' | 'takeover' }): RunSession[] {
    return this.sessions.list(filter)
  }

  getSession(id: string): RunSession | null {
    return this.sessions.get(id)
  }

  getRuntimeEvents(filter?: RuntimeEventFilter) {
    return this.events.query(filter)
  }

  getRuntimeLogs(filter?: RuntimeEventFilter) {
    return this.events.query(filter)
  }

  async startRun(input: StartRunInput): Promise<RunSession> {
    const valid = validateStartRunInput(input)
    if (!valid.ok) throw new Error(valid.error)
    this.assertNoActiveSession()
    const outputDir = resolveSafePath(this.repoRoot, valid.value.outputDir ?? '.wanman/cockpit/runs')
    const session = this.sessions.create({
      kind: 'run',
      status: 'starting',
      goal: valid.value.goal,
      runtime: valid.value.runtime,
      projectPath: this.repoRoot,
      outputDir,
      createdBy: 'cockpit',
      metadata: {
        loopMode: valid.value.loopMode,
        loops: valid.value.loops,
        pollInterval: valid.value.pollInterval,
        errorLimit: valid.value.errorLimit,
      },
    })
    this.events.append({ sessionId: session.id, level: 'info', source: 'host', eventType: 'runtime.starting', message: 'Starting Wanman run' })
    try {
      const config = rosterToConfig({ ...valid.value.roster, goal: valid.value.goal, runtime: valid.value.runtime })
      return await this.launchSession(session, config, valid.value)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failed = this.sessions.update(session.id, { status: 'error', error: message, endedAt: Date.now() }) ?? session
      this.events.append({ sessionId: session.id, level: 'error', source: 'host', eventType: 'runtime.error', message })
      return failed
    }
  }

  async startTakeover(input: StartTakeoverInput): Promise<RunSession> {
    const valid = validateStartTakeoverInput(input)
    if (!valid.ok) throw new Error(valid.error)
    if (valid.value.dryRun) {
      const preview = buildTakeoverPreview({
        projectPath: valid.value.projectPath,
        goalOverride: valid.value.goalOverride,
        runtime: valid.value.runtime,
      })
      this.events.append({ level: 'info', source: 'host', eventType: 'takeover.preview', message: 'Takeover preview generated', data: { projectPath: preview.projectPath } })
      return {
        id: `preview-${Date.now().toString(36)}`,
        kind: 'takeover',
        status: 'stopped',
        goal: preview.inferredGoal,
        runtime: valid.value.runtime,
        projectPath: preview.projectPath,
        startedAt: Date.now(),
        endedAt: Date.now(),
        createdBy: 'cockpit',
        metadata: { preview: true },
      }
    }

    this.assertNoActiveSession()
    const preview = buildTakeoverPreview({
      projectPath: valid.value.projectPath,
      goalOverride: valid.value.goalOverride,
      runtime: valid.value.runtime,
    })
    const outputDir = resolveSafePath(valid.value.projectPath, valid.value.outputDir ?? '.wanman/cockpit/takeover')
    const session = this.sessions.create({
      kind: 'takeover',
      status: 'starting',
      goal: preview.inferredGoal,
      runtime: valid.value.runtime,
      projectPath: preview.projectPath,
      outputDir,
      createdBy: 'cockpit',
      metadata: {
        noBrain: valid.value.noBrain === true,
        preview,
      },
    })
    this.events.append({ sessionId: session.id, level: 'info', source: 'host', eventType: 'runtime.starting', message: 'Starting Wanman takeover' })
    try {
      const config = rosterToConfig(preview.generatedAgentRoster)
      return await this.launchSession(session, config, valid.value)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failed = this.sessions.update(session.id, { status: 'error', error: message, endedAt: Date.now() }) ?? session
      this.events.append({ sessionId: session.id, level: 'error', source: 'host', eventType: 'runtime.error', message })
      return failed
    }
  }

  async stopSession(input: { sessionId?: string; reason?: string } = {}): Promise<void> {
    const session = this.findSession(input.sessionId)
    if (!session) return
    this.sessions.update(session.id, { status: 'stopping' })
    this.events.append({ sessionId: session.id, level: 'warn', source: 'host', eventType: 'runtime.stopping', message: 'Stopping Wanman session', data: { reason: input.reason ?? 'operator request' } })
    const handle = this.handles.get(session.id)
    await handle?.stop(true).catch(error => {
      const message = error instanceof Error ? error.message : String(error)
      this.events.append({ sessionId: session.id, level: 'error', source: 'host', eventType: 'runtime.stop_error', message })
    })
    this.handles.delete(session.id)
    this.heartbeatMisses.delete(session.id)
    this.sessions.update(session.id, { status: 'stopped', endedAt: Date.now() })
    this.events.append({ sessionId: session.id, level: 'info', source: 'host', eventType: 'runtime.stopped', message: 'Wanman session stopped' })
  }

  async pauseSupervisor(input: { sessionId?: string } = {}): Promise<void> {
    const session = this.findSession(input.sessionId)
    if (!session) return
    await this.rpc(session, 'supervisor.pause').catch(() => undefined)
    this.sessions.update(session.id, { status: 'paused' })
    this.events.append({ sessionId: session.id, level: 'info', source: 'host', eventType: 'runtime.paused', message: 'Supervisor paused' })
  }

  async resumeSupervisor(input: { sessionId?: string } = {}): Promise<void> {
    const session = this.findSession(input.sessionId)
    if (!session) return
    await this.rpc(session, 'supervisor.resume').catch(() => undefined)
    this.sessions.update(session.id, { status: 'running' })
    this.events.append({ sessionId: session.id, level: 'info', source: 'host', eventType: 'runtime.resumed', message: 'Supervisor resumed' })
  }

  previewTakeover(input: { projectPath: string; goalOverride?: string; runtime: Runtime }) {
    return buildTakeoverPreview(input)
  }

  getAgentRosterDraft(input?: { projectPath?: string; runtime?: Runtime; goal?: string }): AgentRosterDraft {
    const runtime = input?.runtime ?? 'claude'
    if (input?.projectPath) {
      return buildTakeoverPreview({ projectPath: input.projectPath, goalOverride: input.goal, runtime }).generatedAgentRoster
    }
    return createDefaultRoster(runtime, input?.goal ?? '')
  }

  validateAgentRoster(input: AgentRosterDraft) {
    return validateAgentRosterDraft(input)
  }

  async getRuntimeReadiness(): Promise<RuntimeReadiness> {
    return await checkRuntimeReadiness(this.readinessRunner)
  }

  getLogStatus(): LogStorageInfo {
    return this.events.getStorageInfo()
  }

  /**
   * Creates a new session inheriting goal, runtime, roster, and projectPath
   * from a previous (typically stale) session. Does NOT restart the old process.
   * The new session is returned in 'starting' state ready for a normal launch.
   */
  async forkSession(input: ForkSessionInput): Promise<RunSession> {
    const source = this.sessions.get(input.sessionId)
    if (!source) throw new Error(`Session ${input.sessionId} not found.`)
    this.assertNoActiveSession()
    const goal = input.goalOverride?.trim() || source.goal
    const forked = this.sessions.create({
      kind: source.kind,
      status: 'starting',
      goal,
      runtime: source.runtime,
      projectPath: source.projectPath,
      outputDir: source.outputDir
        ? source.outputDir.replace(/\/[^/]+$/, '')  // strip leaf session dir
        : undefined,
      createdBy: 'cockpit',
      metadata: {
        ...source.metadata,
        recoveredFrom: source.id,
      },
    })
    this.events.append({
      sessionId: forked.id,
      level: 'info',
      source: 'host',
      eventType: 'session.forked',
      message: `Session forked from ${source.id}`,
      data: { sourceSessionId: source.id, sourceStatus: source.status },
    })
    return forked
  }

  /** Public for testing: runs one heartbeat cycle against the active session. */
  async checkHeartbeat(): Promise<void> {
    const active = this.sessions.active()
    if (!active || !['running', 'paused'].includes(active.status)) return
    try {
      const health = await this.fetchHealth(active)
      if (health) {
        this.heartbeatMisses.delete(active.id)
        this.sessions.update(active.id, {
          lastHeartbeatAt: Date.now(),
          heartbeatStatus: 'healthy',
          heartbeatMisses: 0,
        })
      } else {
        this.recordHeartbeatMiss(active)
      }
    } catch {
      this.recordHeartbeatMiss(active)
    }
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (!req.url) return false
    const url = new URL(req.url, 'http://localhost')
    if (!url.pathname.startsWith('/runtime')) return false
    try {
      if (req.method === 'GET' && url.pathname === '/runtime/status') return sendJson(res, 200, await this.getRuntimeStatus())
      if (req.method === 'GET' && url.pathname === '/runtime/sessions') return sendJson(res, 200, { sessions: this.listSessions(Object.fromEntries(url.searchParams) as { status?: string; kind?: 'run' | 'takeover' }) })
      if (req.method === 'GET' && url.pathname.startsWith('/runtime/sessions/')) return sendJson(res, 200, { session: this.getSession(decodeURIComponent(url.pathname.split('/').at(-1) ?? '')) })
      if (req.method === 'GET' && url.pathname === '/runtime/logs') return sendJson(res, 200, { logs: this.getRuntimeLogs(parseEventFilter(url)) })
      if (req.method === 'GET' && url.pathname === '/runtime/events') return sendJson(res, 200, { events: this.getRuntimeEvents(parseEventFilter(url)) })
      if (req.method === 'GET' && url.pathname === '/runtime/events/stream') return this.handleEventStream(req, res, url)
      if (req.method === 'GET' && url.pathname === '/runtime/readiness') return sendJson(res, 200, await this.getRuntimeReadiness())
      if (req.method === 'GET' && url.pathname === '/runtime/log-status') return sendJson(res, 200, this.getLogStatus())
      if (req.method === 'POST' && url.pathname === '/runtime/sessions/fork') return sendJson(res, 200, { session: await this.forkSession(await readJson(req) as ForkSessionInput) })
      if (req.method === 'GET' && url.pathname === '/runtime/roster-draft') return sendJson(res, 200, this.getAgentRosterDraft({
        projectPath: url.searchParams.get('projectPath') ?? undefined,
        runtime: url.searchParams.get('runtime') === 'codex' ? 'codex' : 'claude',
        goal: url.searchParams.get('goal') ?? undefined,
      }))
      if (req.method === 'POST' && url.pathname === '/runtime/validate-roster') return sendJson(res, 200, this.validateAgentRoster(await readJson(req) as AgentRosterDraft))
      if (req.method === 'POST' && url.pathname === '/runtime/takeover-preview') return sendJson(res, 200, this.previewTakeover(await readJson(req) as { projectPath: string; goalOverride?: string; runtime: Runtime }))
      if (req.method === 'POST' && url.pathname === '/runtime/start-run') return sendJson(res, 200, await this.startRun(await readJson(req) as StartRunInput))
      if (req.method === 'POST' && url.pathname === '/runtime/start-takeover') return sendJson(res, 200, await this.startTakeover(await readJson(req) as StartTakeoverInput))
      if (req.method === 'POST' && url.pathname === '/runtime/stop') {
        await this.stopSession(await readJson(req) as { sessionId?: string; reason?: string })
        return sendJson(res, 200, { status: 'stopped' })
      }
      if (req.method === 'POST' && url.pathname === '/runtime/pause') {
        await this.pauseSupervisor(await readJson(req) as { sessionId?: string })
        return sendJson(res, 200, { status: 'paused' })
      }
      if (req.method === 'POST' && url.pathname === '/runtime/resume') {
        await this.resumeSupervisor(await readJson(req) as { sessionId?: string })
        return sendJson(res, 200, { status: 'running' })
      }
      return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown runtime endpoint.' } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.events.append({ level: 'error', source: 'host', eventType: 'host.error', message })
      return sendJson(res, 400, { error: { code: 'BAD_REQUEST', message } })
    }
  }

  async proxyToSupervisor(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = `${this.sessions.active()?.supervisorUrl ?? this.defaultSupervisorUrl}${req.url ?? '/'}`
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(await readJson(req))
    const upstream = await fetch(target, {
      method: req.method,
      headers: { 'content-type': 'application/json' },
      body,
    })
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
    res.end(await upstream.text())
  }

  private handleEventStream(req: IncomingMessage, res: ServerResponse, url: URL): true {
    // Support Last-Event-ID for automatic browser reconnect
    const lastEventIdHeader = req.headers['last-event-id']
    const sinceParam = url.searchParams.has('since') ? Number(url.searchParams.get('since')) : undefined
    let since: number | undefined = sinceParam
    if (since === undefined && typeof lastEventIdHeader === 'string') {
      const ts = Number(lastEventIdHeader)
      if (Number.isFinite(ts)) since = ts
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    })
    // Flush headers immediately
    res.write(':ok\n\n')

    // Replay persisted events since reconnect point
    const past = this.events.query({ since, limit: 500 })
    for (const event of past) {
      res.write(`id: ${event.timestamp}\ndata: ${JSON.stringify(event)}\n\n`)
    }

    // Stream new events as they are appended
    const unlisten = this.events.addListener(event => {
      if (!res.writableEnded) {
        res.write(`id: ${event.timestamp}\ndata: ${JSON.stringify(event)}\n\n`)
      }
    })

    // Heartbeat comment to keep the connection alive through proxies
    const keepalive = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(keepalive)
      } else {
        res.write(': heartbeat\n\n')
      }
    }, SSE_KEEPALIVE_MS)

    req.on('close', () => {
      unlisten()
      clearInterval(keepalive)
    })

    return true
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(() => {
      this.checkHeartbeat().catch(() => undefined)
    }, HEARTBEAT_INTERVAL_MS)
    // Don't keep the process alive for this timer alone
    this.heartbeatTimer.unref?.()
  }

  private recordHeartbeatMiss(session: RunSession): void {
    const misses = (this.heartbeatMisses.get(session.id) ?? 0) + 1
    this.heartbeatMisses.set(session.id, misses)
    if (misses >= HEARTBEAT_STALE_AFTER) {
      this.heartbeatMisses.delete(session.id)
      this.sessions.update(session.id, {
        status: 'stale',
        heartbeatStatus: 'stale',
        heartbeatMisses: misses,
        error: 'Supervisor health check failed repeatedly; process state is unknown.',
      })
      this.events.append({
        sessionId: session.id,
        level: 'warn',
        source: 'host',
        eventType: 'runtime.stale',
        message: `Session marked stale after ${misses} consecutive health check failures`,
      })
    } else {
      this.sessions.update(session.id, {
        heartbeatStatus: 'missed',
        heartbeatMisses: misses,
      })
      this.events.append({
        sessionId: session.id,
        level: 'warn',
        source: 'host',
        eventType: 'runtime.heartbeat_miss',
        message: `Supervisor health check miss ${misses}/${HEARTBEAT_STALE_AFTER}`,
      })
    }
  }

  private async launchSession(session: RunSession, config: AgentMatrixConfig, input: StartRunInput | StartTakeoverInput): Promise<RunSession> {
    const handle = await this.launcher.start(session, config, input, {
      onLogLine: (line, stream) => {
        const sanitized = sanitizeMessage(line)
        if (!sanitized) return
        const level: RuntimeEventLevel = /\berror\b|\bfailed\b|\bexception\b/i.test(sanitized) ? 'error'
          : /\bwarn\b|\bwarning\b/i.test(sanitized) ? 'warn'
          : 'info'
        // Best-effort agent attribution: parse common structured log patterns.
        const agent = inferAgentFromLine(sanitized)
        this.events.append({
          sessionId: session.id,
          level,
          source: agent ? 'agent' : 'supervisor',
          eventType: 'supervisor.log',
          agent,
          message: sanitized,
          data: { stream },
        })
      },
    })
    this.handles.set(session.id, handle)
    const next = this.sessions.update(session.id, {
      status: 'running',
      supervisorUrl: handle.endpoint,
      port: handle.port,
      workspacePath: handle.workspacePath,
      configPath: handle.configPath,
      outputDir: handle.outputDir ?? session.outputDir,
    })!
    this.events.append({ sessionId: session.id, level: 'info', source: 'host', eventType: 'runtime.started', message: 'Wanman session started', data: { endpoint: handle.endpoint } })
    return next
  }

  private assertNoActiveSession(): void {
    const active = this.sessions.active()
    if (active) throw new Error(`A Wanman session is already active (${active.id}).`)
  }

  private findSession(id?: string): RunSession | null {
    return id ? this.sessions.get(id) : this.sessions.active()
  }

  private async fetchHealth(session: RunSession | null): Promise<Record<string, unknown> | null> {
    const target = session?.supervisorUrl ?? this.defaultSupervisorUrl
    const res = await fetch(`${target}/health`, { signal: AbortSignal.timeout(1000) })
    if (!res.ok) return null
    return await res.json() as Record<string, unknown>
  }

  private async rpc(session: RunSession, method: string): Promise<void> {
    const endpoint = session.supervisorUrl
    if (!endpoint) return
    await fetch(`${endpoint}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params: {} }),
      signal: AbortSignal.timeout(1000),
    })
  }
}

export function createLocalControlHost(options: LocalControlHostOptions): LocalControlHost {
  return new LocalControlHost(options)
}

export function createLocalControlHostServer(options: LocalControlHostOptions & { port?: number; host?: string }) {
  const controlHost = createLocalControlHost(options)
  const server = http.createServer(async (req, res) => {
    if (await controlHost.handleRequest(req, res)) return
    if (req.url === '/health' || req.url === '/rpc') {
      try {
        await controlHost.proxyToSupervisor(req, res)
      } catch {
        sendJson(res, 502, { error: { code: 'SUPERVISOR_UNREACHABLE', message: 'Supervisor is not reachable.' } })
      }
      return
    }
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown endpoint.' } })
  })
  server.on('close', () => controlHost.close())
  return {
    controlHost,
    server,
    listen: () => new Promise<void>(resolve => {
      server.listen(options.port ?? 5174, options.host ?? '127.0.0.1', () => resolve())
    }),
  }
}

function parseEventFilter(url: URL): RuntimeEventFilter {
  return {
    sessionId: url.searchParams.get('sessionId') ?? undefined,
    agent: url.searchParams.get('agent') ?? undefined,
    level: parseLevel(url.searchParams.get('level')),
    eventType: url.searchParams.get('eventType') ?? undefined,
    since: url.searchParams.has('since') ? Number(url.searchParams.get('since')) : undefined,
    limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
  }
}

function parseLevel(value: string | null): RuntimeEventFilter['level'] {
  return value === 'info' || value === 'warn' || value === 'error' ? value : undefined
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'))
}

function sendJson(res: ServerResponse, status: number, value: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
  return true
}

/**
 * Best-effort extraction of an agent name from a supervisor log line.
 * Handles common patterns emitted by the runtime:
 *   [agent:db9]  ...
 *   [agent db9]  ...
 *   {"agent":"db9", ...}
 *   [db9] ...  (short bracket prefix matching known naming conventions)
 * Returns undefined when attribution cannot be determined.
 */
function inferAgentFromLine(line: string): string | undefined {
  // Structured: [agent:name] or [agent name]
  const bracketAgent = /\[agent[: ]([a-z0-9_-]+)\]/i.exec(line)
  if (bracketAgent) return bracketAgent[1]!.toLowerCase()

  // JSON log: {"agent":"name"}
  const jsonAgent = /"agent"\s*:\s*"([a-z0-9_-]+)"/i.exec(line)
  if (jsonAgent) return jsonAgent[1]!.toLowerCase()

  // Prefixed bracket: [name] where name looks like an agent identifier
  const prefixBracket = /^\[([a-z][a-z0-9_-]{1,30})\]/i.exec(line.trimStart())
  if (prefixBracket) {
    const candidate = prefixBracket[1]!.toLowerCase()
    // Exclude common non-agent bracket labels
    const excluded = new Set(['info', 'warn', 'error', 'debug', 'stdout', 'stderr', 'host', 'supervisor'])
    if (!excluded.has(candidate)) return candidate
  }

  return undefined
}
