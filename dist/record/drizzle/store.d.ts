/**
 * The write / review / list / materialize surface over a table from
 * {@link createRecordTable}. Policy is enforced HERE, at the write boundary,
 * never in callers.
 *
 * - `path` must be a key of the consumer's schema map, and the value must pass
 *   that path's validator. Nothing the fold cannot type-check reaches storage.
 * - `reviewState` on write is a function of `sourceKind` alone, read from the
 *   consumer's `reviewStateOnWrite` map. An undeclared source kind is refused.
 * - Conflict rule: a write whose key already holds a live accepted entry from a
 *   DIFFERENT source kind with a materially different value does not supersede
 *   — it lands `proposed` with `conflict = true` for a human to resolve.
 * - Accepting a proposal is the ONLY path from `proposed` to `accepted`, and it
 *   clears the conflict flag — a human looked at the disagreement and chose.
 *   Accepted entries change by supersession (a new write), never by re-review.
 *
 * ## The D1 rules this store is built around
 *
 * **`transaction()` does not work on D1.** Drizzle exposes it, and on the D1
 * driver it does not give you a transaction — `batch()` is the only atomic
 * primitive Cloudflare offers. So a supersede is one `db.batch([guard, main])`:
 * a guarded UPDATE that marks the outgoing head, and the INSERT (or the accept
 * UPDATE) that installs the new one. A driver with no `batch` (better-sqlite3)
 * gets an explicit `BEGIN IMMEDIATE` / `COMMIT` instead; a driver with neither
 * is refused with `unsupported-driver` rather than quietly running two
 * statements that can half-land.
 *
 * **Unique indexes do not dedupe NULLs in SQLite.** Every key column is NOT
 * NULL with a sentinel (see the schema factory), which is what makes the
 * partial unique index on the live head enforce anything at all.
 *
 * **Ordering never depends on a timestamp.** `created_at` is second- or
 * millisecond-resolution and two entries can share it; `seq` is assigned
 * inside the INSERT statement (SQLite executes a statement atomically, so
 * `MAX(seq) + 1` cannot race, and `(scope_id, seq)` unique backstops it).
 *
 * ## Losing the head race
 *
 * The guarded UPDATE matches the outgoing head by id AND by "still accepted,
 * still live". If a competing writer got there first, one of two things
 * happens, and both are safe:
 *
 * - the competitor installed its own live head, so this write's INSERT trips
 *   the partial unique index and the WHOLE batch is rolled back — surfaced as
 *   a unique violation and retried from a fresh read;
 * - or the batch committed with the guard matching zero rows, which the live
 *   head index makes unreachable. That is an invariant breach, so it is
 *   returned as `supersede-race` rather than retried: a retry would insert a
 *   SECOND row for a write that already landed.
 *
 * ## Losing the REVIEW race
 *
 * The head race is only half of it. On the accept path the dependent statement
 * has a precondition of its own — the proposal must still be `proposed` — and
 * a second reviewer can reject it between this store's read and its write. A
 * `batch` driver cannot look at the first statement before running the second,
 * so the guard carries that precondition too (`markHeadStatement`'s
 * `requireProposedId`): either both statements match or neither does, and a
 * head can never be stamped superseded by an entry that was rejected. Both row
 * counts are then checked, and which one missed decides the answer — a
 * resolved proposal is `not-reviewable`, a moved head is a retry.
 *
 * Every method returns a typed outcome; callers inspect `succeeded` before
 * touching `value`.
 */
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { type RecordOutcome, type RecordReviewState, type RecordSourceLocator, type RecordWritePolicy } from '../model';
import { type FoldableRecordEntry, type RecordFoldRules, type RecordPeriodScopeResolver } from '../fold';
import type { RecordEntryRow, RecordTable } from './schema';
/**
 * Any SQLite drizzle database. The run-result and schema generics are erased
 * to `unknown` so better-sqlite3, D1 and libsql handles all fit; `batch` is
 * declared optional because only D1 and libsql expose it.
 */
