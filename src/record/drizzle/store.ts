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

import { and, asc, eq, getTableColumns, getTableName, isNull, lte, sql } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import {
  canonicalRecordJson,
  detectRecordConflict,
  recordFail,
  recordOk,
  resolveWriteReviewState,
  validateRecordValue,
  RECORD_KEY_SENTINEL,
  RECORD_PERIOD_SENTINEL,
  type RecordOutcome,
  type RecordReviewState,
  type RecordSourceLocator,
  type RecordWritePolicy,
} from '../model'
import {
  defaultRecordPeriodScope,
  foldRecordEntries,
  recordEntryVisibleInPeriod,
  type FoldableRecordEntry,
  type RecordFoldRules,
  type RecordPeriodScopeResolver,
} from '../fold'
import { recordUlid } from '../ulid'
import { RECORD_STORE_COLUMNS } from './schema'
import type { RecordEntryRow, RecordTable } from './schema'

/**
 * Any SQLite drizzle database. The run-result and schema generics are erased
 * to `unknown` so better-sqlite3, D1 and libsql handles all fit; `batch` is
 * declared optional because only D1 and libsql expose it.
 */
export type RecordDatabase = BaseSQLiteDatabase<'sync' | 'async', unknown, Record<string, unknown>> & {
  batch?(statements: [unknown, ...unknown[]]): Promise<unknown[]>
}

/** How this store executes a two-statement atomic unit on the caller's driver. */
export type RecordAtomicStrategy = 'batch' | 'begin-immediate'

/** Input to {@link RecordStore.write}. */
export interface WriteRecordEntryInput {
  scopeId: string
  /** Must be a key of the policy's schema map, or — when `affirmedEmpty` — one
   *  of its affirmable paths. */
  path: string
  /** Defaults to {@link RECORD_PERIOD_SENTINEL}. */
  period?: number
  /** Defaults to {@link RECORD_KEY_SENTINEL}; canonicalized by the policy. */
  dimension?: string
  /** Defaults to {@link RECORD_KEY_SENTINEL}; canonicalized by the policy. */
  itemKey?: string
  /** The value. Must be absent when `affirmedEmpty` is true. */
  value?: unknown
  /** Assert "there are none of these" at `path`. */
  affirmedEmpty?: boolean
  /** Stamped by the SERVER call site — never read from model arguments. */
  sourceKind: string
  sourceRef?: string | null
  sourceLocator?: RecordSourceLocator | null
  sourceQuote?: string | null
  confidence?: number | null
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
  extras?: Readonly<Record<string, unknown>>
}

/** What a write produced. */
export interface WriteRecordEntryResult {
  entry: RecordEntryRow
  /** True when the write landed `proposed` with the conflict flag set. */
  conflict: boolean
  /** Id of the live head this write superseded, when it superseded one. */
  supersededEntryId: string | null
}

/** Input to {@link RecordStore.review}. */
export interface ReviewRecordEntryInput {
  scopeId: string
  entryId: string
  action: 'accept' | 'reject'
  /** Recorded on the row; the store never derives it. */
  reviewedBy?: string | null
}

/** Filters for {@link RecordStore.list}. */
export interface ListRecordEntriesInput {
  scopeId: string
  /** Narrow to one review state. Does not resurrect superseded entries. */
  reviewState?: RecordReviewState
  /** Resolve visibility against this period. Omit to return every period. */
  period?: number
  /** Include entries a later accepted entry replaced. Default false. */
  includeSuperseded?: boolean
  /** Include rejected entries. Default false, unless `reviewState` asks for
   *  them explicitly. */
  includeRejected?: boolean
}

/** Input to {@link RecordStore.heads}. */
export interface ReadRecordHeadsInput {
  scopeId: string
  /**
   * The period to resolve against. Defaults to {@link RECORD_PERIOD_SENTINEL},
   * which is the right default ONLY for a consumer with no time dimension —
   * every entry it writes sits at `0`. A consumer that uses periods passes one
   * on every read; omitting it there resolves against period `0` and returns
   * nothing, rather than quietly mixing periods together.
   */
  period?: number
}

