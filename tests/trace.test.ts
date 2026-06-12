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
  delegationActivityToFlowSpans,
  loopTraceEventsToFlowSpans,
  composeMissionFlowTrace,
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

describe('delegation activity → FlowSpans (coarse)', () => {
  const T0 = Date.parse('2026-06-12T10:00:00.000Z')
  const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString()

  it('draws one tool span per delegation with status/cost/progress meta', () => {
    const spans = delegationActivityToFlowSpans(
      [
        { taskId: 't1', tool: 'coder', status: 'completed', detail: 'wire exporter', startedAt: iso(1_000), durationMs: 30_000, costUsd: 0.21 },
        { taskId: 't2', tool: 'researcher', status: 'running', detail: 'compare codecs', startedAt: iso(5_000), iteration: 2, phase: 'reading' },
      ],
      T0,
      { nowMs: T0 + 12_000 },
    )
    expect(spans).toHaveLength(2)
    expect(spans[0]).toMatchObject({ kind: 'tool', name: 'coder — wire exporter', startMs: 1_000, endMs: 31_000 })
    expect(spans[0]?.approx).toBeUndefined()
    expect(spans[0]?.meta).toMatchObject({ taskId: 't1', status: 'completed', costUsd: 0.21 })
    // in-flight run extends to nowMs and is flagged approximate
    expect(spans[1]).toMatchObject({ startMs: 5_000, endMs: 12_000, approx: true })
    expect(spans[1]?.meta).toMatchObject({ iteration: 2, phase: 'reading' })
  })

  it('omits rows whose startedAt cannot be placed on a timeline', () => {
    const spans = delegationActivityToFlowSpans(
      [{ taskId: 't1', tool: 'coder', status: 'failed', detail: 'x', startedAt: 'not-a-date' }],
      T0,
    )
    expect(spans).toEqual([])
  })
})

describe('loop journal → FlowSpans (fine-grained)', () => {
  // Fixture journal: a fanout round (2 branches) then a refine round, matching
  // agent-runtime's loop.* event stream shape.
  const ev = (kind: string, timestamp: number, payload: object) => ({ kind, runId: 'run-1', timestamp, payload })
  const JOURNAL = [
    ev('loop.started', 100_000, { driver: 'fanout-vote', agentRunNames: ['coder'], maxIterations: 4, maxConcurrency: 2 }),
    ev('loop.plan', 100_500, { roundIndex: 0, plannedCount: 2, moveKind: 'fanout', rationale: 'explore both', childIndices: [0, 1] }),
    ev('loop.iteration.started', 101_000, { iterationIndex: 0, agentRunName: 'coder', taskHash: 'h0', groupId: 0 }),
    ev('loop.iteration.started', 101_200, { iterationIndex: 1, agentRunName: 'coder', taskHash: 'h1', groupId: 0 }),
    ev('loop.iteration.ended', 130_000, { iterationIndex: 0, agentRunName: 'coder', costUsd: 0.1, durationMs: 29_000, verdict: { valid: true, score: 0.8 }, tokenUsage: { input: 900, output: 200 } }),
    ev('loop.iteration.ended', 131_000, { iterationIndex: 1, agentRunName: 'coder', costUsd: 0.12, durationMs: 29_800, error: 'build failed' }),
    ev('loop.decision', 131_500, { decision: 'refine winner', historyLength: 2 }),
    ev('loop.plan', 132_000, { roundIndex: 1, plannedCount: 1, moveKind: 'refine', parentIndex: 0, childIndices: [2] }),
    ev('loop.iteration.started', 132_200, { iterationIndex: 2, agentRunName: 'coder', taskHash: 'h2', groupId: 1, parentIndex: 0 }),
    ev('loop.iteration.ended', 150_000, { iterationIndex: 2, agentRunName: 'coder', costUsd: 0.08, durationMs: 17_800, verdict: { valid: true, score: 0.95 } }),
    ev('loop.decision', 150_200, { decision: 'stop', historyLength: 3 }),
    ev('loop.ended', 150_500, { winnerIterationIndex: 2, totalCostUsd: 0.3, durationMs: 50_500, iterations: 3 }),
  ]

  const spans = loopTraceEventsToFlowSpans(JOURNAL)

  it('reconstructs loop → round → iteration nested-by-name', () => {
    expect(spans.map((s) => s.name)).toEqual([
      'loop',
      'loop ▸ round 0 ▸ iter 0 (coder)',
      'loop ▸ round 0 ▸ iter 1 (coder)',
      'loop ▸ round 0 (fanout)',
      'loop ▸ round 1 ▸ iter 2 (coder)',
      'loop ▸ round 1 (refine)',
    ])
    const root = spans[0]!
    expect(root).toMatchObject({ kind: 'pipeline', startMs: 0, endMs: 50_500 })
    expect(root.meta).toMatchObject({ driver: 'fanout-vote', costUsd: 0.3, winnerIterationIndex: 2 })
  })

  it('rounds flush on decision/next-plan and carry move + decision meta', () => {
    const round0 = spans.find((s) => s.name === 'loop ▸ round 0 (fanout)')!
    expect(round0).toMatchObject({ startMs: 500, endMs: 31_500 })
    expect(round0.meta).toMatchObject({ moveKind: 'fanout', width: 2, decision: 'refine winner', rationale: 'explore both' })
    const round1 = spans.find((s) => s.name === 'loop ▸ round 1 (refine)')!
    expect(round1.meta).toMatchObject({ moveKind: 'refine', width: 1, parentIndex: 0, decision: 'stop' })
  })

  it('iterations carry verdict, usage, cost, and surface errors as ok:false', () => {
    const it0 = spans.find((s) => s.name.includes('iter 0'))!
    expect(it0).toMatchObject({ kind: 'model', startMs: 1_000, endMs: 30_000 })
    expect(it0.meta).toMatchObject({ ok: true, verdictValid: true, verdictScore: 0.8, inputTokens: 900, outputTokens: 200, costUsd: 0.1 })
    const it1 = spans.find((s) => s.name.includes('iter 1'))!
    expect(it1.meta).toMatchObject({ ok: false, error: 'build failed' })
  })

  it('tolerates an out-of-order journal (sorts by timestamp)', () => {
    const shuffled = [...JOURNAL].reverse()
    expect(loopTraceEventsToFlowSpans(shuffled)).toEqual(spans)
  })

  it('returns [] for an empty journal', () => {
    expect(loopTraceEventsToFlowSpans([])).toEqual([])
  })
})

