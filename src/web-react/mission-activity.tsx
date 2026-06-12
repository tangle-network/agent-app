/**
 * Mission + delegation observability surfaces — different nouns, one trace
 * tree:
 *
 *  - {@link MissionActivityLane}: the collapsed sub-rows under a mission step
 *    (what the step's agent is actually doing), expanding to a compact web
 *    waterfall rendered from the `/trace` converters.
 *  - {@link AgentActivityPanel}: the standalone cross-context surface — every
 *    delegation a workspace ran, regardless of which mission (if any) spawned
 *    it — behind a `fetchActivity` data port with cursor + refresh.
 *  - {@link FlowWaterfall}: the web counterpart of `/trace`'s ASCII
 *    `renderWaterfall` (which stays CLI) — proportional bars over a FlowTrace.
 *
 * Same styling contract as the rest of `/web-react`: Tailwind classes against
 * the shared design tokens, inline SVG glyphs, no icon library. The pure
 * layout/merge/format helpers are exported for tests and reuse.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'

import type { StepAgentActivity } from '../missions/agent-activity'
import type { FlowTrace } from '../trace/index'
import { stepActivityFlowTrace } from '../trace/mission-flow'

// ── pure helpers ──────────────────────────────────────────────────────────

export type ActivityTone = 'live' | 'ok' | 'error' | 'neutral'

const LIVE_STATUSES = new Set(['pending', 'running'])
const OK_STATUSES = new Set(['completed', 'done', 'succeeded'])
const ERROR_STATUSES = new Set(['failed', 'error', 'cancelled', 'aborted'])

/** Map a delegation status (free-form string on the wire) to a render tone. */
export function activityTone(status: string): ActivityTone {
  const s = status.toLowerCase()
  if (LIVE_STATUSES.has(s)) return 'live'
  if (OK_STATUSES.has(s)) return 'ok'
  if (ERROR_STATUSES.has(s)) return 'error'
  return 'neutral'
}

/** "$0.4000" under a cent shows 4 decimals; null when unknown/zero. */
export function formatActivityCost(costUsd?: number): string | null {
  if (costUsd === undefined || !isFinite(costUsd) || costUsd <= 0) return null
  return costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`
}

/** "8s" / "2m 05s" / "1h 12m"; null when unknown. */
export function formatActivityDuration(durationMs?: number): string | null {
  if (durationMs === undefined || !isFinite(durationMs) || durationMs < 0) return null
  const totalSeconds = Math.round(durationMs / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** A delegation record on the cross-context surface; `missionRef` links a
 *  promoted delegation back to the mission/step that spawned it. */
export interface AgentActivityRecord extends StepAgentActivity {
  missionRef?: { missionId: string; stepId?: string; label?: string }
}

export interface AgentActivityPage {
  items: AgentActivityRecord[]
  /** Opaque continuation token; absent ⇒ no further pages. */
  nextCursor?: string
}

/**
 * Fold a fetched page into the held rows: dedupe by `taskId` with the
 * incoming row winning (a refresh re-fetches the head page, so newer
 * snapshots of in-flight runs replace stale ones), newest `startedAt` first.
 */
export function mergeActivityPages(
  existing: AgentActivityRecord[],
  incoming: AgentActivityRecord[],
): AgentActivityRecord[] {
  const byTask = new Map<string, AgentActivityRecord>()
  for (const row of existing) byTask.set(row.taskId, row)
  for (const row of incoming) byTask.set(row.taskId, row)
  return [...byTask.values()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
}

export interface WaterfallRow {
  name: string
  kind: 'pipeline' | 'model' | 'tool'
  /** Bar geometry as percentages of the trace's total span. */
  offsetPct: number
  widthPct: number
  durationLabel: string
  approx: boolean
  /** False only when the span's meta carries an explicit failure. */
  ok: boolean
}

/** Project a FlowTrace into proportional bar geometry for {@link FlowWaterfall}. */
export function waterfallLayout(trace: FlowTrace): WaterfallRow[] {
  const total = trace.totalMs > 0 ? trace.totalMs : 1
  return [...trace.spans]
    .sort((a, b) => a.startMs - b.startMs)
    .map((span) => {
      const meta = span.meta ?? {}
      const failed =
        meta.ok === false || (typeof meta.status === 'string' && activityTone(meta.status) === 'error')
      return {
        name: span.name,
        kind: span.kind,
        offsetPct: Math.max(0, Math.min(100, (span.startMs / total) * 100)),
        widthPct: Math.max(0.5, Math.min(100, ((span.endMs - span.startMs) / total) * 100)),
        durationLabel: `${((span.endMs - span.startMs) / 1000).toFixed(1)}s${span.approx ? '~' : ''}`,
        approx: span.approx === true,
        ok: !failed,
      }
    })
}

// ── glyphs ────────────────────────────────────────────────────────────────

function ChevronGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function RefreshGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
    </svg>
  )
}

function StatusDot({ tone }: { tone: ActivityTone }) {
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${
        tone === 'live' ? 'animate-pulse bg-yellow-500' : tone === 'ok' ? 'bg-green-500' : tone === 'error' ? 'bg-red-500' : 'bg-muted-foreground/40'
      }`}
    />
  )
}

