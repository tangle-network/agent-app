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
    readonly db: DB;
    /** Inject the active database instance (any driver's client). */
    setDatabase(database: DB): void;
    /** True once a database has been injected. */
    isReady(): boolean;
    /** Clear the injected database (next access throws again). Mainly for tests. */
    reset(): void;
}
/** Define options for configuring database provider behavior including error messaging */
export interface DatabaseProviderOptions {
    /** Error thrown when `db` is accessed before injection. Keep the product's
     *  existing wording so callers see a familiar message. */
    notReadyMessage?: string;
}
/** A database driver that can execute related SQLite statements as one batch.
 * Cloudflare D1 and libsql expose this method; portable local drivers may not. */
export interface SqliteBatchDatabase {
    batch?: (statements: [unknown, ...unknown[]]) => Promise<unknown[]>;
}
/** The three raw SQL control statements used by the explicit atomic path. */
export type SqliteTransactionCommand = 'BEGIN IMMEDIATE' | 'COMMIT' | 'ROLLBACK';
/** A statement that has not started before the transaction opens. The callback
 * receives the transaction connection, never a detached query promise. */
export type SqliteLazyStatement<T = unknown> = (connection: SqliteAtomicConnection) => T | Promise<T>;
/** The single connection exposed inside a native transaction callback. */
export interface SqliteAtomicConnection {
    /** Execute one lazy operation on this transaction's connection. */
    execute(statement: SqliteLazyStatement): unknown | Promise<unknown>;
}
/** A manually controlled connection owns both transaction commands and queries.
 * Keeping them on one value prevents a transaction from spanning two handles. */
export interface SqliteManualTransactionConnection extends SqliteAtomicConnection {
    exec(command: SqliteTransactionCommand): unknown | Promise<unknown>;
}
/**
 * A SQLite driver that can execute a group of statements atomically.
 *
 * Drivers should expose `transaction`; its callback receives the one connection
 * that owns the transaction. A portable driver may instead expose one
 * `fallbackConnection` containing both `exec` and `execute`. The fallback uses
 * lazy operations, so no query can start before `BEGIN IMMEDIATE`.
 */
export interface AtomicSqliteDatabase {
    transaction?: (callback: (connection: SqliteAtomicConnection) => unknown[] | Promise<unknown[]>) => unknown[] | Promise<unknown[]>;
    fallbackConnection?: SqliteManualTransactionConnection;
}
/** Execute related SQLite statements in one transactional driver batch when
 * supported, or sequentially in the same order for portable local drivers. */
export declare function runSqliteStatements(db: SqliteBatchDatabase, statements: [unknown, ...unknown[]]): Promise<unknown[]>;
/**
 * Execute related SQLite statements atomically.
 *
 * This helper is intentionally separate from {@link runSqliteStatements}.
 * The older helper preserves its portable sequential fallback; this helper
 * fails closed when the injected driver cannot prove atomicity.
 */
export declare function runAtomicSqliteStatements(db: AtomicSqliteDatabase, statements: [SqliteLazyStatement, ...SqliteLazyStatement[]]): Promise<unknown[]>;
/**
 * Create a swappable database provider. `DB` is the injected instance's type
 * (e.g. a drizzle `Database`); the proxy is typed as `DB` so callers keep full
 * typing and their existing query syntax.
 */
export declare function createDatabaseProvider<DB extends object>(options?: DatabaseProviderOptions): DatabaseProvider<DB>;
/** Describe the result of listing keys with completion status and optional pagination cursor */
export interface KVListResult {
    keys: {
        name: string;
    }[];
    list_complete: boolean;
    cursor?: string;
}
/** Define options for storing a key-value pair with expiration and metadata settings */
export interface KVPutOptions {
    expiration?: number;
    expirationTtl?: number;
    metadata?: unknown;
}
/** Resolve a key-value pair retrieval including its associated metadata and value */
export interface KVGetWithMetadataResult {
    value: string | null;
    metadata: unknown | null;
}
/** Define a key-value store interface for asynchronous data retrieval, storage, deletion, and listing */
export interface KVStore {
    get(key: string): Promise<string | null>;
    /** Read a value with its stored metadata (e.g. the vault's encrypted/hasPII flags). */
    getWithMetadata(key: string): Promise<KVGetWithMetadataResult>;
    put(key: string, value: string, options?: KVPutOptions): Promise<void>;
    delete(key: string): Promise<void>;
    list(options?: {
        prefix?: string;
        cursor?: string;
        limit?: number;
    }): Promise<KVListResult>;
}
/**
 * In-memory {@link KVStore} — the portable vault backend for sandbox/eval runs.
 * Backed by a Map; `list` returns all prefix-matched keys in one complete page
 * (no real pagination needed in-process). Seed with `initial` entries if useful.
 */
export declare function createInMemoryKV(initial?: Record<string, string>): KVStore;
