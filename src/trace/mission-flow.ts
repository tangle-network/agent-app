/**
 * Delegation → FlowSpan converters — render what a mission's delegated agent
 * runs actually did as ONE FlowTrace, drawable by the existing
 * `renderWaterfall` (or any viewer that consumes FlowSpans).
 *
 * Two fidelities, one tree:
 *  - COARSE: `delegationActivityToFlowSpans` draws one 'tool' span per
 *    delegation from the StepAgentActivity snapshot (startedAt/durationMs) —
 *    available live, from the step's journaled lane.
 *  - FINE: `loopTraceEventsToFlowSpans` reconstructs agent-runtime's
 *    loop → round → iteration hierarchy from the LoopTraceEvent journal a
 *    delegation persists. FlowSpans carry no parent ids, so nesting rides the
 *    span NAME (`loop ▸ round 0 ▸ iter 1 (coder)`), matching how the ASCII
 *    waterfall reads.
 *
 * `composeMissionFlowTrace` lays a whole mission out: one 'pipeline' span per
 * step, each step's delegations beneath it. Pure data transforms — the
 * structural `LoopTraceEventLike` keeps this module free of the optional
 * agent-runtime peer.
 */

import type { StepAgentActivity } from '../missions/agent-activity'
import type { FlowSpan, FlowTrace } from './index'

/** Structural mirror of agent-runtime's `LoopTraceEvent` — same fields, no
 *  import, so journals parsed from JSON feed straight in. */
export interface LoopTraceEventLike {
  kind: string
  runId: string
  /** Epoch ms. */
  timestamp: number
  payload: object
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}

