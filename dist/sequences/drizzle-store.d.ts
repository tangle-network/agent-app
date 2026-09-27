/**
 * Drizzle-backed `SequenceStore` over the tables from `createSequenceTables`.
 * Works against any SQLite drizzle driver (better-sqlite3, D1, libsql) — the
 * builders are awaited, never `.run()`/`.all()`, so sync and async drivers
 * behave identically.
 *
 * Defense in depth: RBAC runs before the store is constructed, but every
 * query still pins `workspaceId` AND `sequenceId` from the scope in its WHERE
 * clause, so a leaked or attacker-supplied row id from another workspace can
 * never read or write across the boundary — it surfaces as "not found".
 *
 * Store-level invariants (everything richer lives in the operation
 * validator): frame fields must be non-negative integers, clip durations at
 * least `MIN_SEQUENCE_CLIP_FRAMES`, and the sequence duration can never
 * shrink below the last clip end. Every mutation bumps `sequence.updatedAt`
 * so workspace recency sorts stay truthful.
 */
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { type SequenceClipMedia } from './model';
import type { SequenceStore, SequenceStoreScope } from './store';
import type { SequenceClipRow, SequenceTables } from './schema';
/** Any SQLite drizzle database — `any` erases the driver-specific run-result
 *  and schema generics so better-sqlite3, D1, and libsql handles all fit. */
export type SequenceDatabase = BaseSQLiteDatabase<'sync' | 'async', any, any>;
/** Resolves product-specific media (generation rows, asset rows) for a batch
 *  of clip rows. Keyed by clip id; clips absent from the map carry no media. */
export type SequenceMediaResolver = (clipRows: SequenceClipRow[]) => Promise<Map<string, SequenceClipMedia>>;
/** Define options for creating a Drizzle sequence store including database, tables, scope, and media resolver */
export interface CreateDrizzleSequenceStoreOptions {
    db: SequenceDatabase;
    tables: SequenceTables;
    scope: SequenceStoreScope;
    resolveMedia?: SequenceMediaResolver;
}
/** Create a sequence store scoped to a specific sequence and workspace with database access and media resolution */
export declare function createDrizzleSequenceStore(options: CreateDrizzleSequenceStoreOptions): SequenceStore;