export type RecordDatabase = BaseSQLiteDatabase<'sync' | 'async', unknown, Record<string, unknown>> & {
    batch?(statements: [unknown, ...unknown[]]): Promise<unknown[]>;
};
/** How this store executes a two-statement atomic unit on the caller's driver. */
export type RecordAtomicStrategy = 'batch' | 'begin-immediate';
/** Input to {@link RecordStore.write}. */
export interface WriteRecordEntryInput {
    scopeId: string;
    /** Must be a key of the policy's schema map, or — when `affirmedEmpty` — one
     *  of its affirmable paths. */
    path: string;
    /** Defaults to {@link RECORD_PERIOD_SENTINEL}. */
    period?: number;
    /** Defaults to {@link RECORD_KEY_SENTINEL}; canonicalized by the policy. */
    dimension?: string;
    /** Defaults to {@link RECORD_KEY_SENTINEL}; canonicalized by the policy. */
    itemKey?: string;
    /** The value. Must be absent when `affirmedEmpty` is true. */
    value?: unknown;
    /** Assert "there are none of these" at `path`. */
    affirmedEmpty?: boolean;
    /** Stamped by the SERVER call site — never read from model arguments. */
    sourceKind: string;
    sourceRef?: string | null;
    sourceLocator?: RecordSourceLocator | null;
    sourceQuote?: string | null;
    confidence?: number | null;
    /**
     * Values for the product columns declared through the table factory's
     * `extraColumns`. Carried onto the INSERT verbatim — the store reads none of
     * them and knows none of their names. `policy.requireExtras` is where a
     * product says which ones a given source kind must supply.
     *
     * A key with no matching column is refused rather than dropped: a citation
     * that silently did not store its source id is the failure this store exists
     * to make impossible.
     */
    extras?: Readonly<Record<string, unknown>>;
}
/** What a write produced. */
export interface WriteRecordEntryResult {
    entry: RecordEntryRow;
    /** True when the write landed `proposed` with the conflict flag set. */
    conflict: boolean;
    /** Id of the live head this write superseded, when it superseded one. */
    supersededEntryId: string | null;
}
/** Input to {@link RecordStore.review}. */
export interface ReviewRecordEntryInput {
    scopeId: string;
    entryId: string;
    action: 'accept' | 'reject';
    /** Recorded on the row; the store never derives it. */
    reviewedBy?: string | null;
}
/** Filters for {@link RecordStore.list}. */
export interface ListRecordEntriesInput {
    scopeId: string;
    /** Narrow to one review state. Does not resurrect superseded entries. */
    reviewState?: RecordReviewState;
    /** Resolve visibility against this period. Omit to return every period. */
    period?: number;
    /** Include entries a later accepted entry replaced. Default false. */
    includeSuperseded?: boolean;
    /** Include rejected entries. Default false, unless `reviewState` asks for
     *  them explicitly. */
    includeRejected?: boolean;
}
/** Input to {@link RecordStore.heads}. */
export interface ReadRecordHeadsInput {
    scopeId: string;
    /**
     * The period to resolve against. Defaults to {@link RECORD_PERIOD_SENTINEL},
     * which is the right default ONLY for a consumer with no time dimension —
     * every entry it writes sits at `0`. A consumer that uses periods passes one
     * on every read; omitting it there resolves against period `0` and returns
     * nothing, rather than quietly mixing periods together.
     */
    period?: number;
}
/** Input to {@link RecordStore.materialize}. */
export interface MaterializeRecordInput<T> {
    scopeId: string;
    /** The consumer's grouping rules. */
    rules: RecordFoldRules<T>;
    /** Same default and same caveat as {@link ReadRecordHeadsInput.period}. */
    period?: number;
}
/** What a materialization produced. */
export interface MaterializeRecordResult<T> {
    value: T;
    /** Live accepted entries folded in. */
    entryCount: number;
    /** Proposed entries visible at this period and still awaiting review. */
    pendingProposed: number;
    /** Subset of those flagged by the conflict rule. */
    conflicts: number;
}
/** Options for {@link createRecordStore}. */
export interface CreateRecordStoreOptions {
    db: RecordDatabase;
    /** The table from `createRecordTable`. */
    table: RecordTable;
    /** Everything domain-specific about a write. */
    policy: RecordWritePolicy;
    /**
     * Period scope per path, used by `list`'s period filter and as the default
     * for `materialize` when the fold rules omit their own. Defaults to `'exact'`
     * for every path.
     */
    periodScope?: RecordPeriodScopeResolver;
    /** Id minter. Defaults to a ULID. */
    newId?: () => string;
    /** Clock for `reviewedAt`. Defaults to `Date.now`. */
    now?: () => number;
    /** Attempts before a contended head write gives up. Defaults to 3. */
    maxWriteAttempts?: number;
}
/** The store surface. */
export interface RecordStore {
    /** Which atomic primitive this store resolved for the injected driver. */
    readonly atomicStrategy: RecordAtomicStrategy;
    /** Append one entry, superseding the live head when the write is accepted. */
    write(input: WriteRecordEntryInput): Promise<RecordOutcome<WriteRecordEntryResult>>;
    /** Accept or reject a proposed entry. */
    review(input: ReviewRecordEntryInput): Promise<RecordOutcome<RecordEntryRow>>;
    /** Entries visible under the filters, ordered by `seq`. */
    list(input: ListRecordEntriesInput): Promise<RecordOutcome<RecordEntryRow[]>>;
    /** Live accepted heads visible at `period`, ordered by `seq`. Visibility is
     *  the store's period scope, the same rule `list` applies — an `exact`-scoped
     *  entry from an earlier period is not a head at a later one. */
    heads(input: ReadRecordHeadsInput): Promise<RecordOutcome<RecordEntryRow[]>>;
    /** Fold the live heads into the consumer's shape. */
    materialize<T>(input: MaterializeRecordInput<T>): Promise<RecordOutcome<MaterializeRecordResult<T>>>;
}
/**
 * Build a store bound to one table and one policy. `scopeId` is per call, not
 * per store, so one instance serves every tenant a worker handles — and every
 * query pins it in the WHERE clause, so a leaked id from another scope reads
 * and writes nothing.
 */
export declare function createRecordStore(options: CreateRecordStoreOptions): RecordStore;
/** Project a stored row onto the slice the pure fold reads. */
export declare function toFoldable(row: RecordEntryRow): FoldableRecordEntry;
/**
 * Pick the driver's atomic primitive. `batch` first and unconditionally: on D1
 * it is the ONLY one that works, and a D1 handle also exposes a `transaction`
 * method that does not give you a transaction.
 */
export declare function resolveAtomicStrategy(db: RecordDatabase): RecordAtomicStrategy;
