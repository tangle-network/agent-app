import { WARM_SLOTS, type WarmLeaseRow, type WarmLeaseStore } from './warm-lease'

/**
 * `createD1WarmLeaseStore`: the `WarmLeaseStore` every Workers product uses,
 * one row per key in one table.
 *
 * Race-sensitive steps are single statements. `begin` is an upsert whose SET
 * expressions read the old row, so two isolates that signal at once agree on
 * one lease id and only its owner runs the warm. `markUsed` claims the first
 * use with a conditional UPDATE … RETURNING, so two turns cannot both count as
 * the hit. The prediction slots are a decayed statistic and are written
 * without a fence: a lost increment under a race costs nothing.
 *
 * The table is the product's migration (`WARM_LEASE_TABLE_DDL`); the store
 * never runs DDL, for the same reason as `createD1PrewarmClaimStore`.
 */

export const DEFAULT_WARM_LEASE_TABLE = 'sandbox_warm_lease'

/** Paste into a migration. Times are epoch milliseconds; 0 means never. */
export const WARM_LEASE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${DEFAULT_WARM_LEASE_TABLE} (
  key TEXT PRIMARY KEY,
  lease_id TEXT,
  reason TEXT,
  started_at INTEGER NOT NULL DEFAULT 0,
  hold_until INTEGER NOT NULL DEFAULT 0,
  warm_at INTEGER NOT NULL DEFAULT 0,
  used_at INTEGER NOT NULL DEFAULT 0,
  resumed INTEGER NOT NULL DEFAULT 0,
  ping_at INTEGER NOT NULL DEFAULT 0,
  last_turn_at INTEGER NOT NULL DEFAULT 0,
  day TEXT NOT NULL DEFAULT '',
  day_warm_ms INTEGER NOT NULL DEFAULT 0,
  threshold REAL NOT NULL DEFAULT 0,
  slots TEXT NOT NULL DEFAULT '',
  slots_at INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL DEFAULT 0,
  predicted_at INTEGER NOT NULL DEFAULT 0
)`

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

interface Row {
  key: string
  lease_id: string | null
  reason: string | null
  started_at: number
  hold_until: number
  warm_at: number
  used_at: number
  resumed: number
  ping_at: number
  last_turn_at: number
  day: string
  day_warm_ms: number
  threshold: number
  slots: string
  slots_at: number
  first_seen_at: number
  predicted_at: number
}

/** The D1 surface this store uses: `prepare().bind()` with `first`, `run` and `all`. A real `D1Database` satisfies it. */
export interface WarmLeaseD1Like {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>
      run(): Promise<unknown>
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
    }
  }
}

function parseSlots(text: string): number[] {
  if (!text) return []
  try {
    const parsed: unknown = JSON.parse(text)
    if (Array.isArray(parsed) && parsed.length === WARM_SLOTS) return parsed.map((v) => Number(v) || 0)
  } catch {
    // A corrupt profile restarts learning; it must not break a turn.
  }
  return []
}

function toRow(row: Row): WarmLeaseRow {
  return {
    key: row.key,
    leaseId: row.lease_id,
    reason: row.reason,
    startedAt: row.started_at,
    holdUntil: row.hold_until,
    warmAt: row.warm_at,
    usedAt: row.used_at,
    resumed: row.resumed === 1,
    pingAt: row.ping_at,
    lastTurnAt: row.last_turn_at,
    day: row.day,
    dayWarmMs: row.day_warm_ms,
    threshold: row.threshold,
    slots: parseSlots(row.slots),
    slotsAt: row.slots_at,
    firstSeenAt: row.first_seen_at,
    predictedAt: row.predicted_at,
  }
}

export function createD1WarmLeaseStore(
  db: WarmLeaseD1Like,
  options: { table?: string } = {},
): WarmLeaseStore {
  const t = options.table ?? DEFAULT_WARM_LEASE_TABLE
  if (!SAFE_IDENTIFIER.test(t)) throw new Error(`Invalid warm lease table name: ${JSON.stringify(t)}`)

  // Every SET expression reads the old row, so `lease_id IS NULL` means "no live lease before this write".
  const beginSql = `INSERT INTO ${t} (key, lease_id, reason, started_at, hold_until) VALUES (?1, ?2, ?3, ?4, ?5)
ON CONFLICT(key) DO UPDATE SET
  lease_id = COALESCE(${t}.lease_id, ?2),
  reason = CASE WHEN ${t}.lease_id IS NULL THEN ?3 ELSE ${t}.reason END,
  started_at = CASE WHEN ${t}.lease_id IS NULL THEN ?4 ELSE ${t}.started_at END,
  warm_at = CASE WHEN ${t}.lease_id IS NULL THEN 0 ELSE ${t}.warm_at END,
  used_at = CASE WHEN ${t}.lease_id IS NULL THEN 0 ELSE ${t}.used_at END,
  resumed = CASE WHEN ${t}.lease_id IS NULL THEN 0 ELSE ${t}.resumed END,
  ping_at = CASE WHEN ${t}.lease_id IS NULL THEN 0 ELSE ${t}.ping_at END,
  hold_until = MAX(${t}.hold_until, ?5)
