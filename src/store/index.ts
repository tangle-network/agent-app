/**
 * Swappable database provider — the seam that decouples the agent's persistence
 * from any one driver.
 *
 * The agent core (and the app's server modules) import a single `db` and use it
 * directly. That `db` is a lazy proxy: it forwards to whatever database instance
 * the runtime injects via {@link DatabaseProvider.setDatabase}. So the SAME core
 * runs on:
 *   - Cloudflare D1            (`setDatabase(drizzle(d1, schema))`)        — prod
 *   - SQLite / miniflare       (`setDatabase(drizzle(betterSqlite, schema))`) — eval / the portable inner shell
 *   - libsql / Turso, Postgres (`setDatabase(drizzle(client, schema))`)    — a future hosted DB
 *
 * Adding a new database is one adapter (a drizzle instance over a new driver) +
 * a `setDatabase` call. None of the modules importing `db` change. Substrate-
 * free and driver-agnostic: this module knows nothing about D1, drizzle, or any
 * schema — it only forwards property access to the injected instance.
 */

export interface DatabaseProvider<DB> {
  /** The injected database, as a lazy proxy. Throws (with `notReadyMessage`)
   *  on any access before {@link setDatabase} is called. */
  readonly db: DB
  /** Inject the active database instance (any driver's client). */
  setDatabase(database: DB): void
  /** True once a database has been injected. */
  isReady(): boolean
  /** Clear the injected database (next access throws again). Mainly for tests. */
  reset(): void
}

/** Define options for configuring database provider behavior including error messaging */
export interface DatabaseProviderOptions {
  /** Error thrown when `db` is accessed before injection. Keep the product's
   *  existing wording so callers see a familiar message. */
  notReadyMessage?: string
}

/** A database driver that can execute related SQLite statements as one batch.
 * Cloudflare D1 and libsql expose this method; portable local drivers may not. */
export interface SqliteBatchDatabase {
  batch?: (statements: [unknown, ...unknown[]]) => Promise<unknown[]>
}

/** The three raw SQL control statements used by the explicit atomic path. */
export type SqliteTransactionCommand = 'BEGIN IMMEDIATE' | 'COMMIT' | 'ROLLBACK'

/**
 * A SQLite driver that can execute a group of statements atomically.
 *
 * `batch` is preferred because D1 and libsql expose it as their atomic
 * primitive. A driver without `batch` must expose `exec` for raw transaction
 * control; the helper then issues `BEGIN IMMEDIATE`, awaits each statement,
 * and commits or rolls back as one unit. A database with neither capability is
 * rejected instead of falling back to the non-atomic helper.
 */
export interface AtomicSqliteDatabase extends SqliteBatchDatabase {
  exec?: (command: SqliteTransactionCommand) => unknown | Promise<unknown>
}

/** Execute related SQLite statements in one transactional driver batch when
 * supported, or sequentially in the same order for portable local drivers. */
export async function runSqliteStatements(
  db: SqliteBatchDatabase,
  statements: [unknown, ...unknown[]],
): Promise<unknown[]> {
  if (typeof db.batch === 'function') {
    return await db.batch(statements)
  }
  const results: unknown[] = []
  for (const statement of statements) results.push(await statement)
  return results
}

/**
 * Execute related SQLite statements atomically.
 *
 * This helper is intentionally separate from {@link runSqliteStatements}.
 * The older helper preserves its portable sequential fallback; this helper
 * fails closed when the injected driver cannot prove atomicity.
 */
export async function runAtomicSqliteStatements(
  db: AtomicSqliteDatabase,
  statements: [unknown, ...unknown[]],
): Promise<unknown[]> {
  if (typeof db.batch === 'function') {
    return await db.batch(statements)
  }

  if (typeof db.exec !== 'function') {
    throw new Error(
      'runAtomicSqliteStatements: the injected driver exposes neither batch() nor exec() — atomic execution is unavailable',
    )
  }

  await db.exec('BEGIN IMMEDIATE')
  try {
    const results: unknown[] = []
    for (const statement of statements) results.push(await statement)
    await db.exec('COMMIT')
    return results
  } catch (error) {
    try {
      await db.exec('ROLLBACK')
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'runAtomicSqliteStatements: statement execution and rollback both failed',
      )
    }
    throw error
  }
}