// ── FlowWaterfall ─────────────────────────────────────────────────────────

const BAR_CLASS: Record<WaterfallRow['kind'], string> = {
  pipeline: 'bg-muted-foreground/30',
  model: 'bg-primary/60',
  tool: 'bg-primary',
}

export interface FlowWaterfallProps {
  trace: FlowTrace
}

/** Compact proportional waterfall over a FlowTrace — span name, bar, duration
 *  per row; total + cost in the footer. */
export function FlowWaterfall({ trace }: FlowWaterfallProps) {
  const rows = waterfallLayout(trace)
  if (rows.length === 0) return null
  const cost = formatActivityCost(trace.costUsd)
  return (
    <div className="space-y-1">
      {rows.map((row, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-2">
          <span className="truncate font-mono text-[11px] text-muted-foreground" title={row.name}>
            {row.name}
          </span>
          <div className="relative h-2 rounded-sm bg-muted/40">
            <div
              className={`absolute inset-y-0 rounded-sm ${row.ok ? BAR_CLASS[row.kind] : 'bg-red-500/80'} ${row.approx ? 'opacity-70' : ''}`}
              style={{ left: `${row.offsetPct}%`, width: `${row.widthPct}%` }}
            />
          </div>
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">{row.durationLabel}</span>
        </div>
      ))}
      <p className="pt-0.5 text-right font-mono text-[10px] tabular-nums text-muted-foreground/60">
        {(trace.totalMs / 1000).toFixed(1)}s{cost ? ` · ${cost}` : ''}
      </p>
    </div>
  )
}

// ── MissionActivityLane ───────────────────────────────────────────────────

export interface MissionActivityLaneProps {
  /** The step's delegated-run snapshot (`MissionStepState.agentActivity`). */
  activity: StepAgentActivity[]
  /** Epoch ms origin for the expanded waterfall — usually the step start. */
  startedAt?: number
  /** Wall clock for extending in-flight runs on the waterfall. */
  nowMs?: number
}

/**
 * Collapsed sub-rows under a mission step — one row per delegated run —
 * expanding to the step's waterfall. Renders nothing for an empty lane.
 */
