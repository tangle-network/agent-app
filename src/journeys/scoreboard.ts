/**
 * The readiness scoreboard writer: one run's journey summary as the writes
 * that put it on the shared board, so every app's rows land in one schema.
 *
 * The board is an artifact page whose shared store holds three collections:
 * `flows` (one row per flow), `prs` and `meta` (one document per app; Hardware's
 * is `board`, written before the board was shared). A row carries `app` and
 * `flowId`; a row without `app` belongs to Hardware. Hardware's rows predate the
 * shared board and live at their bare flow id and `meta/board`; its runner
 * passes `legacyIds` so those rows are updated in place, never duplicated.
 *
 * A document that already exists is merged (`update`) and pinned to the
 * version the caller read from the store (`versions`), so the text a person
 * wrote for a flow (what the customer does, its pass bar) survives every run,
 * and a field the run no longer has (an old blocker on a flow that now passes)
 * is deleted. A document with no known version is created with `set`; the
 * store refuses a `set` without a version on a document that already exists
 * (version_mismatch, nothing written; checked against the board's store on
 * 2026-10-12), so a row a person wrote is never replaced.
 *
 * Pure: the same summary and options give the same writes, in the same order.
 */

export const SCOREBOARD_STATUSES = ['pass', 'fail', 'stall', 'blocked-host', 'blocked', 'skipped', 'unrecorded'] as const
export type ScoreboardStatus = (typeof SCOREBOARD_STATUSES)[number]

/** Rows a store wrote before the board was shared, with no `app` field, belong to this app. */
export const LEGACY_SCOREBOARD_APP = 'hardware'

/** One journey in a run's `summary.json`. */
export interface JourneySummaryEntry {
  /** Flow id, e.g. `c2` or `C2`; written upper-case. */
  id: string
  status: string
  /** Why it was blocked, skipped, stalled or failed. */
  reason?: string
  firstTextS?: number
  completeS?: number
  /** Links a reviewer can open. Only http(s) URLs are written; host paths are dropped. */
  videoUrl?: string
  traceUrl?: string
  evidenceUrl?: string
}

/** A run's summary, as an app's journey runner writes it. */
export interface JourneySummary {
  origin?: string
  /** Commit the run served. */
  sha?: string
  model?: string
  lane?: string
  /** ISO time of the run; required, so two runs are told apart. */
  updatedAt?: string
  journeys: JourneySummaryEntry[]
}

export interface ScoreboardOptions {
  /** Short app name, e.g. `casework`. */
  app: string
  /** Current version of each document that exists, by `collection/docId`. */
  versions?: Readonly<Record<string, number>>
  /**
   * Write at the ids the board used before it was shared: the bare flow id and
   * `meta/board`. Only Hardware's runner sets this; every other app's rows are
   * `<app>-<flowId>` and `meta/<app>`.
   */
  legacyIds?: boolean
}

/** One entry of an artifact store batch, in the shape the batch write takes. */
export interface ScoreboardWrite {
  op: 'update' | 'set'
  collection: 'flows' | 'meta'
  doc_id: string
  data: Record<string, unknown>
  if_version?: number
}

export interface ScoreboardResult {
  writes: ScoreboardWrite[]
  /** Entries the writer could not take as given, each with what it did instead. */
  warnings: string[]
}

const DELETE = { __delete__: true } as const
const APP_NAME = /^[a-z][a-z0-9-]{0,40}$/

const isStatus = (value: string): value is ScoreboardStatus => (SCOREBOARD_STATUSES as readonly string[]).includes(value)
const url = (value: unknown): string | undefined => (typeof value === 'string' && /^https?:\/\//.test(value) ? value : undefined)
const seconds = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined)

/** The document id a flow row lives at. */
export function scoreboardDocId(app: string, flowId: string, legacyIds = false): string {
  return legacyIds ? flowId : `${app}-${flowId}`
}

