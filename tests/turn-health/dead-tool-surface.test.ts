import { describe, expect, it } from 'vitest'
import { classifyTurnOutcome } from '../../src/turn-health/classify.js'
import { createTurnHealthLifecycle } from '../../src/turn-health/lifecycle.js'
import type { AlertSink, TurnHealthAlert } from '../../src/turn-health/sink.js'
import { sweepSilentFailures, type TurnHealthSource } from '../../src/turn-health/sweep.js'

function recordingSink(): AlertSink & { alerts: TurnHealthAlert[] } {
  const alerts: TurnHealthAlert[] = []
  return {
    alerts,
    async deliver(alert) {
      alerts.push(alert)
    },
  }
}

/** A source with no unanswered threads, so these tests isolate the turn lanes. */
function sourceOf(rows: Array<{ content: string; parts: unknown }>): TurnHealthSource {
  return {
    async findUnansweredThreads() {
      return []
    },
    async listRecentAssistantTurns() {
      return rows.map((r, i) => ({
        id: `m${i}`,
        threadId: `t${i}`,
        content: r.content,
        parts: r.parts,
        outputTokens: 10,
        createdAt: 0,
      }))
    },
  }
}

const textTurn = { content: 'Here is your answer.', parts: '[{"type":"text","text":"Here is your answer."}]' }
const toolTurn = {
  content: 'Filed it.',
  parts: '[{"type":"tool","tool":"submit","state":{"status":"completed","input":{}}},{"type":"text","text":"Filed it."}]',
}

describe('shape (d): a session that never called a tool at all', () => {
  it('counts tool calls per turn without calling zero a per-turn defect', () => {
    // A single tool-free turn is normal. The classifier reports the COUNT and
    // stays healthy; only the window can judge.
    const verdict = classifyTurnOutcome({
      finalText: 'Sure, here is what I think.',
      parts: [{ type: 'text', text: 'Sure, here is what I think.' }],
    })
    expect(verdict.healthy).toBe(true)
    expect(verdict.toolCalls).toBe(0)
  })

  it('pages when a tool-declaring product produced ZERO tool calls across the window', async () => {
    // The tax-agent shape, at its measured production ratio: fluent prose on
    // every turn, not one tool call anywhere, every other detector green.
    const sink = recordingSink()
    const result = await sweepSilentFailures({
      product: 'tax-agent',
      source: sourceOf(Array.from({ length: 29 }, () => textTurn)),
      sink,
      expectsToolCalls: true,
    })

    expect(result.turnsJudged).toBe(29)
    expect(result.toolCalls).toBe(0)
    expect(result.emptyCompletions).toBe(0)
    expect(result.unhealthyTurns).toBe(0)

    const dead = sink.alerts.find((a) => a.key.endsWith(':dead_tool_surface'))
    expect(dead).toBeDefined()
    expect(dead?.severity).toBe('critical')
    expect(dead?.title).toContain('ZERO tool calls across 29 turns')
  })

  it('stays silent when the tool surface is alive', async () => {
    const sink = recordingSink()
    const rows = [...Array.from({ length: 28 }, () => textTurn), toolTurn]
    const result = await sweepSilentFailures({
      product: 'tax-agent',
      source: sourceOf(rows),
      sink,
      expectsToolCalls: true,
    })
    expect(result.toolCalls).toBe(1)
    expect(result.turnsWithToolCalls).toBe(1)
    expect(sink.alerts.filter((a) => a.key.endsWith(':dead_tool_surface'))).toHaveLength(0)
  })

  it('stays silent for a product that does not declare a tool deliverable', async () => {
    const sink = recordingSink()
    await sweepSilentFailures({
      product: 'copilot',
      source: sourceOf(Array.from({ length: 29 }, () => textTurn)),
      sink,
    })
    expect(sink.alerts.filter((a) => a.key.endsWith(':dead_tool_surface'))).toHaveLength(0)
  })

  it('does not page on a window too small to mean anything', async () => {
    const sink = recordingSink()
    await sweepSilentFailures({
      product: 'tax-agent',
      source: sourceOf([textTurn, textTurn]),
      sink,
      expectsToolCalls: true,
    })
    expect(sink.alerts.filter((a) => a.key.endsWith(':dead_tool_surface'))).toHaveLength(0)
  })
})

