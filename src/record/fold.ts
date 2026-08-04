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

import {
  recordFail,
  recordKeyString,
  recordOk,
  RECORD_PERIOD_SENTINEL,
  type RecordOutcome,
} from './model'

/**
 * How a path's entries resolve against the period being materialized.
 *
 * - `exact` — visible only at their own period. A value that was true for one
 *   period is structurally invisible to every other one.
 * - `carry-forward` — visible at any period at or after their own, and only
 *   the newest such entry per key wins. Asserting a new value at a later
 *   period changes that period onward and can never rewrite an earlier one.
 */
export type RecordPeriodScope = 'exact' | 'carry-forward'

/** Resolves the period scope of one path. */
export type RecordPeriodScopeResolver = (path: string) => RecordPeriodScope

/** The scope assumed for every path when a consumer supplies no resolver. */
export const defaultRecordPeriodScope: RecordPeriodScopeResolver = () => 'exact'

/** The slice of a stored row the fold reads. */
export interface FoldableRecordEntry {
  id: string
  /** Per-scope monotonic write counter — the ONLY ordering key. */
  seq: number
  dimension: string
  period: number
  path: string
  itemKey: string
  /** Canonical JSON produced by `canonicalRecordJson` on write. */
  valueJson: string
  /** True when the entry asserts "there are none of these" at `path`. */
  affirmedEmpty: boolean
}

/** A resolved entry with its value already parsed, handed to the rules. */
export interface DecodedRecordEntry extends FoldableRecordEntry {
  /** `JSON.parse(valueJson)`; `null` on an `affirmedEmpty` entry. */
  value: unknown
}

/**
 * The consumer's grouping rules. `T` is whatever shape the product folds into
 * — a typed profile object, a keyed map, a list.
 */
export interface RecordFoldRules<T> {
  /** Fresh accumulator for one fold. Must return a NEW object each call. */
  init(): T
  /**
   * Period scope for a path. Called for every entry, including paths that only
   * ever appear as `affirmedEmpty` targets. Defaults to `'exact'` for every
   * path when omitted, which is the narrower rule: an entry never leaks into a
   * period it was not asserted for.
   */
  periodScope?: RecordPeriodScopeResolver
  /** Apply one entry to the accumulator. Fail loud: an entry the rules cannot
   *  place must reject the whole fold, never be skipped — a silently dropped
   *  entry shows a wrong number with a straight face. */
  apply(draft: T, entry: DecodedRecordEntry): RecordOutcome<void>
  /** Apply a negative assertion. Runs at the entry's `seq`, so later entries
   *  at the same path repopulate. Omit it to reject `affirmedEmpty` entries. */
  retract?(draft: T, entry: DecodedRecordEntry): RecordOutcome<void>
  /** Compute derived values after the last entry. */
  finalize?(draft: T): RecordOutcome<void>
}

/** Options for one fold. */
export interface FoldRecordEntriesOptions<T> {
  rules: RecordFoldRules<T>
  /** The period being materialized. Defaults to
   *  {@link RECORD_PERIOD_SENTINEL} for a record with no time dimension. */
  period?: number
}

/** What a fold produced. */
export interface RecordFoldResult<T> {
  value: T
  /** Entries that survived period resolution and were applied. */
  entryCount: number
}

/**
 * True when an entry at `entryPeriod` is a candidate at `requestedPeriod`
 * under `scope`. Carry-forward candidacy is necessary, not sufficient — only
 * the newest candidate per key survives {@link foldRecordEntries}.
 */
export function recordEntryVisibleInPeriod(
  scope: RecordPeriodScope,
  entryPeriod: number,
  requestedPeriod: number,
): boolean {
  return scope === 'carry-forward' ? entryPeriod <= requestedPeriod : entryPeriod === requestedPeriod
}

/**
 * Resolve entries against the requested period, then fold them in `seq` order.
 *
 * Callers may pass entries in any order and any mix of periods; the result is
 * a function of their content alone.
 */
export function foldRecordEntries<T>(
  entries: readonly FoldableRecordEntry[],
  options: FoldRecordEntriesOptions<T>,
): RecordOutcome<RecordFoldResult<T>> {
  const { rules } = options
  const periodScope = rules.periodScope ?? defaultRecordPeriodScope
  const period = options.period ?? RECORD_PERIOD_SENTINEL
  if (!Number.isInteger(period)) {
    return recordFail('invalid-input', `foldRecordEntries: period must be an integer, got ${String(period)}`)
  }

  // Newest candidate period per carry-forward key; `exact` keys need no head.
  const carryHeads = new Map<string, number>()
  for (const entry of entries) {
    const scope = periodScope(entry.path)
    if (!recordEntryVisibleInPeriod(scope, entry.period, period)) continue
    if (scope !== 'carry-forward') continue
    const key = carryKey(entry)
    const best = carryHeads.get(key)
    if (best === undefined || entry.period > best) carryHeads.set(key, entry.period)
  }

  const resolved = entries
    .filter((entry) => {
      const scope = periodScope(entry.path)
      if (!recordEntryVisibleInPeriod(scope, entry.period, period)) return false
      if (scope !== 'carry-forward') return true
      return carryHeads.get(carryKey(entry)) === entry.period
    })
    // `(scope, seq)` is unique in storage, so the `id` tie-break is unreachable
    // for stored rows; it keeps a hand-built entry list deterministic too.
    .sort((a, b) => (a.seq - b.seq) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const draft = rules.init()
  for (const entry of resolved) {
    let value: unknown = null
    if (!entry.affirmedEmpty) {
      try {
        value = JSON.parse(entry.valueJson)
      } catch {
        return recordFail('fold-failed', `foldRecordEntries: entry '${entry.id}' has unparseable valueJson`)
      }
    }
    const decoded: DecodedRecordEntry = { ...entry, value }

    if (entry.affirmedEmpty) {
      if (!rules.retract) {
        return recordFail(
          'fold-failed',
          `foldRecordEntries: entry '${entry.id}' ('${entry.path}') is affirmedEmpty but the rules define no retract`,
        )
      }
      const retracted = rules.retract(draft, decoded)
      if (!retracted.succeeded) {
        return recordFail('fold-failed', `foldRecordEntries: entry '${entry.id}' ('${entry.path}') — ${retracted.error}`)
      }
      continue
    }

    const applied = rules.apply(draft, decoded)
    if (!applied.succeeded) {
      return recordFail('fold-failed', `foldRecordEntries: entry '${entry.id}' ('${entry.path}') — ${applied.error}`)
    }
  }

  if (rules.finalize) {
    const finalized = rules.finalize(draft)
    if (!finalized.succeeded) {
      return recordFail('fold-failed', `foldRecordEntries: finalize — ${finalized.error}`)
    }
  }

  return recordOk({ value: draft, entryCount: resolved.length })
}

/** Carry-forward candidacy is per (dimension, path, itemKey) — the entry key
 *  WITHOUT its period, since the period is what is being resolved. */
function carryKey(entry: FoldableRecordEntry): string {
  return recordKeyString({
    dimension: entry.dimension,
    path: entry.path,
    itemKey: entry.itemKey,
    period: RECORD_PERIOD_SENTINEL,
  })
}