/** The `meta` document an app's run facts live at. */
export function scoreboardMetaId(app: string, legacyIds = false): string {
  return legacyIds ? 'board' : app
}

/** Keys in a fixed order, so the same input always serializes the same way. */
function sorted(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(data).sort().map((key) => [key, data[key]]))
}

/**
 * A document with a known version is merged, pinned to that version. One with
 * none is created with `set`, which takes no delete markers; if it does exist
 * after all, the store refuses the unpinned write and names it, so nothing a
 * person wrote there is overwritten.
 */
function pinned(write: Omit<ScoreboardWrite, 'if_version'>, versions: ScoreboardOptions['versions']): ScoreboardWrite {
  const version = versions?.[`${write.collection}/${write.doc_id}`]
  if (version !== undefined) return { ...write, op: 'update', if_version: version }
  const data = Object.fromEntries(Object.entries(write.data).filter(([, value]) => value !== DELETE))
  return { ...write, op: 'set', data }
}

export function scoreboardRows(summary: JourneySummary, options: ScoreboardOptions): ScoreboardResult {
  const app = options.app
  if (!APP_NAME.test(app)) throw new Error(`scoreboard: app must be a short lowercase name such as "casework", got "${app}"`)
  if (!summary || !Array.isArray(summary.journeys)) throw new Error('scoreboard: the summary has no journeys array')
  if (!summary.updatedAt || Number.isNaN(Date.parse(summary.updatedAt))) throw new Error('scoreboard: the summary needs updatedAt, an ISO time')

  const warnings: string[] = []
  const flows = new Map<string, ScoreboardWrite>()
  for (const entry of summary.journeys) {
    const flowId = String(entry.id ?? '').trim().toUpperCase()
    if (!flowId) { warnings.push('a journey without an id was skipped'); continue }
    let status: ScoreboardStatus
    if (isStatus(entry.status)) status = entry.status
    else { status = 'unrecorded'; warnings.push(`${flowId}: status "${entry.status}" is not one of ${SCOREBOARD_STATUSES.join(', ')}; written as unrecorded`) }
    if (flows.has(flowId)) warnings.push(`${flowId}: listed twice; the last entry wins`)
    for (const key of ['videoUrl', 'traceUrl', 'evidenceUrl'] as const) {
      if (entry[key] !== undefined && !url(entry[key])) warnings.push(`${flowId}: ${key} is not an http(s) link and was dropped`)
    }
    const reason = typeof entry.reason === 'string' && entry.reason.trim() ? entry.reason.trim() : undefined
    const data: Record<string, unknown> = {
      app,
      flowId,
      status,
      // A pass carries no blocker; any other status names why, or clears a stale one.
      blocker: status !== 'pass' && reason ? reason : DELETE,
      firstTextS: seconds(entry.firstTextS) ?? DELETE,
      completeS: seconds(entry.completeS) ?? DELETE,
      videoUrl: url(entry.videoUrl) ?? DELETE,
      traceUrl: url(entry.traceUrl) ?? DELETE,
      evidenceUrl: url(entry.evidenceUrl) ?? DELETE,
      sha: summary.sha ?? DELETE,
      recordedAt: summary.updatedAt,
    }
    flows.set(flowId, { op: 'update', collection: 'flows', doc_id: scoreboardDocId(app, flowId, options.legacyIds), data: sorted(data) })
  }

  const writes = [...flows.values()]
    .sort((a, b) => a.doc_id.localeCompare(b.doc_id, undefined, { numeric: true }))
    .map((write) => pinned(write, options.versions))
  const meta: Record<string, unknown> = {
    origin: summary.origin ?? DELETE,
    sha: summary.sha ?? DELETE,
    model: summary.model ?? DELETE,
    lane: summary.lane ?? DELETE,
    updatedAt: summary.updatedAt,
  }
  writes.push(pinned({ op: 'update', collection: 'meta', doc_id: scoreboardMetaId(app, options.legacyIds), data: sorted(meta) }, options.versions))
  return { writes, warnings }
}
