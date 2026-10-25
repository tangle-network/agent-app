/**
 * Warm receipts: the record that a warm step already ran for exactly the
 * inputs it depends on, so a second warm with the same inputs does no work.
 *
 * A warm step (verify the session, resolve a child key, read the vault heads,
 * build the connected-tool catalog, resume the box) is keyed by what it
 * depends on: identity, workspace, thread, content hash, credential expiry.
 * `createWorkspacePrewarmRoute` looks the key up before it runs the step; an
 * unexpired receipt answers `hit` after one read and the step does not run.
 * The turn reads the same receipt at send to reuse what the warm produced.
 *
 * The receipt store is shared across isolates (D1), because Workers spread one
 * member's requests over many isolates: an in-isolate cache missed on 2 of 3
 * warm turns in Creative staging (connected-tool catalog 928-2,742
 * ms). The route still keeps an in-isolate copy, so a repeat in the same
 * isolate costs no read at all.
 *
 * A receipt's `report` is small JSON the product chooses (a vault head, a
 * catalog digest, a box id). It must never hold a credential: receipts are
 * rows any reader of the table can see.
 */

export type WarmReceiptReport = Record<string, string | number | boolean | null>

export interface WarmReceipt {
  /** Epoch ms the step finished. */
  at: number
  /** Epoch ms after which the receipt no longer counts. */
  expiresAt: number
  report?: WarmReceiptReport
}

export interface WarmReceiptStore {
  get(id: string): Promise<WarmReceipt | null>
  put(id: string, receipt: WarmReceipt): Promise<void>
}

/** The receipt id for one step and its key. */
export function warmReceiptId(step: string, key: string): string {
  return `${step}:${key}`
}

/**
 * A warm key from exactly the values a step depends on: the same values give
 * the same key whatever their order, and any change gives a new one. Values
 * are hashed (SHA-256, hex), so a key names no member, path or expiry in the
 * clear. Pass a credential's expiry or revision, never the credential.
 */
export async function warmKey(parts: Record<string, string | number | boolean | null>): Promise<string> {
  // A missing value would give every member the same key and serve one member's receipt to another.
  const missing = Object.keys(parts).filter((name) => parts[name] === undefined)
  if (missing.length) throw new Error(`warmKey: ${missing.join(', ')} undefined`)
  const canonical = JSON.stringify(Object.keys(parts).sort().map((name) => [name, parts[name]]))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Receipts in one isolate's memory: for tests and single-process hosts. */
export function createMemoryWarmReceiptStore(options: { limit?: number } = {}): WarmReceiptStore {
  const limit = options.limit ?? 1_000
  const receipts = new Map<string, WarmReceipt>()
  return {
    async get(id) {
      return receipts.get(id) ?? null
    },
    async put(id, receipt) {
      receipts.delete(id)
      receipts.set(id, receipt)
      for (const old of receipts.keys()) {
        if (receipts.size <= limit) break
        receipts.delete(old)
      }
    },
  }
}

/** The D1 surface the store uses. A real `D1Database` satisfies it. */
export interface WarmReceiptD1Like {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>
      run(): Promise<unknown>
    }
  }
}

export const DEFAULT_WARM_RECEIPT_TABLE = 'warm_receipts'

/** Paste into a product migration; the store never runs DDL. Times are epoch ms. */
export const WARM_RECEIPT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${DEFAULT_WARM_RECEIPT_TABLE} (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  report TEXT
);
CREATE INDEX IF NOT EXISTS ${DEFAULT_WARM_RECEIPT_TABLE}_by_expiry ON ${DEFAULT_WARM_RECEIPT_TABLE} (expires_at)`

/** One write in this many also deletes expired rows, so a table keyed by content hashes stays bounded. */
const PRUNE_EVERY_WRITES = 64

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Receipts in one D1 table, shared by every isolate. A missing table throws on
 * the first read, which the route treats as a miss: the step runs, and the
 * failure reaches `onEvent`.
 */
export function createD1WarmReceiptStore(db: WarmReceiptD1Like, options: { table?: string; now?: () => number } = {}): WarmReceiptStore {
  const table = options.table ?? DEFAULT_WARM_RECEIPT_TABLE
  if (!SAFE_IDENTIFIER.test(table)) throw new Error(`Invalid warm receipt table name: ${JSON.stringify(table)}`)
  const getSql = `SELECT at, expires_at, report FROM ${table} WHERE id = ?1`
  const putSql = `INSERT INTO ${table} (id, at, expires_at, report) VALUES (?1, ?2, ?3, ?4)
ON CONFLICT(id) DO UPDATE SET at = ?2, expires_at = ?3, report = ?4`
  const pruneSql = `DELETE FROM ${table} WHERE expires_at < ?1`
  const now = options.now ?? (() => Date.now())
  let writes = 0
  return {
    async get(id) {
      const row = await db.prepare(getSql).bind(id).first<{ at: number; expires_at: number; report: string | null }>()
      if (!row) return null
      return {
        at: row.at,
        expiresAt: row.expires_at,
        ...(row.report ? { report: JSON.parse(row.report) as WarmReceiptReport } : {}),
      }
    },
    async put(id, receipt) {
      await db.prepare(putSql).bind(id, receipt.at, receipt.expiresAt, receipt.report ? JSON.stringify(receipt.report) : null).run()
      if (++writes % PRUNE_EVERY_WRITES === 0) await db.prepare(pruneSql).bind(now()).run()
    },
  }
}
