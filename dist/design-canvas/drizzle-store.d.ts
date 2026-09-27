/**
 * Drizzle-backed `SceneStore` over the tables from `createDesignCanvasTables`.
 * Works against any SQLite drizzle driver (better-sqlite3, D1, libsql).
 *
 * Defense in depth: RBAC runs before the store is constructed, but every
 * query still pins `workspaceId` AND `documentId` from the scope in its WHERE
 * clause, so a leaked or attacker-supplied row id from another workspace can
 * never read or write across the boundary — it surfaces as "not found".
 *
 * Optimistic concurrency for saveDocument: the UPDATE WHERE clause includes
 * `rev = expectedRev`; when 0 rows are changed (stale revision or missing
 * document), the store reads back the row to emit a precise error — either
 * "stale rev" or "not found" — so callers know whether to refetch-and-replay
 * or abort.
 */
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type { SceneStore, SceneStoreScope } from './store';
import type { DesignCanvasTables } from './schema';
/** Any SQLite drizzle database — `any` erases the driver-specific run-result
 *  and schema generics so better-sqlite3, D1, and libsql handles all fit. */
export type DesignCanvasDatabase = BaseSQLiteDatabase<'sync' | 'async', any, any>;
/** Define options for creating a Drizzle scene store including database, tables, and scope */
export interface CreateDrizzleSceneStoreOptions {
    db: DesignCanvasDatabase;
    tables: DesignCanvasTables;
    scope: SceneStoreScope;
}
/** Create a scene store configured with database tables and scoped to a specific document and workspace */
export declare function createDrizzleSceneStore(options: CreateDrizzleSceneStoreOptions): SceneStore;
