/**
 * The pure core of the record module: the entry vocabulary, the key sentinels,
 * canonical value encoding, consumer-supplied validation, and the conflict
 * rule. Zero imports — a product can fold and validate entries in a browser,
 * an eval process, or a worker without touching a database driver.
 *
 * A record entry is one source-cited assertion: "at `path` (optionally for
 * `itemKey`, in `dimension`, for `period`), the value is X, and here is where
 * that came from". Entries are append-only. An entry becomes the live head of
 * its key by being `accepted` with no `supersededById`; the previous head is
 * marked superseded in the same atomic write, so the history stays readable.
 *
 * Every domain word — what a path means, what an item key identifies, what a
 * dimension or period is, which source kinds exist — is a parameter supplied
 * by the consumer. This module knows none of them.
 */

/** Error classes a caller maps to a status code or a retry decision. */
export type RecordErrorCode =
  /** The path is not a key of the consumer's schema map. */
  | 'unknown-path'
  /** The value failed the consumer's schema for its path. */
  | 'invalid-value'
  /** The input is structurally wrong (bad period, missing source ref, …). */
  | 'invalid-input'
  /** The source kind is not a key of the consumer's review policy. */
  | 'unknown-source-kind'
  /** No such entry in this scope. */
  | 'not-found'
  /** The entry is not in a state this operation accepts. */
  | 'not-reviewable'
  /** A competing writer took the live head; the caller may re-read and retry. */
  | 'supersede-race'
  /** The fold rejected an entry — the record cannot be materialized. */
  | 'fold-failed'
  /** The driver raised. */
  | 'storage-failed'
  /** The driver exposes no atomic multi-statement primitive. */
  | 'unsupported-driver'

/**
 * Typed outcome for every record operation. Callers MUST inspect `succeeded`
 * before reading `value`; nothing here throws past its own boundary except a
 * programming error in the consumer's own callbacks.
 */
export type RecordOutcome<T> =
  | { succeeded: true; value: T }
  | { succeeded: false; error: string; code: RecordErrorCode }

/** Build a success outcome. */
export function recordOk<T>(value: T): RecordOutcome<T> {
  return { succeeded: true, value }
}

/** Build a failure outcome carrying its error class. */
export function recordFail(code: RecordErrorCode, error: string): RecordOutcome<never> {
  return { succeeded: false, error, code }
}

/**
 * Sentinel for an unused key column.
 *
 * SQLite treats NULLs as distinct in a unique index, so a nullable key column
 * would let two live heads coexist on the same logical key. Every key column
 * is therefore NOT NULL with a sentinel, and this is the sentinel for the two
 * text ones (`dimension`, `itemKey`).
 */
export const RECORD_KEY_SENTINEL = ''

/**
 * Sentinel period for a record with no time dimension. Same reason as
 * {@link RECORD_KEY_SENTINEL}: the column is NOT NULL so the unique index over
 * the live head actually dedupes. A consumer with no period concept writes
 * every entry at `0` and materializes at `0`.
 */
export const RECORD_PERIOD_SENTINEL = 0

/** Lifecycle of one entry. `accepted` requires a structured act — a source
 *  kind the policy trusts, or an explicit review. */
export type RecordReviewState = 'proposed' | 'accepted' | 'rejected'

/** Every review state, for iteration and validation. */
export const RECORD_REVIEW_STATES: readonly RecordReviewState[] = ['proposed', 'accepted', 'rejected']

/** Position of the assertion inside its source. All fields optional — a chat
 *  message has no page, a scraped row has no character span. */
export interface RecordSourceLocator {
  page?: number
  charStart?: number
  charEnd?: number
}

/** The columns that identify which assertion an entry supersedes. Two entries
 *  with the same key compete for the same live head. */
export interface RecordEntryKey {
  /** Consumer-defined partition inside a scope — whatever second axis the
   *  product folds along. {@link RECORD_KEY_SENTINEL} when unused. */
  dimension: string
  /** The field this entry asserts. Must be a key of the schema map. */
  path: string
  /** Identifies which element of a collection the path belongs to, when the
   *  path addresses a repeated thing. {@link RECORD_KEY_SENTINEL} when unused. */
  itemKey: string
  /** The period the assertion became true in. {@link RECORD_PERIOD_SENTINEL}
   *  when the consumer has no time dimension. */
  period: number
}

/** Separator for the joined fold key. NUL cannot appear in a SQLite text
 *  value, so the join is unambiguous for any key content. */
const KEY_SEPARATOR = '\u0000'

/** Join an entry key into one comparable string, for grouping in memory. */
export function recordKeyString(key: RecordEntryKey): string {
  return [key.dimension, key.path, key.itemKey, String(key.period)].join(KEY_SEPARATOR)
}

/**
 * Deterministic JSON with object keys sorted at every depth. Two values that
 * differ only in key order encode identically, so the conflict rule never
 * fires on serialization noise and the fold's stored value is stable.
 */
export function canonicalRecordJson(value: unknown): string {
  const encoded = JSON.stringify(sortKeysDeep(value))
  return encoded === undefined ? 'null' : encoded
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) out[key] = sortKeysDeep(source[key])
    return out
  }
  return value
}

/** The result shape a `safeParse`-style validator returns. `zod`'s schemas
 *  satisfy this structurally, so a consumer passes its zod schema directly and
 *  this module takes no schema-library dependency. */
export type RecordParseResult =
  | { success: true; data: unknown }
  | { success: false; error: unknown }

/** Something that can validate one value for one path: a `safeParse` object
 *  (zod and friends) or a plain function returning a typed outcome. */
export type RecordValueValidator =
  | { safeParse(value: unknown): RecordParseResult }
  | ((value: unknown) => RecordOutcome<unknown>)

