/**
 * Reads of a large column a bounded batch at a time.
 *
 * On 2026-10-10 GTM's scheduled jobs exceeded the Worker's 128 MB by reading a
 * day of stored turns at once: the outcome sweep held about 93 MB of turn
 * events, the reliability report read 1.63 M events, and turn health read
 * 121.8 MB of message parts in one query. D1 refuses the same read on its side
 * with `D1_ERROR: Memory limit exceeded before EOF`.
 *
 * A caller lists each row's key with the stored size of its large column
 * (SQLite `length(column)`), then reads and handles one batch before it reads
 * the next, keeping only what it concluded (counts, verdicts) rather than the
 * rows. Memory then holds one batch, not the day.
 *
 * Keep what you conclude, not what you read: a value sliced or matched out of a
 * large string can pin the whole parent string in V8 (a regex match kept in a
 * Map held every tool output it came from). Copy a kept substring out, e.g.
 * `new URL(match).href` or `(' ' + text).slice(1)`, before the row goes.
 */

/** Most bytes of a large column one read returns; a single larger row is read alone. */
export const SIZED_READ_BYTES = 4 * 1024 * 1024

/** D1 binds at most 100 parameters to one query. */
export const D1_MAX_BOUND_PARAMETERS = 100

/** Most single-column keys one read binds, leaving room for the query's own parameters. */
export const SIZED_READ_ROWS = 50

/** Most two-column keys, such as (turnId, seq), one read binds: two parameters each. */
export const SIZED_READ_COMPOSITE_ROWS = 40

/** A row's key and the stored size of its large column. */
export interface SizedRow<K> {
  key: K
  /** `length()` of the large column; null when it is NULL. */
  size: number | null | undefined
}

export interface SizedBatchOptions {
  /** Most bytes per batch. Default {@link SIZED_READ_BYTES}. */
  bytes?: number
  /** Most keys per batch. Default {@link SIZED_READ_ROWS}; `Infinity` for a range read (`seq BETWEEN`). */
  rows?: number
}

/** Consecutive keys whose stored sizes fit one read, in their listed order. */
export function sizedBatches<K>(rows: Iterable<SizedRow<K>>, options: SizedBatchOptions = {}): K[][] {
  const bytes = options.bytes ?? SIZED_READ_BYTES
  const maxRows = options.rows ?? SIZED_READ_ROWS
  if (!(bytes > 0)) throw new RangeError('sized batches need a positive byte budget')
  if (!(maxRows >= 1)) throw new RangeError('sized batches need at least one row per batch')
  const batches: K[][] = []
  let batch: K[] = []
  let size = 0
  for (const row of rows) {
    const rowSize = Math.max(0, Number(row.size ?? 0) || 0)
    if (batch.length > 0 && (size + rowSize > bytes || batch.length >= maxRows)) {
      batches.push(batch)
      batch = []
      size = 0
    }
    batch.push(row.key)
    size += rowSize
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

/**
 * Read listed rows one sized batch at a time. Each batch is read only after the
 * caller has handled the previous one, so a `for await` loop that keeps its
 * conclusions and drops the rows holds one batch at most.
 */
export async function* readInSizedBatches<K, R>(
  rows: Iterable<SizedRow<K>>,
  read: (keys: K[]) => Promise<R>,
  options: SizedBatchOptions = {},
): AsyncGenerator<{ keys: K[]; value: R }> {
  for (const keys of sizedBatches(rows, options)) {
    yield { keys, value: await read(keys) }
  }
}
