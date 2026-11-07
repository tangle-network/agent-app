/**
 * Flow observability for live and replayed turn-buffer events stamped `_t`.
 * Reconstruct pipeline, model/reasoning, tool and usage spans for ASCII reports.
 * Buffered boundaries are quantized by flush/poll cadence (~100–400ms);
 * `approx: true` keeps that uncertainty visible.
 */

export * from './mission-trace'
export type { FlowSpan, FlowTrace } from '@tangle-network/charts'
export * from './mission-flow'

import { reportedCount, sumReportedCounts, type FlowSpan, type FlowTrace } from '@tangle-network/charts'

/** Represent a timed event with a timestamp and associated event data */
export interface TimedEvent {
  /** ms since turn start (`_t` stamped by pumpBufferedTurn). */
  t: number
  event: Record<string, unknown>
}

/** Parse stored turn-event lines (JSON strings with `_t`) into TimedEvents. */
export function timedEventsFromLines(lines: string[]): TimedEvent[] {
  const out: TimedEvent[] = []
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (typeof parsed._t === 'number') out.push({ t: parsed._t, event: parsed })
    } catch {
      /* skip torn lines */
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

function innerOf(e: Record<string, unknown>): Record<string, unknown> {
  return (e.kind === 'event' ? (e.event as Record<string, unknown>) : e) ?? {}
}

/**
 * Derive a span trace from timestamped turn events. Model segments are runs
 * of text/reasoning deltas; a tool span opens at the last delta before its
 * tool_call emission and closes at the matching tool_result.
 */
export function buildFlowTrace(
  events: TimedEvent[],
  opts?: { pricing?: { prompt?: string | number; completion?: string | number }; running?: boolean },
): FlowTrace {
  const spans: FlowSpan[] = []
  const promptCounts: (number | undefined)[] = []
  const completionCounts: (number | undefined)[] = []
  let toolCalls = 0

  const first = events[0]?.t ?? 0
  if (first > 0) {
    spans.push({ kind: 'pipeline', name: 'dispatch → first event', startMs: 0, endMs: first })
  }

  let segStart: number | null = null
  let segEnd = 0
  let segKinds = new Set<string>()
  let lastDeltaT = first
  const openCalls = new Map<string, { name: string; emitT: number; lastDeltaT: number }>()

  const closeSegment = () => {
    if (segStart !== null) {
      spans.push({
        kind: 'model',
        name: segKinds.has('reasoning') ? 'model turn (reasoning + text)' : 'model turn',
        startMs: segStart,
        endMs: segEnd,
        approx: true,
      })
      segStart = null
      segKinds = new Set()
    }
  }

  for (const { t, event } of events) {
    const inner = innerOf(event)
    const type = String(event.kind === 'tool_result' ? 'tool_result' : (inner.type ?? ''))

    if (type === 'text' || type === 'reasoning') {
      if (segStart === null) segStart = t
      segEnd = t
      segKinds.add(type)
      lastDeltaT = t
    } else if (type === 'tool_call') {
      closeSegment()
      toolCalls++
      const call = (inner.call ?? inner) as Record<string, unknown>
      const id = String(call.toolCallId ?? `call_${toolCalls}`)
      openCalls.set(id, { name: String(call.toolName ?? 'tool'), emitT: t, lastDeltaT })
    } else if (type === 'tool_result') {
      const id = String(event.toolCallId ?? inner.toolCallId ?? '')
      const open = openCalls.get(id)
      if (open) {
        const ok = ((event.outcome ?? inner.outcome) as { ok?: boolean } | undefined)?.ok
        spans.push({
          kind: 'tool',
          id: id,
          name: open.name,
          // Execution happens between the end of the model turn that emitted
          // the call and the result landing in the buffer.
          startMs: open.lastDeltaT,
          endMs: t,
          approx: true,
          status: ok === false ? 'failed' : 'done',
          meta: { ok },
        })
        openCalls.delete(id)
      }
    } else if (type === 'usage') {
      const u = inner.usage && typeof inner.usage === 'object' ? inner.usage : {}
      promptCounts.push(reportedCount('promptTokens' in u ? u.promptTokens : undefined))
      completionCounts.push(reportedCount('completionTokens' in u ? u.completionTokens : undefined))
    }
  }
  closeSegment()

  const totalMs = events.length ? events[events.length - 1]!.t : 0
  for (const [id, open] of openCalls) {
    spans.push({ id, kind: 'tool', name: open.name, startMs: open.lastDeltaT,
      endMs: totalMs, status: opts?.running ? 'running' : undefined, approx: true })
  }
  if (opts?.running && spans.at(-1)?.kind === 'model') spans.at(-1)!.status = 'running'
  const promptTokens = sumReportedCounts(promptCounts)
  const completionTokens = sumReportedCounts(completionCounts)
  const trace: FlowTrace = { spans, totalMs, promptTokens, completionTokens, toolCalls }
  const p = opts?.pricing
  if (p && promptTokens !== undefined && completionTokens !== undefined &&
      (p.prompt != null || p.completion != null)) {
    trace.costUsd = promptTokens * Number(p.prompt ?? 0) + completionTokens * Number(p.completion ?? 0)
  }
  return trace
}

const fmtS = (ms: number) => `${(ms / 1000).toFixed(1)}s`

/** ASCII waterfall cascade — the default artifact for explaining a flow. */
export function renderWaterfall(trace: FlowTrace, opts?: { width?: number }): string {
  const width = opts?.width ?? 40
  const scale = trace.totalMs > 0 ? width / trace.totalMs : 0
  const lines: string[] = []
  const spans = [...trace.spans].sort((a, b) => a.startMs - b.startMs)
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]!
    const offset = Math.round(s.startMs * scale)
    const len = Math.max(1, Math.round((s.endMs - s.startMs) * scale))
    const bar = ' '.repeat(offset) + (s.kind === 'tool' ? '▓' : s.kind === 'pipeline' ? '░' : '█').repeat(len)
    const branch = i === spans.length - 1 ? '└─' : '├─'
    const dur = `${fmtS(s.endMs - s.startMs)}${s.approx ? '~' : ''}`
    lines.push(`${fmtS(s.startMs).padStart(7)} ${branch} ${bar.padEnd(width + 2)} ${s.name} (${dur})`)
  }
  const cost = trace.costUsd != null && Number.isFinite(trace.costUsd)
    ? `  $${trace.costUsd.toFixed(trace.costUsd < 0.01 ? 6 : 4)}` : ''
  const tokens = `${reportedCount(trace.promptTokens) ?? 'unknown'}p + ${reportedCount(trace.completionTokens) ?? 'unknown'}c tok`
  lines.push(
    `${fmtS(trace.totalMs).padStart(7)} ── total · ${tokens} · ${reportedCount(trace.toolCalls) ?? 'unknown'} tool calls${cost}`,
  )
  return lines.join('\n')
}
