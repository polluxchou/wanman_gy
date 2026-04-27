import * as fs from 'node:fs'
import * as path from 'node:path'
import type { RunSession, SessionKind, SessionStatus } from './types.js'

const ACTIVE_STATUSES = new Set<SessionStatus>(['starting', 'running', 'paused', 'stopping'])

function readJson(file: string): RunSession | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as RunSession
  } catch {
    return null
  }
}

export class SessionStore {
  readonly rootDir: string

  constructor(rootDir: string) {
    this.rootDir = rootDir
    fs.mkdirSync(this.rootDir, { recursive: true })
    this.markRecoveredSessionsStale()
  }

  create(input: Omit<RunSession, 'id' | 'startedAt' | 'endedAt'> & { id?: string; startedAt?: number; endedAt?: number | null }): RunSession {
    const session: RunSession = {
      id: input.id ?? `cockpit-${input.kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      startedAt: input.startedAt ?? Date.now(),
      endedAt: input.endedAt ?? null,
      ...input,
      metadata: input.metadata ?? {},
      createdBy: 'cockpit',
    }
    this.save(session)
    return session
  }

  save(session: RunSession): void {
    fs.mkdirSync(this.rootDir, { recursive: true })
    fs.writeFileSync(this.fileFor(session.id), JSON.stringify(session, null, 2))
  }

  update(id: string, patch: Partial<RunSession>): RunSession | null {
    const current = this.get(id)
    if (!current) return null
    const next = { ...current, ...patch }
    this.save(next)
    return next
  }

  get(id: string): RunSession | null {
    const safeId = id.replace(/[^A-Za-z0-9_.-]/g, '')
    if (!safeId) return null
    return readJson(this.fileFor(safeId))
  }

  list(filter?: { status?: string; kind?: SessionKind }): RunSession[] {
    if (!fs.existsSync(this.rootDir)) return []
    return fs.readdirSync(this.rootDir)
      .filter(name => name.endsWith('.json'))
      .map(name => readJson(path.join(this.rootDir, name)))
      .filter((session): session is RunSession => Boolean(session))
      .filter(session => !filter?.kind || session.kind === filter.kind)
      .filter(session => !filter?.status || session.status === filter.status)
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  active(): RunSession | null {
    return this.list().find(session => ACTIVE_STATUSES.has(session.status)) ?? null
  }

  private fileFor(id: string): string {
    return path.join(this.rootDir, `${id}.json`)
  }

  private markRecoveredSessionsStale(): void {
    if (!fs.existsSync(this.rootDir)) return
    for (const session of this.list()) {
      if (ACTIVE_STATUSES.has(session.status)) {
        this.save({
          ...session,
          status: 'stale',
          error: session.error ?? 'Host restarted while this session was active; process state is unknown.',
        })
      }
    }
  }
}