/** Input to {@link RecordStore.materialize}. */
export interface MaterializeRecordInput<T> {
  scopeId: string
  /** The consumer's grouping rules. */
  rules: RecordFoldRules<T>
  /** Same default and same caveat as {@link ReadRecordHeadsInput.period}. */
  period?: number
}

/** What a materialization produced. */
export interface MaterializeRecordResult<T> {
  value: T
  /** Live accepted entries folded in. */
  entryCount: number
  /** Proposed entries visible at this period and still awaiting review. */
  pendingProposed: number
  /** Subset of those flagged by the conflict rule. */
  conflicts: number
}

/** Options for {@link createRecordStore}. */
export interface CreateRecordStoreOptions {
  db: RecordDatabase
  /** The table from `createRecordTable`. */
  table: RecordTable
  /** Everything domain-specific about a write. */
  policy: RecordWritePolicy
  /**
   * Period scope per path, used by `list`'s period filter and as the default
   * for `materialize` when the fold rules omit their own. Defaults to `'exact'`
   * for every path.
   */
  periodScope?: RecordPeriodScopeResolver
  /** Id minter. Defaults to a ULID. */
  newId?: () => string
  /** Clock for `reviewedAt`. Defaults to `Date.now`. */
  now?: () => number
  /** Attempts before a contended head write gives up. Defaults to 3. */
  maxWriteAttempts?: number
}

/** The store surface. */
export interface RecordStore {
  /** Which atomic primitive this store resolved for the injected driver. */
  readonly atomicStrategy: RecordAtomicStrategy
  /** Append one entry, superseding the live head when the write is accepted. */
  write(input: WriteRecordEntryInput): Promise<RecordOutcome<WriteRecordEntryResult>>
  /** Accept or reject a proposed entry. */
  review(input: ReviewRecordEntryInput): Promise<RecordOutcome<RecordEntryRow>>
  /** Entries visible under the filters, ordered by `seq`. */
  list(input: ListRecordEntriesInput): Promise<RecordOutcome<RecordEntryRow[]>>
  /** Live accepted heads visible at `period`, ordered by `seq`. Visibility is
   *  the store's period scope, the same rule `list` applies — an `exact`-scoped
   *  entry from an earlier period is not a head at a later one. */
  heads(input: ReadRecordHeadsInput): Promise<RecordOutcome<RecordEntryRow[]>>
  /** Fold the live heads into the consumer's shape. */
  materialize<T>(input: MaterializeRecordInput<T>): Promise<RecordOutcome<MaterializeRecordResult<T>>>
}

const DEFAULT_WRITE_ATTEMPTS = 3

/**
 * Build a store bound to one table and one policy. `scopeId` is per call, not
 * per store, so one instance serves every tenant a worker handles — and every
 * query pins it in the WHERE clause, so a leaked id from another scope reads
 * and writes nothing.
 */
