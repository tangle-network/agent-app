import type {
  FencedPrewarmClaimStore,
  PrewarmClaimLease,
  PrewarmClaimState,
} from './prewarm'

/**
 * `createD1PrewarmClaimStore` — the cross-isolate half of
 * `createSandboxPrewarmer`'s single-flight, implemented once.
 *
 * WHY THIS SHIPS HERE. `SandboxPrewarmerOptions.claim` is REQUIRED and has no
 * default, which is correct — the unsafe behaviour must be said out loud. But
 * "required with no implementation" is how five products end up hand-rolling
 * five subtly different atomic leases, and a lease that is subtly wrong is
 * indistinguishable from one that works until two tabs leak a box. Every
 * agent-app product deploys to Cloudflare Workers with a D1 binding, so the
 * store is the same code in all of them: it is mechanism, not domain, and it
 * belongs beside the prewarmer.
 *
 * The measured stake (staging-sandbox, 2026-07-28): two concurrent
 * `POST /v1/sandboxes` with an identical name BOTH returned HTTP 201 and left
 * two running boxes. The platform does not dedupe by name, so nothing below
 * this line is defensive programming — an unclaimed race genuinely doubles
 * spend.
 *
 * ── ATOMICITY IS THE WHOLE POINT ───────────────────────────────────────────
 * `acquire` is ONE statement. A `SELECT` followed by an `INSERT` is exactly the
 * race this exists to close: both isolates read "free", both write, both warm.
 * The upsert's `DO UPDATE ... WHERE expires_at <= now` means an unexpired claim
 * makes the conflict path a no-op, and `RETURNING` then yields no row — so the
 * loser learns it lost from the same statement that would have made it the
 * winner. `RETURNING` is used rather than `meta.changes` because a no-op upsert
 * reporting `changes: 0` is a SQLite detail, whereas "no row came back" is the
 * statement telling you directly.
 *
 * Foreground provisioning uses `acquireLease`/`releaseLease`. The lease's
 * returned `expiresAt` is a fencing value: takeover writes a value strictly
 * greater than the expired value, and release deletes only the matching value.
 * This uses the published two-column table without changing the legacy
 * `PrewarmClaimStore` methods or requiring a migration.
 *
 * ── STRUCTURAL, NOT A DEPENDENCY ───────────────────────────────────────────
 * The binding is taken as the narrow shape actually used (`prepare().bind()`,
 * `.first()`, `.run()`), per the package's structural-over-hard-dep rule. No
 * `@cloudflare/workers-types` import, so `/sandbox` stays importable in a plain
 * node test. A real `D1Database` satisfies it.
 *
 * ── THE TABLE IS THE PRODUCT'S MIGRATION, NOT A LAZY CREATE ────────────────
 * The store never runs DDL. A `CREATE TABLE IF NOT EXISTS` on every project
 * open costs a round trip on the exact path this feature exists to keep fast,
 * and it hides schema drift instead of failing on it. `PREWARM_CLAIM_TABLE_DDL`
 * is exported so a product pastes it into a real migration. If the table is
 * missing, `acquire` throws — and the prewarmer treats a throwing claim as a
 * failed warm: it records the failure, emits `onEvent({type:'failed'})`, and
 * degrades to the lazy path. Fail-closed and loud, never a silent double-warm.
 */

/** The columns and statements this store uses, and nothing else. A real
 *  `D1Database` structurally satisfies it. */
export interface PrewarmClaimD1Like {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>
      run(): Promise<unknown>
    }
  }
}

export interface D1PrewarmClaimStoreOptions {
  /** Defaults to `sandbox_prewarm_claims`. Must be a bare SQL identifier — it
   *  is interpolated, because a table name cannot be a bound parameter. */
  table?: string
  /** Clock seam for tests. */
  now?(): number
}

export const DEFAULT_PREWARM_CLAIM_TABLE = 'sandbox_prewarm_claims'

/** Paste into a migration. `expires_at` is epoch MILLISECONDS, matching
 *  `Date.now()`, so no unit conversion sits between the lease and its clock. */
export const PREWARM_CLAIM_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${DEFAULT_PREWARM_CLAIM_TABLE} (
  key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
)`

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * A fenced `PrewarmClaimStore` backed by one D1 table.
 *
 * ```ts
 * const prewarmer = createSandboxPrewarmer(shell, {
 *   claim: createD1PrewarmClaimStore(env.DB),
 *   mode: 'create-or-resume',
 * })
 * ```
 */
export function createD1PrewarmClaimStore(
  db: PrewarmClaimD1Like,
  options: D1PrewarmClaimStoreOptions = {},
): FencedPrewarmClaimStore {
  const table = options.table ?? DEFAULT_PREWARM_CLAIM_TABLE
  // A table name cannot be bound, so it is interpolated — which makes it the
  // one injection surface here. Reject anything that is not a bare identifier
  // at construction time, where the stack still points at the caller.
  if (!SAFE_IDENTIFIER.test(table)) {
    throw new Error(`Invalid prewarm claim table name: ${JSON.stringify(table)}`)
  }
  const now = options.now ?? (() => Date.now())

  const acquireSql = `INSERT INTO ${table} (key, expires_at) VALUES (?1, ?2)
ON CONFLICT(key) DO UPDATE SET expires_at = ?2 WHERE ${table}.expires_at <= ?3
RETURNING key`
  const acquireLeaseSql = `INSERT INTO ${table} (key, expires_at) VALUES (?1, ?2)
ON CONFLICT(key) DO UPDATE SET expires_at = MAX(?2, ${table}.expires_at + 1)
WHERE ${table}.expires_at <= ?3
RETURNING key, expires_at`
  const releaseSql = `DELETE FROM ${table} WHERE key = ?1`
  const releaseLeaseSql = `DELETE FROM ${table} WHERE key = ?1 AND expires_at = ?2`
  const inspectSql = `SELECT expires_at FROM ${table} WHERE key = ?1`

  async function inspect(key: string): Promise<PrewarmClaimState> {
    const row = await db
      .prepare(inspectSql)
      .bind(key)
      .first<{ expires_at: number }>()
    if (!row) return { status: 'absent' }
    return row.expires_at > now()
      ? { status: 'held', expiresAt: row.expires_at }
      : { status: 'expired', expiresAt: row.expires_at }
  }

  return {
    async acquire(key: string, ttlSeconds: number): Promise<boolean> {
      const at = now()
      const row = await db
        .prepare(acquireSql)
        .bind(key, at + ttlSeconds * 1000, at)
        .first<{ key: string }>()
      return row != null
    },

    async acquireLease(key: string, ttlSeconds: number): Promise<PrewarmClaimLease | null> {
      const at = now()
      const row = await db
        .prepare(acquireLeaseSql)
        .bind(key, at + ttlSeconds * 1000, at)
        .first<{ key: string; expires_at: number }>()
      if (!row) return null
      return Object.freeze({ key: row.key, expiresAt: row.expires_at })
    },

    async release(key: string): Promise<void> {
      // Best effort by the `PrewarmClaimStore` contract: the prewarmer swallows
      // a throw here because the TTL is what actually guarantees release.
      await db.prepare(releaseSql).bind(key).run()
    },

    async releaseLease(lease: PrewarmClaimLease): Promise<void> {
      await db.prepare(releaseLeaseSql).bind(lease.key, lease.expiresAt).run()
    },

    async isHeld(key: string): Promise<boolean> {
      return (await inspect(key)).status === 'held'
    },

    inspect,
  }
}