/**
 * Create a swappable database provider. `DB` is the injected instance's type
 * (e.g. a drizzle `Database`); the proxy is typed as `DB` so callers keep full
 * typing and their existing query syntax.
 */
export function createDatabaseProvider<DB extends object>(
  options: DatabaseProviderOptions = {},
): DatabaseProvider<DB> {
  const message = options.notReadyMessage ?? 'Database not initialized — call setDatabase() first.'
  let current: DB | null = null

  const db = new Proxy({} as DB, {
    get(_target, prop) {
      if (!current) throw new Error(message)
      const value = (current as Record<string | symbol, unknown>)[prop]
      // Bind methods to the real instance so `this` resolves correctly through
      // the proxy (works for drizzle's query builders and class-based stores).
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(current) : value
    },
    has(_target, prop) {
      return current !== null && prop in (current as object)
    },
  })

  return {
    db,
    setDatabase(database: DB) {
      current = database
    },
    isReady() {
      return current !== null
    },
    reset() {
      current = null
    },
  }
}

// ── KV store port (the vault backend) ───────────────────────────────────────
//
// The vault (workspace files) is a key/value store. In production it's a
// Cloudflare `KVNamespace`; the portable inner shell injects an in-memory (or
// other) implementation. This is the subset of the KV API the vault uses —
// `KVNamespace` satisfies it structurally, so prod passes the binding unchanged,
// and `createInMemoryKV()` supplies the portable adapter for sandbox/eval.

/** Describe the result of listing keys with completion status and optional pagination cursor */
export interface KVListResult {
  keys: { name: string }[]
  list_complete: boolean
  cursor?: string
}

/** Define options for storing a key-value pair with expiration and metadata settings */
export interface KVPutOptions {
  expiration?: number
  expirationTtl?: number
  metadata?: unknown
}

/** Resolve a key-value pair retrieval including its associated metadata and value */
export interface KVGetWithMetadataResult {
  value: string | null
  metadata: unknown | null
}

/** Define a key-value store interface for asynchronous data retrieval, storage, deletion, and listing */
export interface KVStore {
  get(key: string): Promise<string | null>
  /** Read a value with its stored metadata (e.g. the vault's encrypted/hasPII flags). */
  getWithMetadata(key: string): Promise<KVGetWithMetadataResult>
  put(key: string, value: string, options?: KVPutOptions): Promise<void>
  delete(key: string): Promise<void>
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<KVListResult>
}

/**
 * In-memory {@link KVStore} — the portable vault backend for sandbox/eval runs.
 * Backed by a Map; `list` returns all prefix-matched keys in one complete page
 * (no real pagination needed in-process). Seed with `initial` entries if useful.
 */
export function createInMemoryKV(initial?: Record<string, string>): KVStore {
  const store = new Map<string, { value: string; metadata: unknown }>(
    initial ? Object.entries(initial).map(([k, v]) => [k, { value: v, metadata: null }]) : [],
  )
  return {
    async get(key) {
      return store.get(key)?.value ?? null
    },
    async getWithMetadata(key) {
      const entry = store.get(key)
      return { value: entry?.value ?? null, metadata: entry?.metadata ?? null }
    },
    async put(key, value, options) {
      store.set(key, { value, metadata: options?.metadata ?? null })
    },
    async delete(key) {
      store.delete(key)
    },
    async list(options) {
      const prefix = options?.prefix ?? ''
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort()
        .map((name) => ({ name }))
      return { keys, list_complete: true }
    },
  }
}
