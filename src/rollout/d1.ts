/**
 * The measurement a rollout guard reads: one row per turn with its lane, its
 * first visible word and whether it failed, and the stage numbers computed
 * from those rows.
 *
 * Record from the chat route's lifecycle (`onTurnComplete` / `onTurnError`
 * carry `firstVisibleMs`, `firstTextMs` and `durationMs`), then serve `measureStage` behind an
 * operator endpoint that the deploy's `rollout.config.mjs` calls. A stage is
 * measured on the turns of the workspaces it admits, in the lane being rolled
 * out, since the time it went live.
 *
 * By default `record` fills what the product's row leaves out from what the chat route measured for the same
 * `turnId` (its `turnStreamId`): `admissionMs`, `firstVisibleMs`, `firstTextMs`, the served `model` and readable failure, on every
 * lane. It writes only the columns the table has (read once per isolate with `PRAGMA table_info`), so a table that
 * predates a migration keeps recording the columns it has instead of losing the row. `revision`, `arm` and
 * `variant` are the product's and are written when the row carries them. Pass `measuredFacts: false` to write
 * only the row's own values.
 */
import { measuredTurnFacts, nativeTimingObservationValues, type NativeTurnTimingFacts } from '../turn-trace/turn-facts'
import { rolloutAdmits, type RolloutStage, type StageMeasurement } from './index'

/** Minimal D1 surface (Cloudflare's `D1Database` satisfies it). */
export interface D1LikeForRollout {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>
      all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>
    }
  }
}

