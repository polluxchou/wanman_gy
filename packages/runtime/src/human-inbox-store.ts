/**
 * Persistent store for human-bound messages (to: 'human').
 *
 * Agent messages addressed to 'human' are NOT delivered through the relay
 * (which would make them consumable by agents). Instead, the supervisor
 * writes them here so the cockpit can read them non-destructively.
 *
 * Acknowledgement marks an item handled without affecting agent delivery.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createLogger } from './logger.js';

const log = createLogger('human-inbox-store');

function tryParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

export interface HumanInboxItem {
  id: string;
  from: string;
  /** 'decision' | 'blocker' | 'access_request' | 'message' */
  type: string;
  payload: unknown;
  priority: 'steer' | 'normal';
  timestamp: number;
  handled: boolean;
  handledAt: number | null;
}

export class HumanInboxStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS human_inbox (
        id TEXT PRIMARY KEY,
        "from" TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'message',
        payload TEXT NOT NULL,
        priority TEXT NOT NULL CHECK(priority IN ('steer', 'normal')),
        timestamp INTEGER NOT NULL,
        handled INTEGER NOT NULL DEFAULT 0,
        handled_at INTEGER
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_human_inbox_timestamp
      ON human_inbox(timestamp DESC)
    `);
    log.info('initialized');
  }

  /** Persist a human-bound message. Returns the new item id. */
  enqueue(from: string, type: string, payload: unknown, priority: 'steer' | 'normal'): string {
    const id = randomUUID();
    const timestamp = Date.now();
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.db.prepare(`
      INSERT INTO human_inbox (id, "from", type, payload, priority, timestamp, handled)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(id, from, type, payloadStr, priority, timestamp);
    log.info('enqueued', { id, from, type, priority });
    return id;
  }

  /** List human inbox items. Returns newest-first by default. */
  list(filter?: { status?: 'open' | 'handled' }): HumanInboxItem[] {
    let sql = `
      SELECT id, "from", type, payload, priority, timestamp, handled, handled_at
      FROM human_inbox
    `;
    const params: unknown[] = [];
    if (filter?.status === 'open') {
      sql += ' WHERE handled = 0';
    } else if (filter?.status === 'handled') {
      sql += ' WHERE handled = 1';
    }
    sql += ' ORDER BY timestamp DESC LIMIT 500';

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string; from: string; type: string; payload: string;
      priority: 'steer' | 'normal'; timestamp: number;
      handled: number; handled_at: number | null;
    }>;

    return rows.map(r => ({
      id: r.id,
      from: r.from,
      type: r.type,
      payload: tryParseJson(r.payload),
      priority: r.priority,
      timestamp: r.timestamp,
      handled: Boolean(r.handled),
      handledAt: r.handled_at ?? null,
    }));
  }

  /** Mark an item as handled. No-op if already handled or not found. */
  ack(id: string): boolean {
    const result = this.db.prepare(`
      UPDATE human_inbox SET handled = 1, handled_at = ? WHERE id = ? AND handled = 0
    `).run(Date.now(), id);
    const changed = (result.changes ?? 0) > 0;
    if (changed) log.info('ack', { id });
    return changed;
  }

  /** Count open (unhandled) items. */
  countOpen(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM human_inbox WHERE handled = 0
    `).get() as { count: number } | undefined;
    return row?.count ?? 0;
  }
}