describe('composeMissionFlowTrace', () => {
  const T0 = Date.parse('2026-06-12T10:00:00.000Z')
  const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString()

  it('lays out steps with their delegations and renders via renderWaterfall', () => {
    const trace = composeMissionFlowTrace({
      startedAt: T0,
      steps: [
        { id: 's1', intent: 'gather refs', status: 'done', startedAt: T0, durationMs: 40_000 },
        { id: 's2', intent: 'storyboard', status: 'running', startedAt: T0 + 40_000 },
      ],
      activity: {
        s1: [{ taskId: 't1', tool: 'researcher', status: 'completed', detail: 'codec survey', startedAt: iso(2_000), durationMs: 35_000, costUsd: 0.4 }],
        s2: [{ taskId: 't2', tool: 'coder', status: 'completed', detail: 'board gen', startedAt: iso(41_000), durationMs: 20_000, costUsd: 0.25 }],
      },
    })

    expect(trace.spans.map((s) => s.name)).toEqual([
      'gather refs',
      'gather refs ▸ researcher — codec survey',
      'storyboard',
      'storyboard ▸ coder — board gen',
    ])
    expect(trace.toolCalls).toBe(2)
    expect(trace.costUsd).toBeCloseTo(0.65)
    // a step span always covers its delegations' extent
    const s2 = trace.spans.find((s) => s.name === 'storyboard')!
    expect(s2.endMs).toBe(61_000)
    expect(trace.totalMs).toBe(61_000)

    const art = renderWaterfall(trace)
    expect(art).toContain('researcher — codec survey')
    expect(art).toContain('2 tool calls')
  })

  it('infers a sequential layout when step start times are unknown', () => {
    const trace = composeMissionFlowTrace({
      steps: [
        { id: 's1', intent: 'parse script', durationMs: 10_000 },
        { id: 's2', intent: 'schedule', durationMs: 5_000 },
      ],
    })
    expect(trace.spans).toHaveLength(2)
    expect(trace.spans[0]).toMatchObject({ startMs: 0, endMs: 10_000, approx: true })
    expect(trace.spans[1]).toMatchObject({ startMs: 10_000, endMs: 15_000 })
    expect(trace.totalMs).toBe(15_000)
    expect(trace.costUsd).toBeUndefined()
  })
})