export function MissionActivityLane({ activity, startedAt, nowMs }: MissionActivityLaneProps) {
  const [expanded, setExpanded] = useState(false)
  if (activity.length === 0) return null

  return (
    <div className="mt-1 border-l border-border/50 pl-3">
      {activity.map((run) => {
        const tone = activityTone(run.status)
        const cost = formatActivityCost(run.costUsd)
        const duration = formatActivityDuration(run.durationMs)
        return (
          <div key={run.taskId} className="flex items-center gap-2 py-1 text-xs">
            <StatusDot tone={tone} />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{run.tool}</span>
              <span className="text-muted-foreground"> — {run.detail}</span>
            </span>
            {tone === 'live' && (run.iteration !== undefined || run.phase !== undefined) && (
              <span className="shrink-0 rounded-full bg-yellow-500/10 px-1.5 py-0.5 font-mono text-[10px] text-yellow-700 dark:text-yellow-400">
                {[run.iteration !== undefined ? `iter ${run.iteration}` : null, run.phase ?? null]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
            <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] tabular-nums text-muted-foreground/70">
              {tone !== 'live' && tone !== 'ok' && <span>{run.status}</span>}
              {cost && <span>{cost}</span>}
              {duration && <span>{duration}</span>}
            </span>
          </div>
        )
      })}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 py-0.5 text-[10px] font-medium text-muted-foreground/70 transition hover:text-foreground"
      >
        <ChevronGlyph className={`h-3 w-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        timeline
      </button>
      {expanded && (
        <div className="rounded-md border border-border/50 bg-muted/10 p-2">
          <FlowWaterfall
            trace={stepActivityFlowTrace(activity, {
              ...(startedAt !== undefined ? { startedAt } : {}),
              ...(nowMs !== undefined ? { nowMs } : {}),
            })}
          />
        </div>
      )}
    </div>
  )
}

// ── AgentActivityPanel ────────────────────────────────────────────────────

export interface AgentActivityPanelProps {
  /** Data port — page through the product's delegation records. Called with
   *  no cursor on mount/refresh, with `nextCursor` for older pages. */
  fetchActivity: (cursor?: string) => Promise<AgentActivityPage>
  /** Render the mission link for a promoted delegation (chip, anchor, router
   *  Link — the product's routing, not ours). */
  renderMissionRef?: (ref: NonNullable<AgentActivityRecord['missionRef']>, record: AgentActivityRecord) => ReactNode
  title?: string
  emptyLabel?: string
}

function ActivityRow({
  record,
  renderMissionRef,
}: {
  record: AgentActivityRecord
  renderMissionRef?: AgentActivityPanelProps['renderMissionRef']
}) {
  const [open, setOpen] = useState(false)
  const tone = activityTone(record.status)
  const cost = formatActivityCost(record.costUsd)
  const duration = formatActivityDuration(record.durationMs)

  return (
    <div className="rounded-lg border border-border/60 bg-card">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm">
        <StatusDot tone={tone} />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{record.tool}</span>
          <span className="text-muted-foreground"> — {record.detail}</span>
        </span>
        {tone === 'live' && (record.iteration !== undefined || record.phase !== undefined) && (
          <span className="shrink-0 rounded-full bg-yellow-500/10 px-2 py-0.5 font-mono text-[10px] text-yellow-700 dark:text-yellow-400">
            {[record.iteration !== undefined ? `iter ${record.iteration}` : null, record.phase ?? null]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
            tone === 'ok'
              ? 'bg-green-500/10 text-green-700 dark:text-green-400'
              : tone === 'error'
                ? 'bg-red-500/10 text-red-700 dark:text-red-400'
                : tone === 'live'
                  ? 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400'
                  : 'bg-muted/60 text-muted-foreground'
          }`}
        >
          {record.status}
        </span>
        {cost && <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{cost}</span>}
        <ChevronGlyph className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="space-y-1.5 border-t border-border/40 px-3 py-2.5">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
            <dt className="text-muted-foreground/60">task</dt>
            <dd className="truncate text-muted-foreground">{record.taskId}</dd>
            <dt className="text-muted-foreground/60">started</dt>
            <dd className="text-muted-foreground">{new Date(record.startedAt).toLocaleString()}</dd>
            {duration && (
              <>
                <dt className="text-muted-foreground/60">duration</dt>
                <dd className="text-muted-foreground">{duration}</dd>
              </>
            )}
            {record.traceId && (
              <>
                <dt className="text-muted-foreground/60">trace</dt>
                <dd className="truncate text-muted-foreground">{record.traceId}</dd>
              </>
            )}
          </dl>
          {record.missionRef && renderMissionRef?.(record.missionRef, record)}
        </div>
      )}
    </div>
  )
}

/**
 * The standalone cross-context delegation surface: every agent run the
 * product journaled, mission-spawned or not, with status, cost, drill-in, and
 * a mission link slot for promoted delegations.
 */
export function AgentActivityPanel({ fetchActivity, renderMissionRef, title = 'Agent activity', emptyLabel = 'No agent runs yet.' }: AgentActivityPanelProps) {
  const [rows, setRows] = useState<AgentActivityRecord[]>([])
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (from?: string) => {
      setLoading(true)
      setError(null)
      try {
        const page = await fetchActivity(from)
        setRows((prev) => mergeActivityPages(from === undefined ? [] : prev, page.items))
        setCursor(page.nextCursor)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [fetchActivity],
  )

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-sm font-semibold">{title}</h2>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Refresh"
          className="rounded-md p-1.5 text-muted-foreground transition hover:bg-accent/30 hover:text-foreground disabled:opacity-50"
        >
          <RefreshGlyph className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      {error && <p className="rounded-md border border-red-300/60 bg-red-500/5 px-3 py-2 text-xs text-red-600">{error}</p>}
      {!error && rows.length === 0 && !loading && <p className="px-1 text-sm text-muted-foreground">{emptyLabel}</p>}
      <div className="space-y-1.5">
        {rows.map((record) => (
          <ActivityRow key={record.taskId} record={record} renderMissionRef={renderMissionRef} />
        ))}
      </div>
      {cursor && (
        <button
          type="button"
          onClick={() => void load(cursor)}
          disabled={loading}
          className="w-full rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-accent/30 disabled:opacity-50"
        >
          Older runs
        </button>
      )}
    </div>
  )
}
