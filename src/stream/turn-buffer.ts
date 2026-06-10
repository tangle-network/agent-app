/**
 * Resumable chat turns — the router-path answer to "streams resume on
 * disconnect" (issue #27). A turn's loop events are teed into a store as they
 * stream; the turn keeps running under `ctx.waitUntil` when the client drops;
 * a reconnecting client replays the buffered tail by sequence number and
 * keeps following until the turn completes.
 *
 *   POST /chat/stream            → pumpBufferedTurn(...) + live NDJSON
 *   GET  /chat/stream/:turnId    → replayTurnEvents({ fromSeq }) → NDJSON
 *
 * Storage is a structural seam ({@link TurnEventStore}); a D1 implementation
 * ships here because that's what Cloudflare products have (KV is unsuitable:
 * eventually consistent cross-isolate). Per-token deltas would mean hundreds
 * of rows per turn, so consecutive text/reasoning deltas are coalesced within
 * a flush window before they are persisted — replay yields slightly chunkier
 * deltas with identical concatenation.
 */

export type TurnStatus = 'running' | 'complete' | 'error'

export interface BufferedTurnEvent {
  seq: number
  /** The serialized event line (JSON string, no trailing newline). */
  event: string
}

export interface TurnEventStore {
  append(turnId: string, events: BufferedTurnEvent[]): Promise<void>
  read(turnId: string, fromSeq: number): Promise<BufferedTurnEvent[]>
  setStatus(turnId: string, status: TurnStatus): Promise<void>
  getStatus(turnId: string): Promise<TurnStatus | null>
}

// ── coalescing ────────────────────────────────────────────────────────────

type AnyRecord = Record<string, unknown>

function deltaTypeOf(ev: unknown): 'text' | 'reasoning' | null {
  const e = ev as AnyRecord | null
  if (!e || typeof e !== 'object') return null
  const inner = (e.kind === 'event' ? (e.event as AnyRecord | undefined) : e) as AnyRecord | undefined
  if (!inner || typeof inner !== 'object') return null
  if ((inner.type === 'text' || inner.type === 'reasoning') && typeof inner.text === 'string') {
    return inner.type
  }
  return null
}

/** Merge consecutive text/reasoning deltas of the same type into one event.
 *  Concatenation-preserving: replaying the coalesced stream produces the same
 *  accumulated text as the original. */
export function coalesceDeltas(events: unknown[]): unknown[] {
  const out: unknown[] = []
  for (const ev of events) {
    const type = deltaTypeOf(ev)
    const prev = out[out.length - 1]
    if (type && prev && deltaTypeOf(prev) === type) {
      const read = (x: unknown): AnyRecord =>
        ((x as AnyRecord).kind === 'event' ? (x as AnyRecord).event : x) as AnyRecord
      const merged = JSON.parse(JSON.stringify(prev)) as AnyRecord
      read(merged).text = String(read(prev).text) + String(read(ev).text)
      out[out.length - 1] = merged
      continue
    }
    out.push(ev)
  }
  return out
}

// ── pump (producer side) ──────────────────────────────────────────────────

export interface PumpBufferedTurnOptions {
  source: AsyncIterable<unknown>
  store: TurnEventStore
  turnId: string
  /** Deliver one serialized line (with seq) to the live client. Throwing here
   *  (client disconnected) does NOT stop the turn — events keep buffering. */
  write?: (line: string) => Promise<void> | void
  /** Flush buffered events to the store at most this often. Default 400ms. */
  flushIntervalMs?: number
}

/**
 * Drive a turn to completion regardless of the live client: every source
 * event is sequence-numbered, delivered to `write` (best-effort), and flushed
 * to the store in coalesced batches. Returns a promise that resolves when the
 * turn finishes — hand it to `ctx.waitUntil` so a disconnect can't kill the
 * turn. Never rejects on client-write failure; a source error marks the turn
 * status 'error' (after flushing what was produced) and rethrows.
 */
export async function pumpBufferedTurn(opts: PumpBufferedTurnOptions): Promise<void> {
  const flushIntervalMs = opts.flushIntervalMs ?? 400
  let seq = 0
  let clientGone = false
  let pending: unknown[] = []
  let lastFlush = Date.now()

  async function flush(): Promise<void> {
    if (pending.length === 0) return
    const batch = coalesceDeltas(pending)
    pending = []
    const rows = batch.map((ev) => ({ seq: ++seq, event: JSON.stringify(ev) }))
    await opts.store.append(opts.turnId, rows)
    lastFlush = Date.now()
  }

  await opts.store.setStatus(opts.turnId, 'running')
  try {
    for await (const ev of opts.source) {
      pending.push(ev)
      if (!clientGone && opts.write) {
        try {
          // Live delivery carries a provisional ordering hint, not the
          // persisted seq (coalescing changes seq assignment); clients resume
          // with the seqs from replay, or 0 for "everything".
          await opts.write(JSON.stringify(ev))
        } catch {
          clientGone = true
        }
      }
      if (Date.now() - lastFlush >= flushIntervalMs) await flush()
    }
    await flush()
    await opts.store.setStatus(opts.turnId, 'complete')
  } catch (err) {
    await flush().catch(() => {})
    await opts.store.setStatus(opts.turnId, 'error').catch(() => {})
    throw err
  }
}

