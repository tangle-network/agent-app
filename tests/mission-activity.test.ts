import { describe, expect, it } from 'vitest'

import {
  activityTone,
  formatActivityCost,
  formatActivityDuration,
  mergeActivityPages,
  waterfallLayout,
  type AgentActivityRecord,
} from '../src/web-react/mission-activity'
import { stepActivityFlowTrace } from '../src/trace/index'

// The pure logic under the two observability surfaces. The components are thin
// shells over these helpers — tone mapping, page merging, bar geometry — so
// the contract is provable without a DOM.

const T0 = Date.parse('2026-06-12T10:00:00.000Z')
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString()

function record(over: Partial<AgentActivityRecord> & { taskId: string }): AgentActivityRecord {
  return {
    tool: 'coder',
    status: 'completed',
    detail: 'work',
    startedAt: iso(0),
    ...over,
  }
}

describe('activityTone', () => {
  it('maps wire statuses to render tones, case-insensitively', () => {
    expect(activityTone('running')).toBe('live')
    expect(activityTone('pending')).toBe('live')
    expect(activityTone('completed')).toBe('ok')
    expect(activityTone('Failed')).toBe('error')
    expect(activityTone('cancelled')).toBe('error')
    expect(activityTone('queued_for_approval')).toBe('neutral')
  })
})

describe('formatters', () => {
  it('cost: 4 decimals under a cent, 2 above, null when unknown/zero', () => {
    expect(formatActivityCost(0.0042)).toBe('$0.0042')
    expect(formatActivityCost(1.5)).toBe('$1.50')
    expect(formatActivityCost(0)).toBeNull()
    expect(formatActivityCost(undefined)).toBeNull()
  })

  it('duration: seconds, minutes, hours; null when unknown', () => {
    expect(formatActivityDuration(8_000)).toBe('8s')
    expect(formatActivityDuration(125_000)).toBe('2m 05s')
    expect(formatActivityDuration(4_320_000)).toBe('1h 12m')
    expect(formatActivityDuration(undefined)).toBeNull()
  })
})

describe('mergeActivityPages (cursor + refresh convergence)', () => {
  it('dedupes by taskId with the incoming snapshot winning, newest first', () => {
    const held = [
      record({ taskId: 't1', status: 'running', startedAt: iso(10_000) }),
      record({ taskId: 't2', startedAt: iso(0) }),
    ]
    const refreshed = [record({ taskId: 't1', status: 'completed', costUsd: 0.2, startedAt: iso(10_000) })]
    const merged = mergeActivityPages(held, refreshed)
    expect(merged.map((r) => r.taskId)).toEqual(['t1', 't2'])
    expect(merged[0]?.status).toBe('completed')
    expect(merged[0]?.costUsd).toBe(0.2)
  })

  it('appends an older cursor page without disturbing held rows', () => {
    const held = [record({ taskId: 't3', startedAt: iso(30_000) })]
    const olderPage = [record({ taskId: 't1', startedAt: iso(0) }), record({ taskId: 't2', startedAt: iso(10_000) })]
    expect(mergeActivityPages(held, olderPage).map((r) => r.taskId)).toEqual(['t3', 't2', 't1'])
  })

  it('is idempotent: re-merging the same page converges', () => {
    const page = [record({ taskId: 't1' }), record({ taskId: 't2', startedAt: iso(5_000) })]
    const once = mergeActivityPages([], page)
    expect(mergeActivityPages(once, page)).toEqual(once)
  })
})

describe('waterfallLayout (bar geometry)', () => {
  it('projects spans to offset/width percentages of the total', () => {
    const trace = stepActivityFlowTrace([
      record({ taskId: 't1', startedAt: iso(0), durationMs: 30_000 }),
      record({ taskId: 't2', startedAt: iso(30_000), durationMs: 10_000, status: 'failed' }),
    ])
    const rows = waterfallLayout(trace)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ offsetPct: 0, widthPct: 75, ok: true, durationLabel: '30.0s' })
    expect(rows[1]).toMatchObject({ offsetPct: 75, widthPct: 25, ok: false })
  })

  it('clamps a zero-length span to a visible sliver and flags approx', () => {
    const trace = stepActivityFlowTrace([
      record({ taskId: 't1', startedAt: iso(0), durationMs: 60_000 }),
      record({ taskId: 't2', status: 'running', startedAt: iso(59_000), durationMs: undefined }),
    ])
    const sliver = waterfallLayout(trace)[1]!
    expect(sliver.widthPct).toBe(0.5)
    expect(sliver.approx).toBe(true)
    expect(sliver.durationLabel).toBe('0.0s~')
  })

  it('orders rows by start time regardless of span order in the trace', () => {
    const rows = waterfallLayout({
      spans: [
        { kind: 'tool', name: 'late', startMs: 5_000, endMs: 6_000 },
        { kind: 'pipeline', name: 'early', startMs: 0, endMs: 6_000 },
      ],
      totalMs: 6_000,
      promptTokens: 0,
      completionTokens: 0,
      toolCalls: 1,
    })
    expect(rows.map((r) => r.name)).toEqual(['early', 'late'])
  })
})

describe('stepActivityFlowTrace (lane → drill-in trace)', () => {
  it('origins at the earliest run, sums cost, counts delegations', () => {
    const trace = stepActivityFlowTrace([
      record({ taskId: 't2', startedAt: iso(5_000), durationMs: 10_000, costUsd: 0.1 }),
      record({ taskId: 't1', startedAt: iso(0), durationMs: 30_000, costUsd: 0.25 }),
    ])
    expect(trace.toolCalls).toBe(2)
    expect(trace.costUsd).toBeCloseTo(0.35)
    expect(trace.totalMs).toBe(30_000)
    // positioned relative to the earliest run (t1 at offset 0)
    expect(trace.spans.find((s) => s.meta?.taskId === 't2')?.startMs).toBe(5_000)
  })

  it('extends an in-flight run to nowMs', () => {
    const trace = stepActivityFlowTrace(
      [record({ taskId: 't1', status: 'running', startedAt: iso(0) })],
      { nowMs: T0 + 42_000 },
    )
    expect(trace.spans[0]).toMatchObject({ startMs: 0, endMs: 42_000, approx: true })
    expect(trace.totalMs).toBe(42_000)
  })
})
