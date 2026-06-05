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

export interface DatabaseProviderOptions {
  /** Error thrown when `db` is accessed before injection. Keep the product's
   *  existing wording so callers see a familiar message. */
  notReadyMessage?: string
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

export interface KVListResult {
  keys: { name: string }[]
  list_complete: boolean
  cursor?: string
}

export interface KVStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<KVListResult>
}

/**
 * In-memory {@link KVStore} — the portable vault backend for sandbox/eval runs.
 * Backed by a Map; `list` returns all prefix-matched keys in one complete page
 * (no real pagination needed in-process). Seed with `initial` entries if useful.
 */
export function createInMemoryKV(initial?: Record<string, string>): KVStore {
  const store = new Map<string, string>(initial ? Object.entries(initial) : [])
  return {
    async get(key) {
      return store.has(key) ? (store.get(key) as string) : null
    },
    async put(key, value) {
      store.set(key, value)
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