// ── replay (consumer side) ────────────────────────────────────────────────

export interface ReplayTurnEventsOptions {
  store: TurnEventStore
  turnId: string
  /** Replay strictly after this sequence number (0 = from the beginning). */
  fromSeq?: number
  /** Poll cadence while the turn is still running. Default 500ms. */
  pollMs?: number
  /** Give up following a 'running' turn after this long. Default 120s. */
  timeoutMs?: number
}

/**
 * Yield buffered events after `fromSeq`, then keep polling while the turn is
 * still 'running' until it completes, errors, or times out. Terminates with a
 * final `{seq: -1, event: '{"type":"turn_status",...}'}` marker so clients
 * know why the replay ended.
 */
export async function* replayTurnEvents(opts: ReplayTurnEventsOptions): AsyncGenerator<BufferedTurnEvent> {
  const pollMs = opts.pollMs ?? 500
  const timeoutMs = opts.timeoutMs ?? 120_000
  let cursor = opts.fromSeq ?? 0
  const deadline = Date.now() + timeoutMs

  for (;;) {
    const batch = await opts.store.read(opts.turnId, cursor)
    for (const row of batch) {
      cursor = Math.max(cursor, row.seq)
      yield row
    }
    const status = await opts.store.getStatus(opts.turnId)
    if (status !== 'running') {
      yield { seq: -1, event: JSON.stringify({ type: 'turn_status', status: status ?? 'unknown' }) }
      return
    }
    if (Date.now() >= deadline) {
      yield { seq: -1, event: JSON.stringify({ type: 'turn_status', status: 'timeout' }) }
      return
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

// ── D1 store ──────────────────────────────────────────────────────────────

/** Minimal structural D1 contract (Cloudflare `D1Database` satisfies it). */
export interface D1LikeForTurns {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
      first<T = Record<string, unknown>>(): Promise<T | null>
    }
  }
}

/** Schema for the D1 store — append to the product's migrations. */
export const TURN_EVENTS_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS turn_events (
  turnId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event TEXT NOT NULL,
  PRIMARY KEY (turnId, seq)
);
CREATE TABLE IF NOT EXISTS turn_status (
  turnId TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
`

export function createD1TurnEventStore(db: D1LikeForTurns): TurnEventStore {
  return {
    async append(turnId, events) {
      if (!events.length) return
      // One multi-row insert per flush window keeps write volume bounded.
      const placeholders = events.map(() => '(?, ?, ?)').join(', ')
      const values = events.flatMap((e) => [turnId, e.seq, e.event])
      await db.prepare(`INSERT OR IGNORE INTO turn_events (turnId, seq, event) VALUES ${placeholders}`).bind(...values).run()
    },
    async read(turnId, fromSeq) {
      const { results } = await db
        .prepare('SELECT seq, event FROM turn_events WHERE turnId = ? AND seq > ? ORDER BY seq ASC')
        .bind(turnId, fromSeq)
        .all<{ seq: number; event: string }>()
      return results
    },
    async setStatus(turnId, status) {
      await db
        .prepare(
          'INSERT INTO turn_status (turnId, status, updatedAt) VALUES (?, ?, ?) ON CONFLICT(turnId) DO UPDATE SET status = excluded.status, updatedAt = excluded.updatedAt',
        )
        .bind(turnId, status, new Date().toISOString())
        .run()
    },
    async getStatus(turnId) {
      const row = await db.prepare('SELECT status FROM turn_status WHERE turnId = ?').bind(turnId).first<{ status: TurnStatus }>()
      return row?.status ?? null
    },
  }
}

/** In-memory store for tests and keyless local dev. */
export function createMemoryTurnEventStore(): TurnEventStore {
  const events = new Map<string, BufferedTurnEvent[]>()
  const status = new Map<string, TurnStatus>()
  return {
    async append(turnId, rows) {
      const list = events.get(turnId) ?? []
      list.push(...rows)
      events.set(turnId, list)
    },
    async read(turnId, fromSeq) {
      return (events.get(turnId) ?? []).filter((e) => e.seq > fromSeq)
    },
    async setStatus(turnId, s) {
      status.set(turnId, s)
    },
    async getStatus(turnId) {
      return status.get(turnId) ?? null
    },
  }
}
