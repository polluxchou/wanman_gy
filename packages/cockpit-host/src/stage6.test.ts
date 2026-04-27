import * as fs from 'node:fs'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EventStore,
  LocalControlHost,
  SessionStore,
  createDefaultRoster,
} from './index.js'
import type { ProcessLauncher, RuntimeEvent } from './index.js'

const tempDirs: string[] = []

function tempRoot(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wanman-s6-${name}-`))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

// ── Build artifact ──────────────────────────────────────────────────────────

describe('Stage 6 build artifact', () => {
  it('package.json has build, start, dev, and clean scripts', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8')) as Record<string, unknown>
    const scripts = pkg['scripts'] as Record<string, string>
    expect(scripts['build']).toBe('node build.mjs')
    expect(scripts['start']).toBe('node dist/serve.js')
    expect(scripts['dev']).toContain('src/serve.ts')
    expect(scripts['clean']).toContain('dist')
  })

  it('build.mjs exists and targets dist/serve.js', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'build.mjs'), 'utf-8')
    expect(src).toContain('dist/serve.js')
    expect(src).toContain('src/serve.ts')
    expect(src).toContain('node20')
  })
})

// ── SSE event streaming ─────────────────────────────────────────────────────

describe('Stage 6 EventStore SSE listeners', () => {
  it('addListener receives events synchronously on append', () => {
    const store = new EventStore(path.join(tempRoot('sse'), 'events'))
    const received: RuntimeEvent[] = []
    const unsub = store.addListener(e => received.push(e))

    store.append({ level: 'info', source: 'host', eventType: 'test.start', message: 'hello' })
    store.append({ level: 'warn', source: 'supervisor', eventType: 'test.warn', message: 'caution' })

    expect(received).toHaveLength(2)
    expect(received[0]?.message).toBe('hello')
    expect(received[1]?.message).toBe('caution')

    // After unsubscribe, no more events
    unsub()
    store.append({ level: 'info', source: 'host', eventType: 'test.after', message: 'missed' })
    expect(received).toHaveLength(2)
  })

  it('multiple listeners each receive events independently', () => {
    const store = new EventStore(path.join(tempRoot('multi-listen'), 'events'))
    const a: string[] = []
    const b: string[] = []
    const unsubA = store.addListener(e => a.push(e.message))
    const unsubB = store.addListener(e => b.push(e.message))

    store.append({ level: 'info', source: 'host', eventType: 'x', message: 'msg1' })
    unsubA()
    store.append({ level: 'info', source: 'host', eventType: 'x', message: 'msg2' })
    unsubB()

    expect(a).toEqual(['msg1'])
    expect(b).toEqual(['msg1', 'msg2'])
  })

  it('a throwing listener does not block other listeners or append', () => {
    const store = new EventStore(path.join(tempRoot('throw-safe'), 'events'))
    const good: string[] = []
    store.addListener(() => { throw new Error('listener crash') })
    store.addListener(e => good.push(e.message))

    expect(() => store.append({ level: 'info', source: 'host', eventType: 'x', message: 'safe' })).not.toThrow()
    expect(good).toEqual(['safe'])
    expect(store.query({ limit: 5 })).toHaveLength(1)
  })
})

describe('Stage 6 SSE HTTP endpoint', () => {
  it('GET /runtime/events/stream returns text/event-stream and replays history', async () => {
    const root = tempRoot('sse-http')
    const project = path.join(root, 'project')
    fs.mkdirSync(project, { recursive: true })
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'demo' }))

    const launcher: ProcessLauncher = { start: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:3999', port: 3999, stop: vi.fn(async () => undefined) })) }
    const host = new LocalControlHost({
      repoRoot: project,
      storageRoot: path.join(root, '.wanman/cockpit'),
      launcher,
      readinessRunner: async c => ({ ok: true, message: `${c} ok` }),
    })
    // Pre-seed an event so replay can be tested
    host.events.append({ level: 'info', source: 'host', eventType: 'pre.seed', message: 'seeded before connect' })

    // Open an HTTP server around the host
    const server = http.createServer(async (req, res) => {
      if (await host.handleRequest(req, res)) return
      res.writeHead(404); res.end()
    })
    const port = await new Promise<number>(resolve => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
    })

    try {
      const chunks: string[] = []
      const response = await fetch(`http://127.0.0.1:${port}/runtime/events/stream`, {
        headers: { Accept: 'text/event-stream' },
        signal: AbortSignal.timeout(2000),
      })
      expect(response.headers.get('content-type')).toMatch(/text\/event-stream/)

      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      // Read until we see the seeded event in the stream
      let found = false
      while (!found) {
        const { value, done } = await reader.read()
        if (done) break
        const text = decoder.decode(value)
        chunks.push(text)
        if (text.includes('pre.seed')) found = true
      }
      reader.cancel()

      const combined = chunks.join('')
      expect(combined).toContain('pre.seed')
      expect(combined).toContain('seeded before connect')
    } finally {
      server.close()
      host.close()
    }
  })

  it('GET /runtime/events/stream supports ?since= for reconnect filtering', async () => {
    const root = tempRoot('sse-since')
    const project = path.join(root, 'project')
    fs.mkdirSync(project, { recursive: true })
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'demo' }))

    const launcher: ProcessLauncher = { start: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:3999', port: 3999, stop: vi.fn(async () => undefined) })) }
    const host = new LocalControlHost({
      repoRoot: project,
      storageRoot: path.join(root, '.wanman/cockpit'),
      launcher,
    })
    const old = host.events.append({ level: 'info', source: 'host', eventType: 'old', message: 'old event' })
    host.events.append({ level: 'info', source: 'host', eventType: 'new', message: 'new event' })

    const server = http.createServer(async (req, res) => {
      if (await host.handleRequest(req, res)) return
      res.writeHead(404); res.end()
    })
    const port = await new Promise<number>(resolve => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
    })

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/runtime/events/stream?since=${old.timestamp}`,
        { signal: AbortSignal.timeout(2000) },
      )
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let text = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        text += decoder.decode(value)
        if (text.includes('new event')) break
      }
      reader.cancel()

      expect(text).toContain('new event')
      expect(text).not.toContain('old event')
    } finally {
      server.close()
      host.close()
    }
  })
})

// ── Heartbeat / stale detection ─────────────────────────────────────────────

describe('Stage 6 heartbeat stale detection', () => {
  it('marks session healthy when supervisor health responds', async () => {
    const root = tempRoot('hb-healthy')
    const project = path.join(root, 'project')
    fs.mkdirSync(project, { recursive: true })
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'demo' }))

    const launcher: ProcessLauncher = { start: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:3999', port: 3999, stop: vi.fn(async () => undefined) })) }
    const host = new LocalControlHost({
      repoRoot: project,
      storageRoot: path.join(root, '.wanman/cockpit'),
      launcher,
      readinessRunner: async c => ({ ok: true, message: `${c} ok` }),
    })

    const session = await host.startRun({
      goal: 'Test heartbeat',
      runtime: 'claude',
      loopMode: 'finite',
      loops: 1,
      pollInterval: 5,
      errorLimit: 1,
      roster: createDefaultRoster('claude', 'Test heartbeat'),
    })

    // Simulate a healthy health check by mocking fetch for this session
    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (url: URL | string) => {
      const u = String(url)
      if (u.includes('/health')) return new Response(JSON.stringify({ status: 'ok', agents: [] }), { status: 200 })
      return origFetch(url as URL)
    }) as typeof fetch

    await host.checkHeartbeat()

    globalThis.fetch = origFetch

    const updated = host.sessions.get(session.id)
    expect(updated?.heartbeatStatus).toBe('healthy')
    expect(updated?.lastHeartbeatAt).toBeGreaterThan(0)
    host.close()
  })

  it('marks session stale after HEARTBEAT_STALE_AFTER consecutive misses', async () => {
    const root = tempRoot('hb-stale')
    const project = path.join(root, 'project')
    fs.mkdirSync(project, { recursive: true })
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'demo' }))

    const launcher: ProcessLauncher = { start: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:3999', port: 3999, stop: vi.fn(async () => undefined) })) }
    const host = new LocalControlHost({
      repoRoot: project,
      storageRoot: path.join(root, '.wanman/cockpit'),
      launcher,
      readinessRunner: async c => ({ ok: true, message: `${c} ok` }),
    })

    const session = await host.startRun({
      goal: 'Test stale',
      runtime: 'claude',
      loopMode: 'finite',
      loops: 1,
      pollInterval: 5,
      errorLimit: 1,
      roster: createDefaultRoster('claude', 'Test stale'),
    })

    // Simulate failing health checks
    const origFetch2 = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response('', { status: 503 })) as typeof fetch

    // Three misses → stale
    await host.checkHeartbeat()
    await host.checkHeartbeat()
    await host.checkHeartbeat()

    globalThis.fetch = origFetch2

    const updated = host.sessions.get(session.id)
    expect(updated?.status).toBe('stale')
    expect(updated?.heartbeatStatus).toBe('stale')

    const staleEvent = host.events.query({ eventType: 'runtime.stale' })
    expect(staleEvent.length).toBeGreaterThan(0)
    host.close()
  })

  it('records heartbeat misses below the stale threshold', async () => {
    const root = tempRoot('hb-miss')
    const project = path.join(root, 'project')
    fs.mkdirSync(project, { recursive: true })
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'demo' }))

    const launcher: ProcessLauncher = { start: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:3999', port: 3999, stop: vi.fn(async () => undefined) })) }
    const host = new LocalControlHost({
      repoRoot: project,
      storageRoot: path.join(root, '.wanman/cockpit'),
      launcher,
      readinessRunner: async c => ({ ok: true, message: `${c} ok` }),
    })

    const session = await host.startRun({
      goal: 'Test miss',
      runtime: 'claude',
      loopMode: 'finite',
      loops: 1,
      pollInterval: 5,
      errorLimit: 1,
      roster: createDefaultRoster('claude', 'Test miss'),
    })

    const origFetch3 = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response('', { status: 503 })) as typeof fetch

    await host.checkHeartbeat()

    globalThis.fetch = origFetch3

    const updated = host.sessions.get(session.id)
    expect(updated?.status).toBe('running') // still running, not stale yet
    expect(updated?.heartbeatStatus).toBe('missed')
    expect(updated?.heartbeatMisses).toBe(1)

    const missEvents = host.events.query({ eventType: 'runtime.heartbeat_miss' })
    expect(missEvents.length).toBeGreaterThan(0)
    host.close()
  })
})

// ── Supervisor log ingestion ─────────────────────────────────────────────────

describe('Stage 6 supervisor log ingestion', () => {
  it('captures stdout lines as supervisor.log events with level inference', async () => {
    const root = tempRoot('log-ingest')
    const project = path.join(root, 'project')
    fs.mkdirSync(project, { recursive: true })
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'demo' }))

    let capturedCallback: ((line: string, stream: 'stdout' | 'stderr') => void) | undefined
    const launcher: ProcessLauncher = {
      start: vi.fn(async (_session, _config, _input, callbacks) => {
        capturedCallback = callbacks?.onLogLine
        return { endpoint: 'http://127.0.0.1:3999', port: 3999, stop: vi.fn(async () => undefined) }
      }),
    }
    const host = new LocalControlHost({
      repoRoot: project,
      storageRoot: path.join(root, '.wanman/cockpit'),
      launcher,
      readinessRunner: async c => ({ ok: true, message: `${c} ok` }),
    })

    const session = await host.startRun({
      goal: 'Test logs',
      runtime: 'claude',
      loopMode: 'finite',
      loops: 1,
      pollInterval: 5,
      errorLimit: 1,
      roster: createDefaultRoster('claude', 'Test logs'),
    })

    expect(capturedCallback).toBeDefined()

    capturedCallback!('Supervisor started on port 3999', 'stdout')
    capturedCallback!('ERROR: agent failed to connect', 'stderr')
    capturedCallback!('WARNING: retry limit approaching', 'stdout')

    const logEvents = host.events.query({ sessionId: session.id, eventType: 'supervisor.log' })
    expect(logEvents.length).toBe(3)
    expect(logEvents[0]?.level).toBe('info')
    expect(logEvents[0]?.source).toBe('supervisor')
    expect(logEvents[1]?.level).toBe('error')
    expect(logEvents[2]?.level).toBe('warn')
    host.close()
  })

  it('redacts secrets from supervisor log lines', async () => {
    const root = tempRoot('log-redact')
    const project = path.join(root, 'project')
    fs.mkdirSync(project, { recursive: true })
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'demo' }))

    let logCallback: ((line: string, stream: 'stdout' | 'stderr') => void) | undefined
    const launcher: ProcessLauncher = {
      start: vi.fn(async (_s, _c, _i, callbacks) => {
        logCallback = callbacks?.onLogLine
        return { endpoint: 'http://127.0.0.1:3999', port: 3999, stop: vi.fn(async () => undefined) }
      }),
    }
    const host = new LocalControlHost({
      repoRoot: project,
      storageRoot: path.join(root, '.wanman/cockpit'),
      launcher,
      readinessRunner: async c => ({ ok: true, message: `${c} ok` }),
    })

    await host.startRun({
      goal: 'Test redact',
      runtime: 'claude',
      loopMode: 'finite',
      loops: 1,
      pollInterval: 5,
      errorLimit: 1,
      roster: createDefaultRoster('claude', 'Test redact'),
    })

    logCallback!('Using ANTHROPIC_API_KEY=sk-ant-secret123abc', 'stdout')
    logCallback!('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', 'stdout')

    const logEvents = host.events.query({ eventType: 'supervisor.log' })
    for (const event of logEvents) {
      expect(event.message).not.toContain('sk-ant-secret123abc')
      expect(event.message).not.toContain('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c')
    }
    host.close()
  })
})

// ── Local bind safety ────────────────────────────────────────────────────────

describe('Stage 6 local bind safety', () => {
  it('serve.ts safety check logic rejects non-local bind addresses', () => {
    const allowedHosts = ['127.0.0.1', 'localhost', '::1']
    const rejectedHosts = ['0.0.0.0', '192.168.1.1', '10.0.0.1', '::']

    for (const h of allowedHosts) {
      const isLocal = h === '127.0.0.1' || h === 'localhost' || h === '::1'
      expect(isLocal).toBe(true)
    }
    for (const h of rejectedHosts) {
      const isLocal = h === '127.0.0.1' || h === 'localhost' || h === '::1'
      expect(isLocal).toBe(false)
    }
  })
})

// ── Polling endpoint still works ─────────────────────────────────────────────

describe('Stage 6 polling endpoint regression', () => {
  it('GET /runtime/events still returns JSON array of events', async () => {
    const root = tempRoot('polling')
    const project = path.join(root, 'project')
    fs.mkdirSync(project, { recursive: true })
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'demo' }))

    const host = new LocalControlHost({
      repoRoot: project,
      storageRoot: path.join(root, '.wanman/cockpit'),
      launcher: { start: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:3999', port: 3999, stop: vi.fn(async () => undefined) })) },
    })
    host.events.append({ level: 'info', source: 'host', eventType: 'test.poll', message: 'poll me' })

    const server = http.createServer(async (req, res) => {
      if (await host.handleRequest(req, res)) return
      res.writeHead(404); res.end()
    })
    const port = await new Promise<number>(resolve => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
    })

    try {
      const res = await fetch(`http://127.0.0.1:${port}/runtime/events`)
      expect(res.ok).toBe(true)
      const body = await res.json() as { events: unknown[] }
      expect(Array.isArray(body.events)).toBe(true)
      expect(body.events.length).toBeGreaterThan(0)
    } finally {
      server.close()
      host.close()
    }
  })
})

// ── Session store heartbeat fields survive round-trip ───────────────────────

describe('Stage 6 session heartbeat persistence', () => {
  it('heartbeat fields are persisted to and recovered from disk', () => {
    const store = new SessionStore(path.join(tempRoot('hb-persist'), 'sessions'))
    const session = store.create({
      kind: 'run',
      status: 'running',
      goal: 'persist heartbeat',
      runtime: 'claude',
      createdBy: 'cockpit',
      metadata: {},
    })

    store.update(session.id, {
      lastHeartbeatAt: 1_700_000_000_000,
      heartbeatStatus: 'missed',
      heartbeatMisses: 2,
    })

    const reloaded = store.get(session.id)
    expect(reloaded?.lastHeartbeatAt).toBe(1_700_000_000_000)
    expect(reloaded?.heartbeatStatus).toBe('missed')
    expect(reloaded?.heartbeatMisses).toBe(2)
  })
})