RETURNING lease_id`
  const markWarmSql = `UPDATE ${t} SET warm_at = ?3, resumed = ?4 WHERE key = ?1 AND lease_id = ?2`
  const firstUseSql = `UPDATE ${t} SET used_at = ?2 WHERE key = ?1 AND lease_id IS NOT NULL AND used_at = 0 RETURNING key`
  const turnSql = `INSERT INTO ${t} (key, last_turn_at, hold_until) VALUES (?1, ?2, ?3)
ON CONFLICT(key) DO UPDATE SET last_turn_at = ?2, hold_until = MAX(${t}.hold_until, ?3)`
  // A charge for an older day than the row holds is dropped: that day's budget is already spent.
  const endSql = `UPDATE ${t} SET
  lease_id = NULL, reason = NULL, started_at = 0, warm_at = 0, used_at = 0, resumed = 0, ping_at = 0,
  day_warm_ms = CASE WHEN day = ?3 THEN day_warm_ms + ?4 WHEN day < ?3 THEN ?4 ELSE day_warm_ms END,
  day = CASE WHEN day < ?3 THEN ?3 ELSE day END,
  threshold = COALESCE(?5, threshold)
WHERE key = ?1 AND lease_id = ?2`
  const profileSql = `UPDATE ${t} SET slots = ?2, slots_at = ?3, first_seen_at = ?4 WHERE key = ?1`
  const readSql = `SELECT * FROM ${t} WHERE key = ?1`

  const read = async (key: string): Promise<WarmLeaseRow | null> => {
    const row = await db.prepare(readSql).bind(key).first<Row>()
    return row ? toRow(row) : null
  }
  const list = async (sql: string, ...values: unknown[]): Promise<WarmLeaseRow[]> =>
    ((await db.prepare(sql).bind(...values).all<Row>()).results ?? []).map(toRow)

  return {
    read,

    async begin(key, leaseId, reason, now, holdUntil) {
      const row = await db.prepare(beginSql).bind(key, leaseId, reason, now, holdUntil).first<{ lease_id: string }>()
      if (!row) throw new Error('warm lease begin returned no row')
      return row.lease_id
    },

    async markWarm(key, leaseId, warmAt, resumed) {
      await db.prepare(markWarmSql).bind(key, leaseId, warmAt, resumed ? 1 : 0).run()
    },

    async markUsed(key, now, holdUntil) {
      const before = await read(key)
      const claimed = await db.prepare(firstUseSql).bind(key, now).first<{ key: string }>()
      await db.prepare(turnSql).bind(key, now, holdUntil).run()
      // Another turn claimed the first use between the read and the claim: this one is not the hit.
      if (before && !claimed && before.usedAt <= 0) return { ...before, usedAt: now }
      return before
    },

    async end(key, leaseId, day, chargeMs, threshold) {
      await db
        .prepare(endSql)
        .bind(key, leaseId, day, Math.max(0, Math.round(chargeMs)), threshold ?? null)
        .run()
    },

    async writeProfile(key, slots, slotsAt, firstSeenAt) {
      const rounded = slots.map((v) => Math.round(v * 1000) / 1000)
      await db.prepare(profileSql).bind(key, JSON.stringify(rounded), slotsAt, firstSeenAt).run()
    },

    async markPinged(key, at) {
      await db.prepare(`UPDATE ${t} SET ping_at = ?2 WHERE key = ?1`).bind(key, at).run()
    },

    async markPredicted(key, at) {
      await db.prepare(`UPDATE ${t} SET predicted_at = ?2 WHERE key = ?1`).bind(key, at).run()
    },

    listExpired: (now, limit) =>
      list(`SELECT * FROM ${t} WHERE lease_id IS NOT NULL AND hold_until <= ?1 ORDER BY hold_until LIMIT ?2`, now, limit),

    listHeld: (now, limit) =>
      list(`SELECT * FROM ${t} WHERE hold_until > ?1 ORDER BY ping_at LIMIT ?2`, now, limit),

    // Random order so a large fleet is covered across sweeps instead of always checking the same rows.
    listPredictable: (now, limit) =>
      list(
        `SELECT * FROM ${t} WHERE lease_id IS NULL AND first_seen_at > 0 AND predicted_at <= ?1 ORDER BY random() LIMIT ?2`,
        now - 3_600_000,
        limit,
      ),
  }
}