export const ROLLOUT_TURN_TIMING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS rollout_turn_timing (
  turn_id TEXT PRIMARY KEY,
  rollout TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  lane TEXT NOT NULL,
  admission_ms INTEGER,
  request_received_at INTEGER,
  model TEXT,
  revision TEXT,
  arm TEXT,
  variant TEXT,
  first_visible_ms INTEGER,
  first_text_ms INTEGER,
  settled_ms INTEGER NOT NULL,
  failed INTEGER NOT NULL CHECK (failed IN (0, 1)),
  failure_code TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rollout_turn_timing_by_lane ON rollout_turn_timing (rollout, lane, at);
`

/** Apply once through the product migration runner to existing tables; historical rows stay NULL. */
export const ROLLOUT_TURN_TIMING_FIRST_VISIBLE_MIGRATION_SQL =
  `ALTER TABLE rollout_turn_timing ADD COLUMN first_visible_ms INTEGER;`

/** Apply once through the product migration runner; old rows remain unknown. */
export const ROLLOUT_TURN_TIMING_RULER_MIGRATION_SQL = `
ALTER TABLE rollout_turn_timing ADD COLUMN admission_ms INTEGER;
ALTER TABLE rollout_turn_timing ADD COLUMN model TEXT;
ALTER TABLE rollout_turn_timing ADD COLUMN revision TEXT;
ALTER TABLE rollout_turn_timing ADD COLUMN arm TEXT;
`

/** Apply once through the product migration runner before any row carries `variant`; old rows stay NULL. */
export const ROLLOUT_TURN_TIMING_VARIANT_MIGRATION_SQL =
  `ALTER TABLE rollout_turn_timing ADD COLUMN variant TEXT;`

/** Additive upgrade for a table created before durable native timing transfer. Historical origins remain NULL. */
export const ROLLOUT_TURN_TIMING_REQUEST_ORIGIN_MIGRATION_SQL =
  `ALTER TABLE rollout_turn_timing ADD COLUMN request_received_at INTEGER;`

export interface TurnTimingRow {
  /** Original route trace epoch, used to prevent facts from a different attempt merging into this row. */
  requestReceivedAt?: number
  /** Request receipt to lifecycle start, before the existing relative durations. */
  admissionMs?: number
  model?: string
  revision?: string
  /** The rollout cohort arm (`assignRolloutArm`, or a synthetic cohort's label). Guards filter on it. */
  arm?: string
  /** The turn's experiment assignments, apart from `arm` so an experiment never changes the cohort a guard reads,
   *  e.g. `billing_in_gate=1;prompt_prefix=0`. Written only when set, so a table without the column keeps recording. */
  variant?: string
  turnId: string
  /** The plan this turn counts toward, e.g. `hospitality-routed-chat`. */
  rollout: string
  workspaceId: string
  /** The lane that served the turn, e.g. `routed` or `sandbox`. Only the rolled-out lane is measured. */
  lane: string
  /** From the lifecycle's `firstTextMs`; absent when no word streamed. */
  firstTextMs?: number
  /** From the lifecycle firstVisibleMs; absent when no reasoning, tool or answer streamed. */
  firstVisibleMs?: number
  settledMs: number
  failed: boolean
  /** Defaults to the route's terminal code and redacted explanation. Empty or object-coerced strings use that evidence too. */
  failureCode?: string
  /** Epoch ms; defaults to now. */
  at?: number
}

/** Rows read for one measurement; a stage needing more than this would be measured on its newest rows. */
const MEASURE_ROW_LIMIT = 20_000

function percentile(sorted: readonly number[], p: number): number | null {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!
}

/** Stage metrics from turn rows: first-words and settled percentiles in ms, and the failure rate. */
export function stageMetrics(rows: ReadonlyArray<Pick<TurnTimingRow, 'firstVisibleMs' | 'firstTextMs' | 'settledMs' | 'failed'>>) {
  const firstVisible = rows.flatMap(row => row.firstVisibleMs == null ? [] : [row.firstVisibleMs]).sort((a, b) => a - b)
  const firstWords = rows.flatMap(row => row.firstTextMs === undefined || row.firstTextMs === null ? [] : [row.firstTextMs]).sort((a, b) => a - b)
  const settled = rows.filter(row => !row.failed).map(row => row.settledMs).sort((a, b) => a - b)
  return {
    first_visible_p50_ms: percentile(firstVisible, 50),
    first_visible_p90_ms: percentile(firstVisible, 90),
    first_words_p50_ms: percentile(firstWords, 50),
    first_words_p90_ms: percentile(firstWords, 90),
    settled_p50_ms: percentile(settled, 50),
    settled_p90_ms: percentile(settled, 90),
    // A turn that streamed no word failed the user whatever its envelope said.
    failure_rate: rows.length ? rows.filter(row => row.failed || row.firstTextMs === undefined || row.firstTextMs === null).length / rows.length : null,
  }
}

interface TimingObservationRow {
  admission_ms: number | null; first_visible_ms: number | null; first_text_ms: number | null
  model: string | null; lane: string | null; revision: string | null
}

function timingCoverage(rows: readonly TimingObservationRow[]) {
  const known = (value: string | null) => Boolean(value?.trim()) && value !== 'unknown'
  return {
    admission: rows.filter(row => row.admission_ms != null).length,
    firstVisible: rows.filter(row => row.first_visible_ms != null).length,
    firstText: rows.filter(row => row.first_text_ms != null).length,
    requestOriginFirstVisible: rows.filter(row => row.admission_ms != null && row.first_visible_ms != null).length,
    model: rows.filter(row => known(row.model)).length,
    lane: rows.filter(row => known(row.lane)).length,
    revision: rows.filter(row => known(row.revision)).length,
  }
}

/** Columns `record` writes, in order; `variant` and the ruler columns arrived by migration. */
const RECORD_COLUMNS = ['turn_id', 'rollout', 'workspace_id', 'lane', 'first_visible_ms', 'first_text_ms', 'settled_ms', 'failed',
  'failure_code', 'at', 'admission_ms', 'request_received_at', 'model', 'revision', 'arm', 'variant'] as const
type RecordColumn = typeof RECORD_COLUMNS[number]

/** The table's columns per database binding, read once per isolate; `null` when they could not be read. */
const tableColumns = new WeakMap<object, Promise<ReadonlySet<string> | null>>()

function readColumns(db: D1LikeForRollout, refresh: boolean): Promise<ReadonlySet<string> | null> {
  const cached = tableColumns.get(db)
  if (cached && !refresh) return cached
  const read = Promise.resolve().then(() => db.prepare('PRAGMA table_info(rollout_turn_timing)').bind().all<{ name: string }>())
    .then(({ results = [] }) => results.length ? new Set(results.map(column => column.name)) : null, () => null)
  tableColumns.set(db, read)
  return read
}

function roundOrNull(value: number | undefined): number | null {
  return value === undefined ? null : Math.round(value)
}

export function createD1TurnTimingStore(options: {
  db: D1LikeForRollout
  now?: () => number
  /** Fill omitted timing and model from the chat route's measurement of the same turn. Default true. */
  measuredFacts?: boolean
  /** Read missing observations from the existing native admission owner. Bound and index the selected identity batches. */
  readObservedFacts?(turns: readonly { turnStreamId: string; requestReceivedAt: number }[]): Promise<readonly NativeTurnTimingFacts[]>
}) {
  const now = options.now ?? Date.now
  return {
    /** Record one settled turn. Idempotent on `turnId`. Default never throws; durable owners opt into retryable writes with throwOnError. */
    async record(row: TurnTimingRow, write?: { throwOnError?: boolean }): Promise<void> {
      try {
        // Read before any await: the facts belong to the request that is settling this turn.
        const measured = options.measuredFacts === false ? undefined : measuredTurnFacts(row.turnId)
        const productFailure = row.failureCode?.trim()
        const values: Record<RecordColumn, unknown> = {
          turn_id: row.turnId, rollout: row.rollout, workspace_id: row.workspaceId, lane: row.lane,
          first_visible_ms: roundOrNull(row.firstVisibleMs ?? measured?.firstVisibleMs),
          first_text_ms: roundOrNull(row.firstTextMs ?? measured?.firstTextMs),
          settled_ms: Math.round(row.settledMs), failed: row.failed ? 1 : 0,
          failure_code: productFailure && productFailure !== '[object Object]'
            ? row.failureCode : measured?.failureCode ?? row.failureCode ?? null,
          at: row.at ?? now(), admission_ms: roundOrNull(row.admissionMs ?? measured?.admissionMs),
          request_received_at: row.requestReceivedAt ?? measured?.requestReceivedAt ?? null,
          model: row.model ?? measured?.model ?? null, revision: row.revision ?? null, arm: row.arm ?? null,
          variant: row.variant ?? null,
        }
        let columns = await readColumns(options.db, false)
        // A value the product passed whose column is unknown: the table may have migrated since the read.
        const explicit: Partial<Record<RecordColumn, unknown>> = { first_visible_ms: row.firstVisibleMs,
          admission_ms: row.admissionMs, request_received_at: row.requestReceivedAt, model: row.model, revision: row.revision, arm: row.arm, variant: row.variant }
        if (columns && Object.entries(explicit).some(([column, value]) => value !== undefined && !columns!.has(column))) {
          columns = await readColumns(options.db, true)
        }
        // Columns unknown (no table yet, or a binding without PRAGMA): every column, `variant` only when set.
        const written = RECORD_COLUMNS.filter(column => columns ? columns.has(column) : column !== 'variant' || row.variant !== undefined)
        await options.db.prepare(
          `INSERT OR IGNORE INTO rollout_turn_timing (${written.join(', ')}) VALUES (${written.map(() => '?').join(', ')})`,
        ).bind(...written.map(column => values[column])).run()
      } catch (error) {
        console.error(JSON.stringify({ event: 'rollout_turn_timing_record_failed', turnId: row.turnId,
          error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) }))
        if (write?.throwOnError) throw error
      }
    },

    /** Merge later genuine observations into an already-terminal row. Never inserts or changes its verdict.
     * Exact origin and stream identity must agree; old NULL origins cannot be guessed. Throws so durable owners retry. */
    async recordFacts(facts: NativeTurnTimingFacts): Promise<void> {
      const values = nativeTimingObservationValues(facts)
      await options.db.prepare(`UPDATE rollout_turn_timing SET
        admission_ms = COALESCE(admission_ms, ?), first_visible_ms = COALESCE(first_visible_ms, ?),
        first_text_ms = COALESCE(first_text_ms, ?) WHERE turn_id = ? AND request_received_at = ?
          AND (admission_ms IS NULL OR ? IS NULL OR admission_ms = ?)`)
        .bind(roundOrNull(values.admissionMs), roundOrNull(values.firstVisibleMs), roundOrNull(values.firstTextMs),
          facts.turnStreamId, facts.requestReceivedAt, roundOrNull(values.admissionMs), roundOrNull(values.admissionMs)).run()
    },

    /** Request-origin ruler, separate from the rollout stage's relative latencies and missing-word failure rule.
     * Unknown facts stay in the denominator. Newest rows are bounded explicitly and truncation is reported. */
    async measureRequestOrigin(input: { rollout: string; lane?: string; since: number; until?: number; revision?: string | null }) {
      const until = input.until ?? now()
      const { results = [] } = await options.db.prepare(
        `SELECT turn_id, request_received_at, admission_ms, first_visible_ms, first_text_ms, model, lane, revision, failed FROM rollout_turn_timing
          WHERE rollout = ? AND (? IS NULL OR lane = ?) AND at >= ? AND at < ?
            AND (? = 0 OR (? IS NULL AND (revision IS NULL OR revision = '')) OR revision = ?)
          ORDER BY at DESC LIMIT ?`,
      ).bind(input.rollout, input.lane ?? null, input.lane ?? null, input.since, until,
        input.revision === undefined ? 0 : 1, input.revision ?? null, input.revision ?? null, MEASURE_ROW_LIMIT + 1).all<{
        turn_id: string; request_received_at: number | null
        admission_ms: number | null; first_visible_ms: number | null; first_text_ms: number | null
        model: string | null; lane: string | null; revision: string | null; failed: number
      }>()
      const rows = results.slice(0, MEASURE_ROW_LIMIT)
      const storedCoverage = timingCoverage(rows)
      const missingTiming = () => rows.filter(row => row.admission_ms == null || row.first_visible_ms == null || row.first_text_ms == null)
      const missing = missingTiming().filter(row => row.request_received_at != null)
      const observedFacts = { requested: missing.length, matched: 0, observationReadFailed: false,
        configured: Boolean(options.readObservedFacts), unknown: missingTiming().length }
      if (missing.length && options.readObservedFacts) {
        try {
          const observed = await options.readObservedFacts(missing.map(row => ({ turnStreamId: row.turn_id, requestReceivedAt: row.request_received_at! })))
          const byIdentity = new Map(missing.map(row => [row.turn_id, row]))
          const matched = new Set<string>()
          for (const facts of observed) {
            const row = byIdentity.get(facts.turnStreamId)
            if (!row || row.request_received_at !== facts.requestReceivedAt) continue
            let values: ReturnType<typeof nativeTimingObservationValues>
            try { values = nativeTimingObservationValues(facts) } catch { continue }
            if (row.admission_ms != null && values.admissionMs != null && row.admission_ms !== Math.round(values.admissionMs)) continue
            row.admission_ms ??= roundOrNull(values.admissionMs)
            row.first_visible_ms ??= roundOrNull(values.firstVisibleMs)
            row.first_text_ms ??= roundOrNull(values.firstTextMs)
            matched.add(row.turn_id)
          }
          observedFacts.matched = matched.size
          observedFacts.unknown = missingTiming().length
        } catch {
          observedFacts.observationReadFailed = true
        }
      }
      const visible = rows.flatMap(row => row.admission_ms == null || row.first_visible_ms == null
        ? [] : [row.admission_ms + row.first_visible_ms]).sort((a, b) => a - b)
      const failed = rows.filter(row => row.failed === 1).length
      const coverage = timingCoverage(rows)
      return {
        samples: rows.length, failed, failureRate: rows.length ? failed / rows.length : null,
        requestOriginFirstVisibleP50Ms: percentile(visible, 50),
        coverage,
        storedCoverage,
        recoveredCoverage: Object.fromEntries(Object.entries(coverage).map(([key, count]) => [key, count - storedCoverage[key as keyof typeof storedCoverage]])),
        unknownCoverage: Object.fromEntries(Object.entries(coverage).map(([key, count]) => [key, rows.length - count])),
        truncated: results.length > MEASURE_ROW_LIMIT,
        observedFacts,
        selection: { rollout: input.rollout, lane: input.lane ?? null, revision: input.revision === undefined ? 'all' : input.revision,
          clock: 'settled-at', limit: MEASURE_ROW_LIMIT, filtered: input.lane !== undefined || input.revision !== undefined },
        population: 'Persisted terminal timing rows in the selection; excludes pre-admission and missing-persistence attempts.',
        source: `rollout_turn_timing lane=${input.lane ?? 'all'}`,
        window: { from: new Date(input.since).toISOString(), to: new Date(until).toISOString() },
      }
    },

    /** The stage's numbers: its admitted workspaces' turns in `lane` since `since` (epoch ms). A row carries no
     *  workspace creation time, so a workspace admitted only by a `new-since:` entry is not counted. */
    async measureStage(input: { rollout: string; stage: RolloutStage; lane: string; since: number }): Promise<StageMeasurement> {
      const { results = [] } = await options.db.prepare(
        `SELECT workspace_id, first_visible_ms, first_text_ms, settled_ms, failed FROM rollout_turn_timing
          WHERE rollout = ? AND lane = ? AND at >= ? ORDER BY at DESC LIMIT ?`,
      ).bind(input.rollout, input.lane, input.since, MEASURE_ROW_LIMIT).all<{
        workspace_id: string; first_visible_ms: number | null; first_text_ms: number | null; settled_ms: number; failed: number
      }>()
      const rows = results
        .filter(row => rolloutAdmits(input.stage.value, { id: row.workspace_id }))
        .map(row => ({ firstVisibleMs: row.first_visible_ms ?? undefined, firstTextMs: row.first_text_ms ?? undefined, settledMs: row.settled_ms, failed: row.failed === 1 }))
      return {
        stage: input.stage.name,
        lane: input.lane,
        samples: rows.length,
        metrics: stageMetrics(rows),
        source: `rollout_turn_timing lane=${input.lane}`,
        window: { from: new Date(input.since).toISOString(), to: new Date(now()).toISOString() },
      }
    },
  }
}
