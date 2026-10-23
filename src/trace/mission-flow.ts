/** Convert journaled step delegations into the flow trace shown by the mission activity lane. */

import type { StepAgentActivity } from '../missions/agent-activity'
import type { FlowSpan, FlowTrace } from '@tangle-network/charts'

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}

/** Statuses that mean the delegation is still producing wall time. */
const LIVE_DELEGATION_STATUSES = new Set(['pending', 'running'])
const ERROR_STATUSES = new Set(['failed', 'error', 'cancelled', 'aborted', 'down'])

/** Interpret domain wire status at the producer boundary, never in the chart. */
function flowStatus(status?: string): NonNullable<FlowSpan['status']> {
  const normalized = String(status ?? '').toLowerCase()
  return ERROR_STATUSES.has(normalized) ? 'failed'
    : LIVE_DELEGATION_STATUSES.has(normalized) ? 'running' : 'done'
}

/**
 * One 'tool' FlowSpan per delegation, positioned relative to `turnStartMs`
 * (the epoch-ms origin of the trace — usually the step or mission start).
 * A row whose `startedAt` does not parse cannot be placed on a timeline and
 * is omitted from the WATERFALL (it stays in the lane itself). A run without
 * `durationMs` is still in flight: its span extends to `opts.nowMs` when
 * given, else renders as a point — `approx` flags both.
 */
export function delegationActivityToFlowSpans(
  activity: StepAgentActivity[],
  turnStartMs: number,
  opts?: { nowMs?: number },
): FlowSpan[] {
  const spans: FlowSpan[] = []
  for (const run of activity) {
    const startedAt = Date.parse(run.startedAt)
    if (!Number.isFinite(startedAt)) continue
    const startMs = startedAt - turnStartMs
    const status = flowStatus(run.status)
    const live = status === 'running'
    const endMs =
      run.durationMs !== undefined
        ? startMs + run.durationMs
        : live && opts?.nowMs !== undefined
          ? opts.nowMs - turnStartMs
          : startMs
    spans.push({
      id: run.taskId,
      status,
      kind: 'tool',
      name: `${run.tool} — ${run.detail}`,
      startMs,
      endMs: Math.max(endMs, startMs),
      ...(run.durationMs === undefined ? { approx: true } : {}),
      meta: {
        taskId: run.taskId,
        status: run.status,
        ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}),
        ...(run.iteration !== undefined ? { iteration: run.iteration } : {}),
        ...(run.phase !== undefined ? { phase: run.phase } : {}),
        ...(run.traceId !== undefined ? { traceId: run.traceId } : {}),
        ...(run.spanId !== undefined ? { spanId: run.spanId } : {}),
      },
    })
  }
  return spans
}

/**
 * A single step's activity lane as its own FlowTrace — what a per-step
 * drill-in renders. Origin defaults to the earliest delegation start so the
 * waterfall begins at the lane's first run.
 */
export function stepActivityFlowTrace(
  activity: StepAgentActivity[],
  opts?: { startedAt?: number; nowMs?: number },
): FlowTrace {
  let origin = opts?.startedAt
  if (origin === undefined) {
    for (const run of activity) {
      const parsed = Date.parse(run.startedAt)
      if (Number.isFinite(parsed) && (origin === undefined || parsed < origin)) origin = parsed
    }
  }
  const spans = delegationActivityToFlowSpans(
    activity,
    origin ?? 0,
    opts?.nowMs !== undefined ? { nowMs: opts.nowMs } : undefined,
  )
  let costUsd: number | undefined
  for (const span of spans) {
    const c = num(rec(span.meta).costUsd)
    if (c !== undefined) costUsd = (costUsd ?? 0) + c
  }
  return {
    spans,
    totalMs: spans.reduce((max, s) => Math.max(max, s.endMs), 0),
    promptTokens: 0,
    completionTokens: 0,
    ...(costUsd !== undefined ? { costUsd } : {}),
    toolCalls: spans.length,
  }
}