export function createRecordStore(options: CreateRecordStoreOptions): RecordStore {
  const { db, table, policy } = options
  const tableName = getTableName(table)
  const newId = options.newId ?? (() => recordUlid())
  const now = options.now ?? (() => Date.now())
  const attempts = options.maxWriteAttempts ?? DEFAULT_WRITE_ATTEMPTS
  const storePeriodScope = options.periodScope ?? defaultRecordPeriodScope
  const strategy = resolveAtomicStrategy(db)
  const affirmable = new Set(policy.affirmablePaths ?? [])
  const requireRef = new Set(policy.requireSourceRef ?? [])
  const requireQuote = new Set(policy.requireSourceQuote ?? [])
  // The PRODUCT's column keys — every column on the table minus the ones this
  // store owns. An `extras` key outside this set is a refusal: with no column
  // it would be a value drizzle drops on the floor, and with a store-owned
  // column it would shadow the row's own identity.
  const extraColumnNames = new Set(
    Object.keys(getTableColumns(table)).filter((name) => !RECORD_STORE_COLUMNS.has(name)),
  )

  function liveHeadWhere(scopeId: string, key: ValidatedKey) {
    return and(
      eq(table.scopeId, scopeId),
      eq(table.dimension, key.dimension),
      eq(table.path, key.path),
      eq(table.itemKey, key.itemKey),
      eq(table.period, key.period),
      eq(table.reviewState, 'accepted'),
      isNull(table.supersededById),
    )
  }

  async function loadLiveHead(scopeId: string, key: ValidatedKey): Promise<RecordEntryRow | undefined> {
    const rows = await db.select().from(table).where(liveHeadWhere(scopeId, key)).limit(1)
    return rows[0]
  }

  /**
   * The guarded UPDATE that marks an outgoing head superseded.
   *
   * `requireProposedId` folds the DEPENDENT statement's own precondition into
   * this one. On a `batch` driver the pair commits unconditionally and nothing
   * can inspect the first statement before the second runs, so the two must be
   * unable to disagree. Without it, a proposal a concurrent reviewer rejected
   * still gets its id stamped onto the head as `superseded_by_id` while the
   * accept UPDATE matches nothing — the record left with NO live head while the
   * caller is told the review did not happen.
   */
  function markHeadStatement(headId: string, replacementId: string, requireProposedId?: string) {
    const guards = [eq(table.id, headId), eq(table.reviewState, 'accepted'), isNull(table.supersededById)]
    if (requireProposedId !== undefined) {
      guards.push(
        sql`EXISTS (SELECT 1 FROM ${sql.identifier(tableName)} WHERE id = ${requireProposedId} AND review_state = 'proposed')`,
      )
    }
    return db
      .update(table)
      .set({ supersededById: replacementId })
      .where(and(...guards))
      .returning({ id: table.id })
  }

  /** Re-read one entry by id inside its scope. Used to name WHICH precondition
   *  a guarded pair failed on, which decides retry versus refusal. */
  async function loadEntry(scopeId: string, entryId: string): Promise<RecordEntryRow | undefined> {
    const rows = await db
      .select()
      .from(table)
      .where(and(eq(table.id, entryId), eq(table.scopeId, scopeId)))
      .limit(1)
    return rows[0]
  }

  async function write(input: WriteRecordEntryInput): Promise<RecordOutcome<WriteRecordEntryResult>> {
    const validated = validateWrite(input)
    if (!validated.succeeded) return validated
    const draft = validated.value

    let lastError = ''
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const head = await loadLiveHead(input.scopeId, draft.key)
        const conflict = detectRecordConflict(policy, head, draft)
        const reviewState: RecordReviewState = conflict ? 'proposed' : draft.reviewState

        const id = newId()
        const values = insertValues(input, draft, id, reviewState, conflict)

        if (reviewState === 'accepted' && head !== undefined) {
          const paired = await runGuardedPair(
            db,
            strategy,
            markHeadStatement(head.id, id),
            db.insert(table).values(values).returning(),
          )
          if (!paired.guardMatched) {
            if (paired.rolledBack) {
              lastError = `write: lost the head race on '${draft.key.path}' (head ${head.id} changed underneath)`
              continue
            }
            return recordFail(
              'supersede-race',
              `write: head ${head.id} on '${draft.key.path}' was not markable but the write committed — the live-head index is not enforcing`,
            )
          }
          // An INSERT has no precondition to miss, so an empty main here is a
          // driver defect rather than a lost race — and `runGuardedPair` has
          // already rolled the pair back where the driver allows it, so the
          // head is not left marked against a row that was never written.
          const row = firstRow(paired.mainRows)
          if (!row) return recordFail('storage-failed', 'write: insert returned no row')
          return recordOk({ entry: row, conflict: false, supersededEntryId: head.id })
        }

        const inserted = await db.insert(table).values(values).returning()
        const row = firstRow(inserted)
        if (!row) return recordFail('storage-failed', 'write: insert returned no row')
        return recordOk({ entry: row, conflict, supersededEntryId: null })
      } catch (error) {
        if (isUniqueViolation(error)) {
          lastError = `write: concurrent head write on '${draft.key.path}' — ${errorMessage(error)}`
          continue
        }
        return recordFail('storage-failed', `write: ${errorMessage(error)}`)
      }
    }
    return recordFail('supersede-race', `${lastError} (gave up after ${attempts} attempts)`)
  }

  async function review(input: ReviewRecordEntryInput): Promise<RecordOutcome<RecordEntryRow>> {
    let existing: RecordEntryRow | undefined
    try {
      const rows = await db
        .select()
        .from(table)
        .where(and(eq(table.id, input.entryId), eq(table.scopeId, input.scopeId)))
        .limit(1)
      existing = rows[0]
    } catch (error) {
      return recordFail('storage-failed', `review: ${errorMessage(error)}`)
    }
    if (!existing) {
      return recordFail('not-found', `review: entry '${input.entryId}' not found in scope '${input.scopeId}'`)
    }
    if (existing.reviewState !== 'proposed') {
      return recordFail(
        'not-reviewable',
        `review: entry '${input.entryId}' is '${existing.reviewState}' — only proposed entries are reviewable`,
      )
    }

    const reviewedAt = now()
    const reviewedBy = input.reviewedBy ?? null

    if (input.action === 'reject') {
      try {
        const updated = await db
          .update(table)
          .set({ reviewState: 'rejected', reviewedAt, reviewedBy })
          .where(and(eq(table.id, existing.id), eq(table.reviewState, 'proposed')))
          .returning()
        const row = firstRow(updated)
        if (!row) {
          return recordFail('not-reviewable', `review: entry '${input.entryId}' was reviewed concurrently`)
        }
        return recordOk(row)
      } catch (error) {
        return recordFail('storage-failed', `review: ${errorMessage(error)}`)
      }
    }

    const key: ValidatedKey = {
      dimension: existing.dimension,
      path: existing.path,
      itemKey: existing.itemKey,
      period: existing.period,
    }

    let lastError = ''
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const head = await loadLiveHead(input.scopeId, key)
        const acceptStatement = db
          .update(table)
          .set({ reviewState: 'accepted', conflict: false, reviewedAt, reviewedBy })
          .where(and(eq(table.id, existing.id), eq(table.reviewState, 'proposed')))
          .returning()

        if (head !== undefined) {
          const paired = await runGuardedPair(
            db,
            strategy,
            markHeadStatement(head.id, existing.id, existing.id),
            acceptStatement,
          )
          if (!paired.guardMatched && paired.mainMatched) {
            return recordFail(
              'supersede-race',
              `review: head ${head.id} was not markable but the accept committed — the live-head index is not enforcing`,
            )
          }
          if (paired.guardMatched && !paired.mainMatched && !paired.rolledBack) {
            // The head is stamped superseded by an entry the accept did not
            // install. Nothing can be retried past this: the record's live
            // value is gone and only an operator can put it back.
            return recordFail(
              'supersede-race',
              `review: head ${head.id} was marked superseded by '${input.entryId}' but the accept matched no row — the batch is not atomic`,
            )
          }
          if (!paired.guardMatched || !paired.mainMatched) {
            // Nothing landed. Which precondition failed decides the answer: a
            // proposal a concurrent reviewer already resolved is a refusal, a
            // head that moved underneath is a retry.
            const current = await loadEntry(input.scopeId, existing.id)
            if (current === undefined || current.reviewState !== 'proposed') {
              return recordFail('not-reviewable', `review: entry '${input.entryId}' was reviewed concurrently`)
            }
            lastError = `review: lost the head race accepting '${input.entryId}' (head ${head.id} changed underneath)`
            continue
          }
          const row = firstRow(paired.mainRows)
          if (!row) return recordFail('not-reviewable', `review: entry '${input.entryId}' was reviewed concurrently`)
          return recordOk(row)
        }

        const accepted = await acceptStatement
        const row = firstRow(accepted)
        if (!row) return recordFail('not-reviewable', `review: entry '${input.entryId}' was reviewed concurrently`)
        return recordOk(row)
      } catch (error) {
        if (isUniqueViolation(error)) {
          lastError = `review: concurrent head write accepting '${input.entryId}' — ${errorMessage(error)}`
          continue
        }
        return recordFail('storage-failed', `review: ${errorMessage(error)}`)
      }
    }
    return recordFail('supersede-race', `${lastError} (gave up after ${attempts} attempts)`)
  }

  async function list(input: ListRecordEntriesInput): Promise<RecordOutcome<RecordEntryRow[]>> {
    if (input.period !== undefined && !Number.isInteger(input.period)) {
      return recordFail('invalid-input', `list: period must be an integer, got ${String(input.period)}`)
    }
    try {
      const where = input.period === undefined
        ? eq(table.scopeId, input.scopeId)
        : and(eq(table.scopeId, input.scopeId), lte(table.period, input.period))
      const rows = await db.select().from(table).where(where).orderBy(asc(table.seq))

      const visible = rows.filter((row) => {
        if (input.period !== undefined
          && !recordEntryVisibleInPeriod(storePeriodScope(row.path), row.period, input.period)) return false
        if (input.reviewState !== undefined) {
          if (row.reviewState !== input.reviewState) return false
        } else if (!input.includeRejected && row.reviewState === 'rejected') {
          return false
        }
        if (!input.includeSuperseded && row.supersededById !== null) return false
        return true
      })
      return recordOk(visible)
    } catch (error) {
      return recordFail('storage-failed', `list: ${errorMessage(error)}`)
    }
  }

  /**
   * The raw live-accepted query. `period <= N` is the only predicate SQL can
   * express — whether an entry written at an earlier period is still TRUE at
   * `N` is the period scope's call, and that resolver is per path, so it runs
   * in JS over these rows.
   */
  async function loadHeads(scopeId: string, period: number): Promise<RecordEntryRow[]> {
    return db
      .select()
      .from(table)
      .where(and(
        eq(table.scopeId, scopeId),
        eq(table.reviewState, 'accepted'),
        isNull(table.supersededById),
        lte(table.period, period),
      ))
      .orderBy(asc(table.seq))
  }

  async function heads(input: ReadRecordHeadsInput): Promise<RecordOutcome<RecordEntryRow[]>> {
    const period = input.period ?? RECORD_PERIOD_SENTINEL
    if (!Number.isInteger(period)) {
      return recordFail('invalid-input', `heads: period must be an integer, got ${String(period)}`)
    }
    try {
      const rows = await loadHeads(input.scopeId, period)
      // The same visibility rule `list` applies. Without it an `exact`-scoped
      // entry written at an earlier period reads as live at a later one, and
      // the two published reads answer the same question differently.
      return recordOk(rows.filter((row) => recordEntryVisibleInPeriod(storePeriodScope(row.path), row.period, period)))
    } catch (error) {
      return recordFail('storage-failed', `heads: ${errorMessage(error)}`)
    }
  }

  async function materialize<T>(input: MaterializeRecordInput<T>): Promise<RecordOutcome<MaterializeRecordResult<T>>> {
    const period = input.period ?? RECORD_PERIOD_SENTINEL
    if (!Number.isInteger(period)) {
      return recordFail('invalid-input', `materialize: period must be an integer, got ${String(period)}`)
    }
    // Deliberately the RAW rows, not `heads()`: the fold applies the caller's
    // own `rules.periodScope` when it supplies one, so pre-filtering here with
    // the store's resolver would drop entries those rules would have kept.
    let loaded: RecordEntryRow[]
    try {
      loaded = await loadHeads(input.scopeId, period)
    } catch (error) {
      return recordFail('storage-failed', `materialize: ${errorMessage(error)}`)
    }

    const rules: RecordFoldRules<T> = input.rules.periodScope
      ? input.rules
      : { ...input.rules, periodScope: storePeriodScope }
    const folded = foldRecordEntries(loaded.map(toFoldable), { rules, period })
    if (!folded.succeeded) return folded

    const periodScope = rules.periodScope ?? storePeriodScope
    try {
      const proposed = await db
        .select({ path: table.path, period: table.period, conflict: table.conflict })
        .from(table)
        .where(and(
          eq(table.scopeId, input.scopeId),
          eq(table.reviewState, 'proposed'),
          lte(table.period, period),
        ))
      const visible = proposed.filter((row) => recordEntryVisibleInPeriod(periodScope(row.path), row.period, period))
      return recordOk({
        value: folded.value.value,
        entryCount: folded.value.entryCount,
        pendingProposed: visible.length,
        conflicts: visible.filter((row) => row.conflict).length,
      })
    } catch (error) {
      return recordFail('storage-failed', `materialize: ${errorMessage(error)}`)
    }
  }

  interface ValidatedKey {
    dimension: string
    path: string
    itemKey: string
    period: number
  }

  interface ValidatedWrite {
    key: ValidatedKey
    valueJson: string
    affirmedEmpty: boolean
    reviewState: RecordReviewState
    sourceKind: string
  }

  function validateWrite(input: WriteRecordEntryInput): RecordOutcome<ValidatedWrite> {
    const period = input.period ?? RECORD_PERIOD_SENTINEL
    const minPeriod = policy.minPeriod ?? RECORD_PERIOD_SENTINEL
    const maxPeriod = policy.maxPeriod ?? Number.MAX_SAFE_INTEGER
    if (!Number.isInteger(period) || period < minPeriod || period > maxPeriod) {
      return recordFail(
        'invalid-input',
        `write: period must be an integer in [${minPeriod}, ${maxPeriod}], got ${String(period)}`,
      )
    }
    if (requireRef.has(input.sourceKind) && !input.sourceRef) {
      return recordFail('invalid-input', `write: source kind '${input.sourceKind}' requires a sourceRef ('${input.path}')`)
    }
    if (requireQuote.has(input.sourceKind) && !input.sourceQuote) {
      return recordFail('invalid-input', `write: source kind '${input.sourceKind}' requires a sourceQuote ('${input.path}')`)
    }
    const extras = input.extras ?? {}
    for (const key of Object.keys(extras)) {
      if (!extraColumnNames.has(key)) {
        return recordFail(
          'invalid-input',
          `write: extras key '${key}' has no column on '${tableName}' — declare it in createRecordTable's extraColumns`,
        )
      }
    }
    for (const key of policy.requireExtras?.[input.sourceKind] ?? []) {
      const held = extras[key]
      if (held === undefined || held === null || held === '') {
        return recordFail(
          'invalid-input',
          `write: source kind '${input.sourceKind}' requires extras.${key} ('${input.path}')`,
        )
      }
    }
    if (input.confidence !== undefined && input.confidence !== null
      && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
      return recordFail('invalid-input', `write: confidence must be in [0, 1], got ${String(input.confidence)}`)
    }

    const state = resolveWriteReviewState(policy, input.sourceKind)
    if (!state.succeeded) return state

    const dimension = canonicalize(policy.canonicalizeDimension, input.path, input.dimension ?? RECORD_KEY_SENTINEL, 'dimension')
    if (!dimension.succeeded) return dimension

    if (input.affirmedEmpty === true) {
      if (input.value !== undefined) {
        return recordFail('invalid-input', `write: an affirmedEmpty entry must not carry a value ('${input.path}')`)
      }
      if (!affirmable.has(input.path)) {
        return recordFail(
          'unknown-path',
          `write: '${input.path}' is not an affirmable path — affirmedEmpty targets a path declared in policy.affirmablePaths`,
        )
      }
      if ((input.itemKey ?? RECORD_KEY_SENTINEL) !== RECORD_KEY_SENTINEL) {
        return recordFail(
          'invalid-input',
          `write: an affirmedEmpty entry uses the itemKey sentinel — it asserts that a whole path is empty ('${input.path}')`,
        )
      }
      return recordOk({
        key: { dimension: dimension.value, path: input.path, itemKey: RECORD_KEY_SENTINEL, period },
        valueJson: 'null',
        affirmedEmpty: true,
        reviewState: state.value,
        sourceKind: input.sourceKind,
      })
    }

    const validator = policy.schemas[input.path]
    if (validator === undefined) {
      return recordFail('unknown-path', `write: unknown path '${input.path}' — not a key of the policy's schema map`)
    }
    if (input.value === undefined) {
      return recordFail('invalid-input', `write: a value is required unless affirmedEmpty is true ('${input.path}')`)
    }
    const parsed = validateRecordValue(validator, input.value)
    if (!parsed.succeeded) {
      return recordFail('invalid-value', `write: value for '${input.path}' failed validation — ${parsed.error}`)
    }

    const itemKey = canonicalize(policy.canonicalizeItemKey, input.path, input.itemKey ?? RECORD_KEY_SENTINEL, 'itemKey')
    if (!itemKey.succeeded) return itemKey

    return recordOk({
      key: { dimension: dimension.value, path: input.path, itemKey: itemKey.value, period },
      valueJson: canonicalRecordJson(parsed.value),
      affirmedEmpty: false,
      reviewState: state.value,
      sourceKind: input.sourceKind,
    })
  }

  function insertValues(
    input: WriteRecordEntryInput,
    draft: ValidatedWrite,
    id: string,
    reviewState: RecordReviewState,
    conflict: boolean,
  ) {
    return {
      // First, so a product column can never shadow a store-owned one even if
      // the guards above were bypassed.
      ...(input.extras ?? {}),
      id,
      scopeId: input.scopeId,
      // Assigned inside the statement: SQLite executes one statement
      // atomically, so MAX + 1 cannot race, and `(scope_id, seq)` unique
      // backstops it.
      seq: sql<number>`(SELECT COALESCE(MAX(seq), 0) + 1 FROM ${sql.identifier(tableName)} WHERE scope_id = ${input.scopeId})`,
      dimension: draft.key.dimension,
      period: draft.key.period,
      path: draft.key.path,
      itemKey: draft.key.itemKey,
      valueJson: draft.valueJson,
      affirmedEmpty: draft.affirmedEmpty,
      reviewState,
      conflict,
      supersededById: null,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef ?? null,
      sourceLocator: input.sourceLocator ?? null,
      sourceQuote: input.sourceQuote ?? null,
      confidence: input.confidence ?? null,
      // A write that lands accepted by policy was not REVIEWED — nobody looked
      // at it. `createdAt` records when it landed; these two stay null until an
      // actual accept/reject.
      reviewedAt: null,
      reviewedBy: null,
    }
  }

  return { atomicStrategy: strategy, write, review, list, heads, materialize }
}

