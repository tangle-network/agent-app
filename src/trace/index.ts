/**
 * `@tangle-network/agent-app/trace` — flow observability for agent turns.
 *
 * The turn buffer stamps `_t` (ms since turn start) on every event, so any
 * live stream OR any historical turn replayed from a TurnEventStore can be
 * reconstructed into a span trace: pipeline overhead, model segments (with
 * thinking TTFT), tool executions, token usage, and cost. Renderers turn
 * traces and multi-run samples into ASCII waterfalls and histograms — the
 * default artifact for "how did this run actually behave" questions across
 * evals, hill-climbs, and production debugging.
 *
 * Span boundaries derived from a buffered stream are quantized by the
 * pump's flush window and the reader's poll cadence (~100–400ms); spans
 * carry `approx: true` to keep reports honest about that.
 */

export interface TimedEvent {
  /** ms since turn start (`_t` stamped by pumpBufferedTurn). */
  t: number
  event: Record<string, unknown>
}

export interface FlowSpan {
  kind: 'pipeline' | 'model' | 'tool'
  name: string
  startMs: number
  endMs: number
  approx?: boolean
  meta?: Record<string, unknown>
}

export interface FlowTrace {
  spans: FlowSpan[]
  totalMs: number
  promptTokens: number
  completionTokens: number
  /** Computed when per-token pricing is supplied. */
  costUsd?: number
  toolCalls: number
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
  opts?: { pricing?: { prompt?: string | number; completion?: string | number } },
): FlowTrace {
  const spans: FlowSpan[] = []
  let promptTokens = 0
  let completionTokens = 0
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
        spans.push({
          kind: 'tool',
          name: open.name,
          // Execution happens between the end of the model turn that emitted
          // the call and the result landing in the buffer.
          startMs: open.lastDeltaT,
          endMs: t,
          approx: true,
          meta: { ok: ((event.outcome ?? inner.outcome) as { ok?: boolean } | undefined)?.ok },
        })
        openCalls.delete(id)
      }
    } else if (type === 'usage') {
      const u = (inner.usage ?? {}) as { promptTokens?: number; completionTokens?: number }
      promptTokens += u.promptTokens ?? 0
      completionTokens += u.completionTokens ?? 0
    }
  }
  closeSegment()

  const totalMs = events.length ? events[events.length - 1]!.t : 0
  const trace: FlowTrace = { spans, totalMs, promptTokens, completionTokens, toolCalls }
  const p = opts?.pricing
  if (p && (p.prompt != null || p.completion != null)) {
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
  const cost = trace.costUsd != null ? `  $${trace.costUsd.toFixed(trace.costUsd < 0.01 ? 6 : 4)}` : ''
  lines.push(
    `${fmtS(trace.totalMs).padStart(7)} ── total · ${trace.promptTokens}p + ${trace.completionTokens}c tok · ${trace.toolCalls} tool calls${cost}`,
  )
  return lines.join('\n')
}

export interface DistributionSummary {
  n: number
  min: number
  p50: number
  p90: number
  max: number
}

export function summarize(values: number[]): DistributionSummary {
  const sorted = [...values].sort((a, b) => a - b)
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0
  return { n: sorted.length, min: sorted[0] ?? 0, p50: q(0.5), p90: q(0.9), max: sorted[sorted.length - 1] ?? 0 }
}

/** ASCII histogram for multi-run samples (eval latencies, costs, scores). */
export function renderHistogram(
  values: number[],
  opts?: { buckets?: number; width?: number; unit?: string; format?: (v: number) => string },
): string {
  if (!values.length) return '(no samples)'
  const buckets = opts?.buckets ?? 6
  const width = opts?.width ?? 24
  const fmt = opts?.format ?? ((v: number) => `${Math.round(v)}${opts?.unit ?? ''}`)
  const s = summarize(values)
  const lo = s.min
  const hi = s.max === s.min ? s.min + 1 : s.max
  const counts = new Array<number>(buckets).fill(0)
  for (const v of values) {
    counts[Math.min(buckets - 1, Math.floor(((v - lo) / (hi - lo)) * buckets))]!++
  }
  const maxCount = Math.max(...counts)
  const lines = [
    `n=${s.n}  min=${fmt(s.min)}  p50=${fmt(s.p50)}  p90=${fmt(s.p90)}  max=${fmt(s.max)}`,
  ]
  for (let i = 0; i < buckets; i++) {
    const a = lo + ((hi - lo) * i) / buckets
    const b = lo + ((hi - lo) * (i + 1)) / buckets
    const bar = '█'.repeat(Math.max(counts[i]! > 0 ? 1 : 0, Math.round((counts[i]! / maxCount) * width)))
    lines.push(`${fmt(a).padStart(8)}-${fmt(b).padEnd(8)} ${bar} ${counts[i]}`)
  }
  return lines.join('\n')
}
