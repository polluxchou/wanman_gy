import * as fs from 'node:fs'
import * as path from 'node:path'
import type { RuntimeEvent, RuntimeEventFilter } from './types.js'
import { sanitizeData, sanitizeMessage } from './safety.js'

// Default rotation threshold: 10 MB per file.
const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024
// Default retention: keep 5 archive files plus the current log.
const DEFAULT_MAX_FILES = 5

export interface LogStorageInfo {
  currentSizeBytes: number
  archiveCount: number
  totalSizeBytes: number
  maxSizeBytes: number
  maxFiles: number
  archiveFiles: string[]
}

export interface EventStoreOptions {
  /** Rotate the active log file once it exceeds this byte size (default 10 MB). */
  maxSizeBytes?: number
  /** Maximum number of rotated archive files to keep (default 5). */
  maxFiles?: number
}

export class EventStore {
  readonly rootDir: string
  private readonly eventFile: string
  private readonly maxSizeBytes: number
  private readonly maxFiles: number
  private lastTimestamp = 0
  private readonly listeners = new Set<(event: RuntimeEvent) => void>()

  constructor(rootDir: string, options?: EventStoreOptions) {
    this.rootDir = rootDir
    this.eventFile = path.join(rootDir, 'events.ndjson')
    this.maxSizeBytes = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES
    this.maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES
    fs.mkdirSync(this.rootDir, { recursive: true })
    if (!fs.existsSync(this.eventFile)) fs.writeFileSync(this.eventFile, '')
  }

  addListener(cb: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  append(input: Omit<RuntimeEvent, 'id' | 'timestamp'> & { id?: string; timestamp?: number }): RuntimeEvent {
    const requestedTimestamp = input.timestamp ?? Date.now()
    const timestamp = requestedTimestamp <= this.lastTimestamp ? this.lastTimestamp + 1 : requestedTimestamp
    this.lastTimestamp = timestamp
    const event: RuntimeEvent = {
      ...input,
      id: input.id ?? `evt-${timestamp.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp,
      message: sanitizeMessage(input.message),
      ...(input.data ? { data: sanitizeData(input.data) } : {}),
    }
    fs.appendFileSync(this.eventFile, `${JSON.stringify(event)}\n`)
    this.maybeRotate()
    for (const cb of this.listeners) {
      try { cb(event) } catch { /* never block append */ }
    }
    return event
  }

  query(filter?: RuntimeEventFilter): RuntimeEvent[] {
    const limit = Math.max(1, Math.min(filter?.limit ?? 250, 1000))
    const current = this.parseFile(this.eventFile)

    // Decide whether archives are needed.
    let events: RuntimeEvent[]
    if (filter?.since !== undefined) {
      // We need all events after 'since'. If the oldest event in the current
      // file is newer than 'since', there may be a gap in archives.
      const oldestCurrent = current[0]?.timestamp
      if (oldestCurrent === undefined || oldestCurrent > filter.since) {
        events = [...this.readArchivesSince(filter.since), ...current]
      } else {
        events = current
      }
    } else if (current.length < limit) {
      // No time filter but not enough events in the current file — pull from archives.
      events = [...this.readArchivesForLimit(limit - current.length), ...current]
    } else {
      events = current
    }

    return events
      .filter(event => !filter?.sessionId || event.sessionId === filter.sessionId)
      .filter(event => !filter?.agent || event.agent === filter.agent)
      .filter(event => !filter?.level || event.level === filter.level)
      .filter(event => !filter?.eventType || event.eventType === filter.eventType)
      .filter(event => filter?.since === undefined || event.timestamp > filter.since)
      .slice(-limit)
  }

  last(): RuntimeEvent | null {
    return this.query({ limit: 1 })[0] ?? null
  }

  /** Returns storage metadata for observability. */
  getStorageInfo(): LogStorageInfo {
    const currentSizeBytes = fs.existsSync(this.eventFile)
      ? fs.statSync(this.eventFile).size
      : 0
    const archiveFiles = this.getArchiveFiles()
    const archiveSizeBytes = archiveFiles.reduce((sum, file) => {
      try { return sum + fs.statSync(file).size } catch { return sum }
    }, 0)
    return {
      currentSizeBytes,
      archiveCount: archiveFiles.length,
      totalSizeBytes: currentSizeBytes + archiveSizeBytes,
      maxSizeBytes: this.maxSizeBytes,
      maxFiles: this.maxFiles,
      archiveFiles: archiveFiles.map(f => path.relative(this.rootDir, f)),
    }
  }

  /** Rotate immediately (for testing). */
  rotateNow(): void {
    this.rotateLog()
  }

  // ── Rotation ────────────────────────────────────────────────────────────────

  private maybeRotate(): void {
    try {
      const { size } = fs.statSync(this.eventFile)
      if (size >= this.maxSizeBytes) this.rotateLog()
    } catch { /* ignore stat errors */ }
  }

  private rotateLog(): void {
    // Shift existing archives: events.(N-1).ndjson → events.N.ndjson
    for (let i = this.maxFiles; i >= 1; i--) {
      const from = path.join(this.rootDir, `events.${i}.ndjson`)
      const to = path.join(this.rootDir, `events.${i + 1}.ndjson`)
      if (fs.existsSync(from)) {
        if (i >= this.maxFiles) {
          fs.unlinkSync(from)
        } else {
          fs.renameSync(from, to)
        }
      }
    }
    // Rename current → events.1.ndjson (most recent archive)
    fs.renameSync(this.eventFile, path.join(this.rootDir, 'events.1.ndjson'))
    // Start a fresh current file
    fs.writeFileSync(this.eventFile, '')
    // Clean up any orphan archives beyond maxFiles
    this.pruneOldArchives()
  }

  private pruneOldArchives(): void {
    let i = this.maxFiles + 1
    while (true) {
      const file = path.join(this.rootDir, `events.${i}.ndjson`)
      if (!fs.existsSync(file)) break
      try { fs.unlinkSync(file) } catch { /* ignore */ }
      i++
    }
  }

  // ── Archive reading ─────────────────────────────────────────────────────────

  /** Returns archive files newest-first: [events.1.ndjson, events.2.ndjson, ...] */
  getArchiveFiles(): string[] {
    const files: string[] = []
    for (let i = 1; i <= this.maxFiles; i++) {
      const file = path.join(this.rootDir, `events.${i}.ndjson`)
      if (fs.existsSync(file)) files.push(file)
    }
    return files
  }

  /** Read from archives (newest first) until we find an event ≤ since. */
  private readArchivesSince(since: number): RuntimeEvent[] {
    const collected: RuntimeEvent[] = []
    for (const archiveFile of this.getArchiveFiles()) {
      const events = this.parseFile(archiveFile)
      // Prepend (these are older events)
      collected.unshift(...events)
      // If the oldest event in this archive is before 'since', we've covered the gap
      if (events[0] && events[0].timestamp <= since) break
    }
    return collected
  }

  /** Read from archives (newest first) to collect at least `needed` more events. */
  private readArchivesForLimit(needed: number): RuntimeEvent[] {
    const collected: RuntimeEvent[] = []
    for (const archiveFile of this.getArchiveFiles()) {
      const events = this.parseFile(archiveFile)
      collected.unshift(...events)
      if (collected.length >= needed) break
    }
    return collected
  }

  private parseFile(file: string): RuntimeEvent[] {
    if (!fs.existsSync(file)) return []
    return fs.readFileSync(file, 'utf-8')
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap(line => {
        try { return [JSON.parse(line) as RuntimeEvent] } catch { return [] }
      })
  }
}