/** Project a stored row onto the slice the pure fold reads. */
export function toFoldable(row: RecordEntryRow): FoldableRecordEntry {
  return {
    id: row.id,
    seq: row.seq,
    dimension: row.dimension,
    period: row.period,
    path: row.path,
    itemKey: row.itemKey,
    valueJson: row.valueJson,
    affirmedEmpty: row.affirmedEmpty,
  }
}

function canonicalize(
  canonicalizer: ((path: string, raw: string) => RecordOutcome<string>) | undefined,
  path: string,
  raw: string,
  column: string,
): RecordOutcome<string> {
  if (!canonicalizer) return recordOk(raw)
  const result = canonicalizer(path, raw)
  if (!result.succeeded) return recordFail('invalid-input', `write: '${path}' ${column} — ${result.error}`)
  return result
}

function firstRow(rows: unknown): RecordEntryRow | undefined {
  return Array.isArray(rows) ? (rows[0] as RecordEntryRow | undefined) : undefined
}

/**
 * Pick the driver's atomic primitive. `batch` first and unconditionally: on D1
 * it is the ONLY one that works, and a D1 handle also exposes a `transaction`
 * method that does not give you a transaction.
 */
export function resolveAtomicStrategy(db: RecordDatabase): RecordAtomicStrategy {
  if (typeof db.batch === 'function') return 'batch'
  if (typeof db.run === 'function') return 'begin-immediate'
  throw new Error(
    'createRecordStore: the injected driver exposes neither batch() nor run() — an atomic supersede is impossible on it',
  )
}

