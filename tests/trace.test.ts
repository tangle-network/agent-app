import { describe, it, expect } from 'vitest'
import {
  timedEventsFromLines,
  buildFlowTrace,
  renderWaterfall,
  renderHistogram,
  summarize,
  createMissionTraceContext,
  childSpanContext,
  traceEnv,
} from '../src/trace/index'

const line = (t: number, obj: Record<string, unknown>) => JSON.stringify({ ...obj, _t: t })

const TURN = [
  line(800, { type: 'turn', turnId: 'x' }),
  line(15_000, { kind: 'event', event: { type: 'reasoning', text: 'hmm' } }),
  line(16_000, { kind: 'event', event: { type: 'text', text: 'Creating…' } }),
  line(16_900, { kind: 'event', event: { type: 'tool_call', call: { toolCallId: 'c1', toolName: 'sandbox_create', args: {} } } }),
  line(27_000, { kind: 'tool_result', toolCallId: 'c1', outcome: { ok: true } }),
  line(40_000, { kind: 'event', event: { type: 'text', text: 'Done.' } }),
  line(40_100, { kind: 'event', event: { type: 'usage', usage: { promptTokens: 1000, completionTokens: 200 } } }),
  line(40_200, { type: 'metadata', data: {} }),
]

describe('buildFlowTrace', () => {
  const trace = buildFlowTrace(timedEventsFromLines(TURN), {
    pricing: { prompt: '0.0000001', completion: '0.0000002' },
  })

  it('derives pipeline, model segments, and tool spans with usage + cost', () => {
    expect(trace.totalMs).toBe(40_200)
    expect(trace.toolCalls).toBe(1)
    expect(trace.promptTokens).toBe(1000)
    expect(trace.completionTokens).toBe(200)
    expect(trace.costUsd).toBeCloseTo(0.00014, 6)

    const kinds = trace.spans.map((s) => `${s.kind}:${s.name}`)
    expect(kinds[0]).toBe('pipeline:dispatch → first event')
    expect(kinds).toContain('tool:sandbox_create')
    expect(trace.spans.filter((s) => s.kind === 'model')).toHaveLength(2)
  })

  it('tool span covers execution: last delta before emission → result landing', () => {
    const tool = trace.spans.find((s) => s.kind === 'tool')!
    expect(tool.startMs).toBe(16_000)
    expect(tool.endMs).toBe(27_000)
    expect(tool.approx).toBe(true)
    expect(tool.meta?.ok).toBe(true)
  })

  it('renders a waterfall with total, tokens, and cost', () => {
    const art = renderWaterfall(trace)
    expect(art).toContain('sandbox_create')
    expect(art).toContain('40.2s ── total · 1000p + 200c tok · 1 tool calls')
    expect(art).toContain('$0.00014')
  })
})

describe('distributions', () => {
  const samples = [8, 12, 14, 20, 27, 41, 44, 60, 89, 96, 103, 118]

  it('summarize gives n/min/p50/p90/max', () => {
    const s = summarize(samples)
    // nearest-rank quantiles (upper element for even n)
    expect(s).toEqual({ n: 12, min: 8, p50: 44, p90: 103, max: 118 })
  })

  it('renderHistogram draws buckets that account for every sample', () => {
    const art = renderHistogram(samples, { buckets: 4, unit: 's' })
    expect(art).toContain('n=12')
    const counts = art
      .split('\n')
      .slice(1)
      .map((l) => Number(l.trim().split(' ').pop()))
    expect(counts.reduce((a, b) => a + b, 0)).toBe(12)
  })
})

describe('mission trace context (agent-runtime id-format parity)', () => {
  const TRACE_32_HEX = /^[0-9a-f]{32}$/
  const SPAN_16_HEX = /^[0-9a-f]{16}$/

  it('mints 32-hex trace ids and 16-hex span ids (OTLP wire widths)', () => {
    for (const ctx of [createMissionTraceContext(), createMissionTraceContext('m-42')]) {
      expect(ctx.traceId).toMatch(TRACE_32_HEX)
      expect(ctx.rootSpanId).toMatch(SPAN_16_HEX)
    }
    const child = childSpanContext(createMissionTraceContext('m-42'), 'step-1#1')
    expect(child.spanId).toMatch(SPAN_16_HEX)
  })

  it('is deterministic per missionId — a re-dispatch joins the same trace', () => {
    expect(createMissionTraceContext('m-42')).toEqual(createMissionTraceContext('m-42'))
    expect(createMissionTraceContext('m-42').traceId).not.toBe(createMissionTraceContext('m-43').traceId)
    expect(createMissionTraceContext().traceId).not.toBe(createMissionTraceContext().traceId)
  })

  it('threads parentage: step attempts nest under the root, nested work under the step', () => {
    const mission = createMissionTraceContext('m-42')
    const attempt = childSpanContext(mission, 'step-1#1')
    expect(attempt.traceId).toBe(mission.traceId)
    expect(attempt.parentSpanId).toBe(mission.rootSpanId)
    expect(childSpanContext(mission, 'step-1#1')).toEqual(attempt) // seeded ⇒ deterministic
    expect(childSpanContext(mission, 'step-1#2').spanId).not.toBe(attempt.spanId)

    const nested = childSpanContext(attempt, 'delegate-0')
    expect(nested.parentSpanId).toBe(attempt.spanId)
    expect(nested.traceId).toBe(mission.traceId)
  })

  it('traceEnv emits the exact env names agent-runtime readTraceContextFromEnv reads', () => {
    const mission = createMissionTraceContext('m-42')
    expect(traceEnv(mission)).toEqual({
      TRACE_ID: mission.traceId,
      PARENT_SPAN_ID: mission.rootSpanId,
    })
    const attempt = childSpanContext(mission, 'step-1#1')
    const env = traceEnv(attempt)
    expect(Object.keys(env).sort()).toEqual(['PARENT_SPAN_ID', 'TRACE_ID'])
    expect(env.PARENT_SPAN_ID).toBe(attempt.spanId)
  })
})
