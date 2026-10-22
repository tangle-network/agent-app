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
 * `turnId` (its `turnStreamId`): `admissionMs`, `firstVisibleMs`, `firstTextMs` and the served `model`, on every
 * lane. It writes only the columns the table has (read once per isolate with `PRAGMA table_info`), so a table that
 * predates a migration keeps recording the columns it has instead of losing the row. `revision`, `arm` and
 * `variant` are the product's and are written when the row carries them. Pass `measuredFacts: false` to write
 * only the row's own values.
 */
import { measuredTurnFacts } from '../turn-trace/turn-facts'
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

export interface TurnTimingRow {
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

/** Columns `record` writes, in order; `variant` and the ruler columns arrived by migration. */
const RECORD_COLUMNS = ['turn_id', 'rollout', 'workspace_id', 'lane', 'first_visible_ms', 'first_text_ms', 'settled_ms', 'failed',
  'failure_code', 'at', 'admission_ms', 'model', 'revision', 'arm', 'variant'] as const
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
}) {
  const now = options.now ?? Date.now
  return {
    /** Record one settled turn. Idempotent on `turnId`. Never throws: telemetry must not fail a turn. */
    async record(row: TurnTimingRow): Promise<void> {
      try {
        // Read before any await: the facts belong to the request that is settling this turn.
        const measured = options.measuredFacts === false ? undefined : measuredTurnFacts(row.turnId)
        const values: Record<RecordColumn, unknown> = {
          turn_id: row.turnId, rollout: row.rollout, workspace_id: row.workspaceId, lane: row.lane,
          first_visible_ms: roundOrNull(row.firstVisibleMs ?? measured?.firstVisibleMs),
          first_text_ms: roundOrNull(row.firstTextMs ?? measured?.firstTextMs),
          settled_ms: Math.round(row.settledMs), failed: row.failed ? 1 : 0, failure_code: row.failureCode ?? null,
          at: row.at ?? now(), admission_ms: roundOrNull(row.admissionMs ?? measured?.admissionMs),
          model: row.model ?? measured?.model ?? null, revision: row.revision ?? null, arm: row.arm ?? null,
          variant: row.variant ?? null,
        }
        let columns = await readColumns(options.db, false)
        // A value the product passed whose column is unknown: the table may have migrated since the read.
        const explicit: Partial<Record<RecordColumn, unknown>> = { first_visible_ms: row.firstVisibleMs,
          admission_ms: row.admissionMs, model: row.model, revision: row.revision, arm: row.arm, variant: row.variant }
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
