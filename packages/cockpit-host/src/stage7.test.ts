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
import type { ProcessLauncher, RunSession } from './index.js'

const tempDirs: string[] = []

function tempRoot(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wanman-s7-${name}-`))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

// ── Stage 7 build artifact ──────────────────────────────────────────────────

describe('Stage 7 build artifact', () => {
  it('package.json has build, start, dev, and clean scripts', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8')) as Record<string, unknown>
    const scripts = pkg['scripts'] as Record<string, string>
    expect(scripts['build']).toBe('node build.mjs')
    expect(scripts['start']).toBe('node dist/serve.js')
    expect(scripts['dev']).toContain('src/serve.ts')
    expect(scripts['clean']).toContain('dist')
  })
})

// ── Log rotation ─────────────────────────────────────────────────────────────

describe('Stage 7 EventStore log rotation', () => {
  it('EventStore exposes getStorageInfo with current file size and archive count', () => {
    const root = path.join(tempRoot('rot'), 'events')
    const store = new EventStore(root)
    store.append({ level: 'info', source: 'host', eventType: 'test', message: 'hello' })
    const info = store.getStorageInfo()
    expect(info.currentSizeBytes).toBeGreaterThan(0)
    expect(info.archiveCount).toBe(0)
    expect(info.maxSizeBytes).toBe(10 * 1024 * 1024)
    expect(info.maxFiles).toBe(5)
    expect(info.totalSizeBytes).toBe(info.currentSizeBytes)
  })

  it('accepts custom maxSizeBytes and maxFiles', () => {
    const root = path.join(tempRoot('opts'), 'events')
    const store = new EventStore(root, { maxSizeBytes: 512, maxFiles: 2 })
    const info = store.getStorageInfo()
    expect(info.maxSizeBytes).toBe(512)
    expect(info.maxFiles).toBe(2)
  })

  it('rotateNow creates an archive file and resets the current log', () => {
    const root = path.join(tempRoot('rn'), 'events')
    const store = new EventStore(root)
    store.append({ level: 'info', source: 'host', eventType: 'pre', message: 'before rotation' })
    const sizeBefore = store.getStorageInfo().currentSizeBytes
    expect(sizeBefore).toBeGreaterThan(0)

    store.rotateNow()

    const info = store.getStorageInfo()
    expect(info.currentSizeBytes).toBe(0)
    expect(info.archiveCount).toBe(1)
    expect(info.archiveFiles).toContain('events.1.ndjson')
    expect(info.totalSizeBytes).toBeGreaterThan(0)
  })

  it('rotation at maxSizeBytes fires automatically on append', () => {
    const root = path.join(tempRoot('auto'), 'events')
    const store = new EventStore(root, { maxSizeBytes: 10, maxFiles: 5 })
    // Each event is larger than 10 bytes, so rotation fires every append
    store.append({ level: 'info', source: 'host', eventType: 'e', message: 'a'.repeat(20) })
    const info = store.getStorageInfo()
    expect(info.archiveCount).toBeGreaterThanOrEqual(1)
  })

  it('prunes archives beyond maxFiles', () => {
    const root = path.join(tempRoot('prune'), 'events')
    const store = new EventStore(root, { maxSizeBytes: 10, maxFiles: 2 })
    // Trigger enough rotations to exceed maxFiles
    for (let i = 0; i < 5; i++) {
      store.append({ level: 'info', source: 'host', eventType: 'e', message: 'x'.repeat(20) })
    }
    const info = store.getStorageInfo()
    expect(info.archiveCount).toBeLessThanOrEqual(2)
  })

  it('getArchiveFiles returns files newest-first', () => {
    const root = path.join(tempRoot('order'), 'events')
    const store = new EventStore(root, { maxSizeBytes: 10, maxFiles: 3 })
    for (let i = 0; i < 3; i++) {
      store.append({ level: 'info', source: 'host', eventType: 'e', message: 'x'.repeat(20) })
    }
    const archives = store.getArchiveFiles()
    expect(archives.length).toBeGreaterThanOrEqual(1)
    // First archive should be events.1.ndjson
    expect(path.basename(archives[0]!)).toBe('events.1.ndjson')
  })
})

// ── Multi-file query ─────────────────────────────────────────────────────────

describe('Stage 7 EventStore multi-file query', () => {
  it('query returns events from archives when current file is empty after rotation', () => {
    const root = path.join(tempRoot('mq'), 'events')
    const store = new EventStore(root, { maxSizeBytes: 10, maxFiles: 3 })
    store.append({ level: 'info', source: 'host', eventType: 'archive-event', message: 'x'.repeat(20) })
    // After append the file is rotated; current file is empty
    const info = store.getStorageInfo()
    expect(info.currentSizeBytes).toBe(0)

    const events = store.query({ limit: 10 })
    expect(events.some(e => e.eventType === 'archive-event')).toBe(true)
  })

  it('query with since reads archives when current file starts after since', () => {
    const root = path.join(tempRoot('since'), 'events')
    const store = new EventStore(root, { maxSizeBytes: 10, maxFiles: 3 })
    const archived = store.append({ level: 'info', source: 'host', eventType: 'old', message: 'x'.repeat(20) })
    // archived event now in events.1.ndjson
    const since = archived.timestamp - 1

    const events = store.query({ since, limit: 100 })
    expect(events.some(e => e.id === archived.id)).toBe(true)
  })

  it('last() returns the most recent event across all files', () => {
    const root = path.join(tempRoot('last'), 'events')
    const store = new EventStore(root, { maxSizeBytes: 10, maxFiles: 3 })
    store.append({ level: 'info', source: 'host', eventType: 'old', message: 'x'.repeat(20) })
    const newest = store.append({ level: 'info', source: 'host', eventType: 'new', message: 'newest' })

    // newest is in the current file after another rotation
    const last = store.last()
    expect(last?.id).toBe(newest.id)
  })
})

// ── Log-status endpoint ──────────────────────────────────────────────────────

describe('Stage 7 /runtime/log-status endpoint', () => {
  function makeHost(root: string) {
    return new LocalControlHost({ repoRoot: root })
  }

  it('getLogStatus returns storage info', () => {
    const root = tempRoot('ls')
    const host = makeHost(root)
    host.events.append({ level: 'info', source: 'host', eventType: 'test', message: 'hi' })
    const info = host.getLogStatus()
    expect(info.currentSizeBytes).toBeGreaterThan(0)
    expect(typeof info.maxSizeBytes).toBe('number')
    host.close()
  })

  it('GET /runtime/log-status responds with storage info', async () => {
    const root = tempRoot('ls-http')
    const host = new LocalControlHost({ repoRoot: root })
    host.events.append({ level: 'info', source: 'host', eventType: 'test', message: 'hi' })

    const req = { method: 'GET', url: '/runtime/log-status', headers: {} } as unknown as http.IncomingMessage
    const chunks: Buffer[] = []
    let statusCode = 0
    const res = {
      writeHead: (s: number) => { statusCode = s },
      end: (chunk: string) => { chunks.push(Buffer.from(chunk)) },
    } as unknown as http.ServerResponse

    await host.handleRequest(req, res)
    expect(statusCode).toBe(200)
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
    expect(typeof body['currentSizeBytes']).toBe('number')
    expect(typeof body['maxSizeBytes']).toBe('number')
    host.close()
  })
})

// ── Session fork (stale recovery) ────────────────────────────────────────────

describe('Stage 7 session fork', () => {
  function stubLauncher(port = 19999): ProcessLauncher {
    return {
      async start(_session, _config, _input) {
        return {
          endpoint: `http://127.0.0.1:${port}`,
          port,
          workspacePath: '/tmp/ws',
          configPath: '/tmp/cfg',
          outputDir: '/tmp/out',
          async stop() {},
        }
      },
    }
  }

  it('forkSession creates a new session with recoveredFrom metadata', async () => {
    const root = tempRoot('fork')
    const host = new LocalControlHost({
      repoRoot: root,
      launcher: stubLauncher(),
      readinessRunner: async () => ({ ok: true, message: 'ok' }),
    })

    // Create a stale session manually
    const stale = host.sessions.create({
      kind: 'run',
      status: 'stale',
      goal: 'original goal',
      runtime: 'claude',
      projectPath: root,
      createdBy: 'cockpit',
      metadata: {},
    })

    const forked = await host.forkSession({ sessionId: stale.id })
    expect(forked.status).toBe('starting')
    expect(forked.goal).toBe('original goal')
    expect(forked.runtime).toBe('claude')
    expect(forked.metadata['recoveredFrom']).toBe(stale.id)
    expect(forked.id).not.toBe(stale.id)
    host.close()
  })

  it('forkSession respects goalOverride', async () => {
    const root = tempRoot('fork-goal')
    const host = new LocalControlHost({
      repoRoot: root,
      launcher: stubLauncher(),
      readinessRunner: async () => ({ ok: true, message: 'ok' }),
    })
    const stale = host.sessions.create({
      kind: 'run', status: 'stale', goal: 'old goal', runtime: 'claude',
      createdBy: 'cockpit', metadata: {},
    })
    const forked = await host.forkSession({ sessionId: stale.id, goalOverride: 'new goal' })
    expect(forked.goal).toBe('new goal')
    host.close()
  })

  it('forkSession throws when source session not found', async () => {
    const root = tempRoot('fork-missing')
    const host = new LocalControlHost({ repoRoot: root })
    await expect(host.forkSession({ sessionId: 'does-not-exist' })).rejects.toThrow()
    host.close()
  })

  it('forkSession throws when another session is already active', async () => {
    const root = tempRoot('fork-conflict')
    const host = new LocalControlHost({ repoRoot: root })
    host.sessions.create({
      kind: 'run', status: 'running', goal: 'running goal', runtime: 'claude',
      createdBy: 'cockpit', metadata: {},
    })
    const stale = host.sessions.create({
      kind: 'run', status: 'stale', goal: 'stale goal', runtime: 'claude',
      createdBy: 'cockpit', metadata: {},
    })
    await expect(host.forkSession({ sessionId: stale.id })).rejects.toThrow(/active/)
    host.close()
  })

  it('POST /runtime/sessions/fork responds with new session', async () => {
    const root = tempRoot('fork-http')
    const host = new LocalControlHost({ repoRoot: root })
    const stale = host.sessions.create({
      kind: 'run', status: 'stale', goal: 'g', runtime: 'claude',
      createdBy: 'cockpit', metadata: {},
    })

    const server = http.createServer(async (req, res) => {
      if (await host.handleRequest(req, res)) return
      res.writeHead(404); res.end()
    })
    const port = await new Promise<number>(resolve => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
    })
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/runtime/sessions/fork`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: stale.id }),
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { session: RunSession }
      expect(body.session.metadata['recoveredFrom']).toBe(stale.id)
    } finally {
      server.close()
      host.close()
    }
  })

  it('forkSession emits session.forked event', async () => {
    const root = tempRoot('fork-event')
    const host = new LocalControlHost({ repoRoot: root })
    const stale = host.sessions.create({
      kind: 'run', status: 'stale', goal: 'g', runtime: 'claude',
      createdBy: 'cockpit', metadata: {},
    })
    const forked = await host.forkSession({ sessionId: stale.id })
    const events = host.events.query({ eventType: 'session.forked' })
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0]?.sessionId).toBe(forked.id)
    expect(events[0]?.data?.['sourceSessionId']).toBe(stale.id)
    host.close()
  })
})

// ── Agent attribution ────────────────────────────────────────────────────────

describe('Stage 7 agent log attribution', () => {
  function makeHost(root: string) {
    return new LocalControlHost({ repoRoot: root })
  }

  it('events from named agents are attributed when agent field is set', () => {
    const root = tempRoot('attr')
    const host = makeHost(root)
    host.events.append({ level: 'info', source: 'agent', eventType: 'supervisor.log', agent: 'db9', message: 'doing work' })
    const events = host.events.query({ agent: 'db9' })
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0]?.agent).toBe('db9')
    host.close()
  })

  it('events without agent fall back to supervisor source', () => {
    const root = tempRoot('attr-fallback')
    const host = makeHost(root)
    host.events.append({ level: 'info', source: 'supervisor', eventType: 'supervisor.log', message: 'generic log' })
    const all = host.events.query({})
    const last = all.at(-1)
    expect(last?.agent).toBeUndefined()
    expect(last?.source).toBe('supervisor')
    host.close()
  })
})

// ── SSE stream cursor ────────────────────────────────────────────────────────

describe('Stage 7 SSE reconnect with since cursor', () => {
  async function pickPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const s = net.createServer()
      s.unref()
      s.on('error', reject)
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address()
        s.close(err => {
          if (err || !addr || typeof addr === 'string') reject(err ?? new Error('no addr'))
          else resolve(addr.port)
        })
      })
    })
  }

  it('SSE stream only sends events after the since cursor', async () => {
    const root = tempRoot('sse-cursor')
    const host = new LocalControlHost({ repoRoot: root })

    // Append two events with known timestamps
    const e1 = host.events.append({ level: 'info', source: 'host', eventType: 'early', message: 'event 1' })
    const e2 = host.events.append({ level: 'info', source: 'host', eventType: 'late', message: 'event 2' })

    const port = await pickPort()
    const { server, listen } = {
      server: http.createServer(async (req, res) => { await host.handleRequest(req, res) }),
      listen: () => new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve)),
    }
    await listen()

    // Connect with since = e1.timestamp → should only receive e2
    const received: string[] = []
    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: `/runtime/events/stream?since=${e1.timestamp}`,
        headers: { accept: 'text/event-stream' },
      }, res => {
        res.on('data', (chunk: Buffer) => {
          const text = chunk.toString()
          for (const line of text.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                const evt = JSON.parse(line.slice(6)) as { eventType: string }
                received.push(evt.eventType)
              } catch { /* ignore */ }
            }
          }
          // Received at least one event → we can close
          if (received.length > 0) {
            req.destroy()
            resolve()
          }
        })
        res.on('error', reject)
        res.on('close', resolve)
      })
      req.on('error', (e) => { if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e) })
      req.end()
      setTimeout(() => { req.destroy(); resolve() }, 1000)
    })

    server.close()
    host.close()

    // e1 (eventType 'early') must NOT be in received since we filtered by since=e1.timestamp
    expect(received).not.toContain('early')
    // e2 (eventType 'late') must be in received
    expect(received).toContain('late')
    // Suppress unused variable warning
    void e2
  })
})