interface GuardedPairResult {
  /** True when the guarded statement matched exactly one row. */
  guardMatched: boolean
  /** True when the dependent statement matched at least one row. */
  mainMatched: boolean
  /** True when a failed precondition left NOTHING written. */
  rolledBack: boolean
  /** Rows the second statement returned. */
  mainRows: unknown[]
}

/**
 * Run a guarded statement and its dependent statement as one atomic unit.
 *
 * BOTH statements' row counts are reported, and both matter. With only the
 * guard's checked, the destructive half of a supersede can commit alone — the
 * outgoing head stamped `superseded_by_id` while the dependent accept matches
 * zero rows, leaving the record with no live head at all.
 *
 * `batch` (D1, libsql) commits both or neither and cannot inspect the first
 * statement before the second runs — the guard has to carry the dependent
 * statement's precondition itself (see `markHeadStatement`), and the row counts
 * read afterwards say which precondition failed. `begin-immediate`
 * (better-sqlite3 and any driver without `batch`) can do better: it inspects
 * each statement as it runs and rolls back on either mismatch, so the caller
 * retries from a fresh read with nothing written.
 */
async function runGuardedPair(
  db: RecordDatabase,
  strategy: RecordAtomicStrategy,
  guard: unknown,
  main: unknown,
): Promise<GuardedPairResult> {
  if (strategy === 'batch') {
    const batch = db.batch
    if (typeof batch !== 'function') {
      throw new Error('runGuardedPair: batch strategy resolved but the driver has no batch()')
    }
    const results = await batch.call(db, [guard, main] as [unknown, ...unknown[]])
    const guardRows = results[0]
    const mainRows = Array.isArray(results[1]) ? results[1] : []
    return {
      guardMatched: Array.isArray(guardRows) && guardRows.length === 1,
      mainMatched: mainRows.length > 0,
      rolledBack: false,
      mainRows,
    }
  }

  await db.run(sql`begin immediate`)
  try {
    const guardRows = await (guard as Promise<unknown>)
    if (!Array.isArray(guardRows) || guardRows.length !== 1) {
      await db.run(sql`rollback`)
      return { guardMatched: false, mainMatched: false, rolledBack: true, mainRows: [] }
    }
    const mainRows = await (main as Promise<unknown>)
    if (!Array.isArray(mainRows) || mainRows.length === 0) {
      await db.run(sql`rollback`)
      return { guardMatched: true, mainMatched: false, rolledBack: true, mainRows: [] }
    }
    await db.run(sql`commit`)
    return { guardMatched: true, mainMatched: true, rolledBack: false, mainRows }
  } catch (error) {
    await rollbackQuietly(db)
    throw error
  }
}

/** Roll back without masking the error that caused it. */
async function rollbackQuietly(db: RecordDatabase): Promise<void> {
  try {
    await db.run(sql`rollback`)
  } catch {
    // The transaction is already gone; the original error is the one to report.
  }
}

/** Flatten a driver error's cause chain into one readable message. */
function errorMessage(error: unknown): string {
  const parts: string[] = []
  let cursor: unknown = error
  for (let depth = 0; depth < 5 && cursor instanceof Error; depth++) {
    parts.push(cursor.message)
    cursor = cursor.cause
  }
  return parts.length > 0 ? parts.join(' — ') : String(error)
}

/** Drizzle wraps driver errors ("Failed query: …") and keeps the SQLite error
 *  in the cause chain, so the whole chain is inspected. */
function isUniqueViolation(error: unknown): boolean {
  let cursor: unknown = error
  for (let depth = 0; depth < 5 && cursor instanceof Error; depth++) {
    if (cursor.message.includes('UNIQUE constraint failed')) return true
    cursor = cursor.cause
  }
  return false
}