/**
 * Path → validator. The KEY SET is the write allowlist: a path absent from the
 * map is rejected with `unknown-path`, so nothing the consumer's fold cannot
 * type-check ever reaches storage.
 */
export type RecordSchemaMap = Readonly<Record<string, RecordValueValidator>>

/** Run one validator, normalizing both forms to a typed outcome and flattening
 *  a `safeParse` error into a readable message. */
export function validateRecordValue(
  validator: RecordValueValidator,
  value: unknown,
): RecordOutcome<unknown> {
  if (typeof validator === 'function') return validator(value)
  const parsed = validator.safeParse(value)
  if (parsed.success) return recordOk(parsed.data)
  return recordFail('invalid-value', describeParseError(parsed.error))
}

function describeParseError(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const issues = (error as { issues?: unknown }).issues
    if (Array.isArray(issues)) {
      const messages = issues
        .map((issue) => (issue !== null && typeof issue === 'object' ? String((issue as { message?: unknown }).message ?? '') : ''))
        .filter((message) => message.length > 0)
      if (messages.length > 0) return messages.join('; ')
    }
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return String(error)
}

/**
 * How a live accepted head at the same key is compared against an incoming
 * write. Returning `true` means the two assertions genuinely disagree.
 */
export type RecordMaterialDifference = (
  head: { sourceKind: string; valueJson: string; affirmedEmpty: boolean },
  incoming: { sourceKind: string; valueJson: string; affirmedEmpty: boolean },
) => boolean

/**
 * The default rule, and the one all three hand-rolled stores converged on:
 * two assertions materially differ when they come from DIFFERENT source kinds
 * and encode to different canonical JSON. A restatement from the same source
 * kind is a refresh, not a disagreement; an identical value from another
 * source kind is corroboration.
 */
export const defaultRecordMaterialDifference: RecordMaterialDifference = (head, incoming) =>
  head.sourceKind !== incoming.sourceKind &&
  (head.valueJson !== incoming.valueJson || head.affirmedEmpty !== incoming.affirmedEmpty)

/** Canonicalize a key column before it enters the fold key (upper-casing a
 *  region code, trimming an identifier). Rejecting is fail-loud, never a
 *  silent rewrite to a sentinel. */
export type RecordKeyCanonicalizer = (path: string, raw: string) => RecordOutcome<string>

/**
 * Everything domain-specific about writing an entry, supplied by the consumer.
 * The store holds no defaults for any of it except the conflict rule.
 */
export interface RecordWritePolicy {
  /** Path → validator; the key set is the write allowlist. */
  schemas: RecordSchemaMap
  /**
   * Paths that accept a negative assertion (`affirmedEmpty`) — "there are none
   * of these". These are typically COLLECTION paths that carry no value of
   * their own, so they are deliberately separate from {@link schemas}.
   */
  affirmablePaths?: readonly string[]
  /**
   * Source kind → the review state a write from it lands in. The key set is
   * the source-kind allowlist: an unlisted kind is rejected. This is where a
   * product says "a value the user typed is accepted; anything a model
   * extracted is proposed".
   */
  reviewStateOnWrite: Readonly<Record<string, RecordReviewState>>
  /** Source kinds whose writes must carry a `sourceRef`. A citation store
   *  makes every extracting kind require one. */
  requireSourceRef?: readonly string[]
  /** Source kinds whose writes must carry a `sourceQuote`. */
  requireSourceQuote?: readonly string[]
  /**
   * Source kind → product columns (declared through the table factory's
   * `extraColumns`) whose value a write from that kind must supply.
   *
   * `requireSourceRef` can only require THE one built-in ref, which is not
   * enough for a store whose kinds point at different tables — a chat-sourced
   * row cites a message and a document-sourced row cites a document, each with
   * its own foreign key. Declaring one column per kind and requiring it per
   * kind is how that shape is expressed without the store learning either
   * word.
   */
  requireExtras?: Readonly<Record<string, readonly string[]>>
  /** Canonicalize `itemKey` before it becomes part of the fold key. */
  canonicalizeItemKey?: RecordKeyCanonicalizer
  /** Canonicalize `dimension` before it becomes part of the fold key. */
  canonicalizeDimension?: RecordKeyCanonicalizer
  /** Override the conflict rule. Defaults to
   *  {@link defaultRecordMaterialDifference}. */
  isMateriallyDifferent?: RecordMaterialDifference
  /** Lowest accepted period. Defaults to {@link RECORD_PERIOD_SENTINEL}. */
  minPeriod?: number
  /** Highest accepted period. Defaults to `Number.MAX_SAFE_INTEGER`. */
  maxPeriod?: number
}

/** Resolve the review state a write from `sourceKind` lands in, failing loud
 *  on a kind the policy never declared. */
export function resolveWriteReviewState(
  policy: RecordWritePolicy,
  sourceKind: string,
): RecordOutcome<RecordReviewState> {
  const state = policy.reviewStateOnWrite[sourceKind]
  if (state === undefined) {
    const known = Object.keys(policy.reviewStateOnWrite).sort().join(', ')
    return recordFail(
      'unknown-source-kind',
      `source kind '${sourceKind}' is not declared in reviewStateOnWrite (declared: ${known || 'none'})`,
    )
  }
  return recordOk(state)
}

/** True when the incoming write disagrees with the live head under the
 *  policy's rule (or the default). */
export function detectRecordConflict(
  policy: RecordWritePolicy,
  head: { sourceKind: string; valueJson: string; affirmedEmpty: boolean } | undefined,
  incoming: { sourceKind: string; valueJson: string; affirmedEmpty: boolean },
): boolean {
  if (head === undefined) return false
  return (policy.isMateriallyDifferent ?? defaultRecordMaterialDifference)(head, incoming)
}