/** Statuses that mean the delegation is still producing wall time. */
const LIVE_DELEGATION_STATUSES = new Set(['pending', 'running'])

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
    const live = LIVE_DELEGATION_STATUSES.has(run.status)
    const endMs =
      run.durationMs !== undefined
        ? startMs + run.durationMs
        : live && opts?.nowMs !== undefined
          ? opts.nowMs - turnStartMs
          : startMs
    spans.push({
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
 * Reconstruct one delegation's loop → round → iteration tree from its
 * journaled LoopTraceEvents, as FlowSpans relative to `loop.started` (or the
 * first event). Mirrors agent-runtime's `buildLoopOtelSpans` topology:
 * rounds open on `loop.plan` and flush on the next plan / `loop.decision` /
 * `loop.ended`; iterations span `loop.iteration.started` → `.ended`.
 */
export function loopTraceEventsToFlowSpans(events: LoopTraceEventLike[]): FlowSpan[] {
  if (events.length === 0) return []
  const ordered = [...events].sort((a, b) => a.timestamp - b.timestamp)
  const started = ordered.find((e) => e.kind === 'loop.started')
  const ended = ordered.find((e) => e.kind === 'loop.ended')
  const origin = started?.timestamp ?? ordered[0]!.timestamp
  const rootEnd = ended?.timestamp ?? ordered[ordered.length - 1]!.timestamp
  const t = (epochMs: number) => epochMs - origin

  const spans: FlowSpan[] = []
  const sp = rec(started?.payload)
  const ep = rec(ended?.payload)
  spans.push({
    kind: 'pipeline',
    name: 'loop',
    startMs: 0,
    endMs: t(rootEnd),
    meta: {
      runId: ordered[0]!.runId,
      ...(str(sp.driver) !== undefined ? { driver: str(sp.driver) } : {}),
      ...(num(ep.totalCostUsd) !== undefined ? { costUsd: num(ep.totalCostUsd) } : {}),
      ...(num(ep.winnerIterationIndex) !== undefined
        ? { winnerIterationIndex: num(ep.winnerIterationIndex) }
        : {}),
      ...(num(ep.iterations) !== undefined ? { iterations: num(ep.iterations) } : {}),
    },
  })

  const iterStart = new Map<number, number>()
  let round: { index: number; startMs: number; meta: Record<string, unknown>; moveKind: string } | undefined
  const flushRound = (endEpochMs: number) => {
    if (!round) return
    spans.push({
      kind: 'pipeline',
      name: `loop ▸ round ${round.index} (${round.moveKind})`,
      startMs: round.startMs,
      endMs: t(endEpochMs),
      meta: round.meta,
    })
    round = undefined
  }

  for (const e of ordered) {
    const p = rec(e.payload)
    switch (e.kind) {
      case 'loop.plan': {
        flushRound(e.timestamp)
        const index = num(p.roundIndex) ?? 0
        round = {
          index,
          startMs: t(e.timestamp),
          moveKind: str(p.moveKind) ?? 'unknown',
          meta: {
            roundIndex: index,
            moveKind: str(p.moveKind) ?? 'unknown',
            width: num(p.plannedCount) ?? 0,
            ...(str(p.rationale) !== undefined ? { rationale: str(p.rationale) } : {}),
            ...(num(p.parentIndex) !== undefined ? { parentIndex: num(p.parentIndex) } : {}),
          },
        }
        break
      }
      case 'loop.iteration.started': {
        const idx = num(p.iterationIndex)
        if (idx !== undefined) iterStart.set(idx, e.timestamp)
        break
      }
      case 'loop.iteration.ended': {
        const idx = num(p.iterationIndex) ?? 0
        const startEpoch = iterStart.get(idx) ?? e.timestamp
        const error = str(p.error)
        const verdict = rec(p.verdict)
        const tokens = rec(p.tokenUsage)
        const roundLabel = round ? `round ${round.index} ▸ ` : ''
        spans.push({
          kind: 'model',
          name: `loop ▸ ${roundLabel}iter ${idx} (${str(p.agentRunName) ?? 'agent'})`,
          startMs: t(startEpoch),
          endMs: t(e.timestamp),
          meta: {
            iterationIndex: idx,
            ok: error === undefined,
            ...(error !== undefined ? { error } : {}),
            ...(num(p.costUsd) !== undefined ? { costUsd: num(p.costUsd) } : {}),
            ...(typeof verdict.valid === 'boolean' ? { verdictValid: verdict.valid } : {}),
            ...(num(verdict.score) !== undefined ? { verdictScore: num(verdict.score) } : {}),
            ...(num(tokens.input) !== undefined ? { inputTokens: num(tokens.input) } : {}),
            ...(num(tokens.output) !== undefined ? { outputTokens: num(tokens.output) } : {}),
          },
        })
        break
      }
      case 'loop.decision': {
        if (round) {
          const decision = str(p.decision)
          if (decision !== undefined) round.meta.decision = decision
          flushRound(e.timestamp)
        }
        break
      }
    }
  }
  flushRound(rootEnd)
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

export interface MissionFlowStep {
  id: string
  intent: string
  status?: string
  /** Epoch ms the step attempt started. Absent → laid out sequentially after
   *  the previous step (missions run steps in order), `approx` flagged. */
  startedAt?: number
  durationMs?: number
}

/**
 * Compose a mission-wide FlowTrace: one 'pipeline' span per step, the step's
 * delegated runs ('tool' spans, from `activity[stepId]`) beneath it. A step
 * span always covers its delegations' extent. Cost is the sum of delegation
 * `costUsd`; token counts are not knowable from the activity lane and stay 0.
 */
export function composeMissionFlowTrace(input: {
  steps: MissionFlowStep[]
  /** Delegated-run snapshots keyed by step id (the step's `agentActivity`). */
  activity?: Record<string, StepAgentActivity[]>
  /** Epoch-ms origin. Default: the earliest known step/delegation start. */
  startedAt?: number
}): FlowTrace {
  const activity = input.activity ?? {}

  const startCandidates: number[] = []
  if (input.startedAt !== undefined) startCandidates.push(input.startedAt)
  else {
    for (const step of input.steps) {
      if (step.startedAt !== undefined) startCandidates.push(step.startedAt)
    }
    for (const runs of Object.values(activity)) {
      for (const run of runs) {
        const parsed = Date.parse(run.startedAt)
        if (Number.isFinite(parsed)) startCandidates.push(parsed)
      }
    }
  }
  const origin = startCandidates.length > 0 ? Math.min(...startCandidates) : 0

  const spans: FlowSpan[] = []
  let costUsd: number | undefined
  let toolCalls = 0
  let cursorMs = 0

  for (const step of input.steps) {
    const inferred = step.startedAt === undefined
    const startMs = inferred ? cursorMs : step.startedAt! - origin
    const runSpans = delegationActivityToFlowSpans(activity[step.id] ?? [], origin)
    const runExtent = runSpans.reduce((max, s) => Math.max(max, s.endMs), startMs)
    const endMs = Math.max(step.durationMs !== undefined ? startMs + step.durationMs : startMs, runExtent)

    spans.push({
      kind: 'pipeline',
      name: step.intent,
      startMs,
      endMs,
      ...(inferred || step.durationMs === undefined ? { approx: true } : {}),
      meta: { stepId: step.id, ...(step.status !== undefined ? { status: step.status } : {}) },
    })
    for (const span of runSpans) {
      spans.push({ ...span, name: `${step.intent} ▸ ${span.name}` })
      toolCalls++
      const c = num(rec(span.meta).costUsd)
      if (c !== undefined) costUsd = (costUsd ?? 0) + c
    }
    cursorMs = endMs
  }

  return {
    spans,
    totalMs: spans.reduce((max, s) => Math.max(max, s.endMs), 0),
    promptTokens: 0,
    completionTokens: 0,
    ...(costUsd !== undefined ? { costUsd } : {}),
    toolCalls,
  }
}