describe('shape (d), live lane: a gate answered instead of the model', () => {
  it('reports a gated turn as answered-without-model, not as a blank completion', () => {
    const verdict = classifyTurnOutcome({ finalText: '', gated: true })
    expect(verdict.reasons.map((r) => r.kind)).toEqual(['answered_without_model'])
    // The critical distinction: a gated turn must never be reported as the
    // blank-completion shape, or every healthy intake turn pages.
    expect(verdict.reasons.some((r) => r.kind === 'empty_completion')).toBe(false)
    expect(verdict.severity).toBe('warning')
  })

  it('counts every gated turn but pages on none by default', async () => {
    const sink = recordingSink()
    const seen: string[][] = []
    const lifecycle = createTurnHealthLifecycle({
      product: 'tax-agent',
      sink,
      onVerdict: (v) => seen.push(v.kinds),
    })
    await lifecycle.onTurnComplete({ finalText: '', durationMs: 12, gated: true })
    expect(seen).toEqual([['answered_without_model']])
    expect(sink.alerts).toHaveLength(0)
  })

  it('pages on a gated turn when the product opts in', async () => {
    const sink = recordingSink()
    const lifecycle = createTurnHealthLifecycle({
      product: 'tax-agent',
      sink,
      alertOnGatedTurn: true,
    })
    await lifecycle.onTurnComplete({ finalText: '', durationMs: 12, gated: true })
    expect(sink.alerts).toHaveLength(1)
    expect(sink.alerts[0]?.details[0]).toContain('the model never ran')
  })

  it('still pages on a genuinely blank turn when gating is off', async () => {
    const sink = recordingSink()
    const lifecycle = createTurnHealthLifecycle({ product: 'tax-agent', sink })
    await lifecycle.onTurnComplete({ finalText: '', durationMs: 12 })
    expect(sink.alerts).toHaveLength(1)
    expect(sink.alerts[0]?.severity).toBe('critical')
  })
})

describe('the detector reporting on its own blindness', () => {
  // tax-agent encrypts `parts` at rest under its own convention. Every rule in
  // the classifier would otherwise read "no text, no artifact, no tool" off
  // ciphertext and call it a blank completion — or worse, call the product
  // healthy.
  // The REAL production row: ciphertext in `content` AND an encrypted `parts`
  // blob. The turn plainly delivered something, so it is not an empty
  // completion — but its tool calls are invisible.
  const encrypted = {
    content: 'k7HcQ2+bd0RaOHWkPWQU+xbxo7Cwea6Nq72WYGxGsrnhWWNYox1',
    parts: '[{"type":"__encrypted_parts__","data":"ECMcSVp98g9my0PL0j6r56ntIDv"}]',
  }
  /** The harder case: nothing readable at all. */
  const fullyOpaque = { content: '', parts: encrypted.parts }

  it('marks a turn it cannot interpret as unreadable, not as empty', () => {
    const verdict = classifyTurnOutcome({ finalText: '', parts: [{ type: '__encrypted_parts__', data: 'x' }] })
    expect(verdict.unreadable).toBe(true)
    expect(verdict.reasons.map((r) => r.kind)).toEqual(['unreadable_turn'])
    expect(verdict.reasons.some((r) => r.kind === 'empty_completion')).toBe(false)
  })

  it('does NOT call a reasoning-only turn unreadable — that is a real empty completion', () => {
    // `reasoning` is a part type this module knows. A turn that thought and
    // said nothing is broken, and must not hide behind the blindness report.
    const verdict = classifyTurnOutcome({
      finalText: '',
      parts: [{ type: 'reasoning', text: 'thinking about it' }],
    })
    expect(verdict.unreadable).toBe(false)
    expect(verdict.reasons.map((r) => r.kind)).toEqual(['empty_completion'])
  })

  it('reports blindness instead of certifying an opaque product healthy', async () => {
    const sink = recordingSink()
    const result = await sweepSilentFailures({
      product: 'tax-agent',
      source: sourceOf(Array.from({ length: 20 }, () => encrypted)),
      sink,
      expectsToolCalls: true,
    })

    // Not one of these rows was empty — they were unreadable, and the sweep
    // must not confuse the two.
    expect(result.emptyCompletions).toBe(0)
    expect(result.unhealthyTurns).toBe(0)

    const blind = sink.alerts.find((a) => a.key.endsWith(':detector_blind'))
    expect(blind).toBeDefined()
    expect(blind?.details[0]).toContain('__encrypted_parts__')
    expect(blind?.data?.opaquePartsTurns).toBe(20)
    // THE point of the flag: it must NOT declare a dead tool surface from rows
    // whose tool calls it could not see. Claiming that finding would be the
    // same crime as claiming health.
    expect(sink.alerts.filter((a) => a.key.endsWith(':dead_tool_surface'))).toHaveLength(0)
  })

  it('never divides the empty-completion rate by rows it could not read', async () => {
    // 10 judgeable turns, 6 of them blank, plus 30 fully-opaque rows. The honest
    // rate is 6/10 = 60%, not 6/40 = 15% — encrypted padding must not be able to
    // dilute a real regression below the threshold.
    const blank = { content: '', parts: '[]' }
    const rows = [
      ...Array.from({ length: 6 }, () => blank),
      ...Array.from({ length: 4 }, () => textTurn),
      ...Array.from({ length: 30 }, () => fullyOpaque),
    ]
    const sink = recordingSink()
    const result = await sweepSilentFailures({ product: 'tax-agent', source: sourceOf(rows), sink })
    expect(result.unreadableTurns).toBe(30)
    const rateAlert = sink.alerts.find((a) => a.key.endsWith(':empty_completion_rate'))
    expect(rateAlert?.data?.rate).toBeCloseTo(0.6, 5)
    expect(rateAlert?.data?.turnsJudged).toBe(10)
  })
})
