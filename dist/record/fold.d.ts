/**
 * The fold: live entries in, one consumer-shaped object out.
 *
 * Pure and driver-free — the store loads rows and hands them here, and a test
 * or an eval harness can call it with literals. Determinism is the contract:
 * the result depends only on the CONTENT of the entries, never on the order
 * they arrive in, because ordering is `seq` alone (with `id` as an unreachable
 * tie-break — `(scope, seq)` is unique in storage). Nothing here reads a clock
 * or a timestamp column, so two entries written in the same second still fold
 * in a defined order.
 *
 * The consumer supplies the grouping rules: which paths carry forward across
 * periods, how one entry applies to the accumulator, what a negative assertion
 * retracts, and any derived values computed after the last entry.
 */
import { type RecordOutcome } from './model';
/**
 * How a path's entries resolve against the period being materialized.
 *
 * - `exact` — visible only at their own period. A value that was true for one
 *   period is structurally invisible to every other one.
 * - `carry-forward` — visible at any period at or after their own, and only
 *   the newest such entry per key wins. Asserting a new value at a later
 *   period changes that period onward and can never rewrite an earlier one.
 */
export type RecordPeriodScope = 'exact' | 'carry-forward';
/** Resolves the period scope of one path. */
export type RecordPeriodScopeResolver = (path: string) => RecordPeriodScope;
/** The scope assumed for every path when a consumer supplies no resolver. */
export declare const defaultRecordPeriodScope: RecordPeriodScopeResolver;
/** The slice of a stored row the fold reads. */
export interface FoldableRecordEntry {
    id: string;
    /** Per-scope monotonic write counter — the ONLY ordering key. */
    seq: number;
    dimension: string;
    period: number;
    path: string;
    itemKey: string;
    /** Canonical JSON produced by `canonicalRecordJson` on write. */
    valueJson: string;
    /** True when the entry asserts "there are none of these" at `path`. */
    affirmedEmpty: boolean;
}
/** A resolved entry with its value already parsed, handed to the rules. */
export interface DecodedRecordEntry extends FoldableRecordEntry {
    /** `JSON.parse(valueJson)`; `null` on an `affirmedEmpty` entry. */
    value: unknown;
}
/**
 * The consumer's grouping rules. `T` is whatever shape the product folds into
 * — a typed profile object, a keyed map, a list.
 */
export interface RecordFoldRules<T> {
    /** Fresh accumulator for one fold. Must return a NEW object each call. */
    init(): T;
    /**
     * Period scope for a path. Called for every entry, including paths that only
     * ever appear as `affirmedEmpty` targets. Defaults to `'exact'` for every
     * path when omitted, which is the narrower rule: an entry never leaks into a
     * period it was not asserted for.
     */
    periodScope?: RecordPeriodScopeResolver;
    /** Apply one entry to the accumulator. Fail loud: an entry the rules cannot
     *  place must reject the whole fold, never be skipped — a silently dropped
     *  entry shows a wrong number with a straight face. */
    apply(draft: T, entry: DecodedRecordEntry): RecordOutcome<void>;
    /** Apply a negative assertion. Runs at the entry's `seq`, so later entries
     *  at the same path repopulate. Omit it to reject `affirmedEmpty` entries. */
    retract?(draft: T, entry: DecodedRecordEntry): RecordOutcome<void>;
    /** Compute derived values after the last entry. */
    finalize?(draft: T): RecordOutcome<void>;
}
/** Options for one fold. */
export interface FoldRecordEntriesOptions<T> {
    rules: RecordFoldRules<T>;
    /** The period being materialized. Defaults to
     *  {@link RECORD_PERIOD_SENTINEL} for a record with no time dimension. */
    period?: number;
}
/** What a fold produced. */
export interface RecordFoldResult<T> {
    value: T;
    /** Entries that survived period resolution and were applied. */
    entryCount: number;
}
/**
 * True when an entry at `entryPeriod` is a candidate at `requestedPeriod`
 * under `scope`. Carry-forward candidacy is necessary, not sufficient — only
 * the newest candidate per key survives {@link foldRecordEntries}.
 */
export declare function recordEntryVisibleInPeriod(scope: RecordPeriodScope, entryPeriod: number, requestedPeriod: number): boolean;
/**
 * Resolve entries against the requested period, then fold them in `seq` order.
 *
 * Callers may pass entries in any order and any mix of periods; the result is
 * a function of their content alone.
 */
export declare function foldRecordEntries<T>(entries: readonly FoldableRecordEntry[], options: FoldRecordEntriesOptions<T>): RecordOutcome<RecordFoldResult<T>>;
