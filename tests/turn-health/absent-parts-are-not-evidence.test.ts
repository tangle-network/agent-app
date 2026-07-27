/**
 * The false page: `dead_tool_surface` fired on tax-agent while the SAME
 * database held 243 `tool_call` frames.
 *
 * Cause, measured on production `tax-filer-db` (`message`, `role='assistant'`):
 *   97 of 156 rows store `parts = '[]'` — every one written before the product
 *      persisted parts at all (they stop at 2026-07-17T02:20Z; the rows that do
 *      carry parts start 02:58Z);
 *   59 of 156 store one `__encrypted_parts__` wrapper (correctly skipped).
 *
 * The 97 satisfied `partsReadable` vacuously — nothing in them FAILED to parse,
 * because there was nothing in them — so the sweep counted them as 97 turns
 * that demonstrably called no tool, and paged. Absence of evidence was read as
 * evidence of absence.
 *
 * These tests pin the three things that must now hold: the empty shape draws no
 * verdict, the real defect is still caught, and a product that stores parts
 * opaquely can buy its way back to a real verdict with `decodeParts`.
 */
import { describe, expect, it } from 'vitest'
import { classifyTurnOutcome } from '../../src/turn-health/classify.js'
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

/** Verbatim production shape: content persisted, parts column literally `[]`. */
const partsLessTurn = { content: 'Here is your answer.', parts: '[]' }
/** Verbatim production shape: the whole array replaced by one opaque wrapper. */
const encryptedTurn = {
  content: 'qCFy+B3T3yW11zBqP5iYgQiEZmOVr1WGUvR92HFjgKo51xSa7A/jgV/wc7QF',
  parts: '[{"type":"__encrypted_parts__","data":"dBQyxPqFy4Tg5L1JEfVztJvzx6M7QUp7"}]',
}
/** A turn that really did answer from context with parts persisted. */
const textTurn = { content: 'Here is your answer.', parts: '[{"type":"text","text":"Here is your answer."}]' }

describe('a row that persisted no parts is not evidence about the tool surface', () => {
  it('does not count an empty parts array as a readable tool observation', () => {
    const verdict = classifyTurnOutcome({ finalText: 'Here is your answer.', parts: [] })
    // Nothing failed to parse...
    expect(verdict.partsReadable).toBe(true)
    // ...but nothing was read either, which is what a tool verdict requires.
    expect(verdict.interpretedParts).toBe(0)
    expect(verdict.toolCalls).toBe(0)
  })

  it('reads one persisted text part as genuine evidence', () => {
    const verdict = classifyTurnOutcome({
      finalText: 'Here is your answer.',
      parts: [{ type: 'text', text: 'Here is your answer.' }],
    })
    expect(verdict.interpretedParts).toBe(1)
  })

  it('does NOT page dead_tool_surface on the production shape (97 parts-less + 59 encrypted)', async () => {
    const sink = recordingSink()
    const result = await sweepSilentFailures({
      product: 'tax-agent',
      source: sourceOf([
        ...Array.from({ length: 97 }, () => partsLessTurn),
        ...Array.from({ length: 59 }, () => encryptedTurn),
      ]),
      sink,
      expectsToolCalls: true,
    })

    expect(result.turnsJudged).toBe(156)
    expect(result.noPartsTurns).toBe(97)
    expect(result.opaquePartsTurns).toBe(59)
    // The denominator the verdict would have used is now honestly zero.
    expect(result.toolReadableTurns).toBe(0)
    expect(sink.alerts.find((a) => a.key.endsWith(':dead_tool_surface'))).toBeUndefined()
  })

  it('says it could not see, instead of saying the surface is dead', async () => {
    const sink = recordingSink()
    await sweepSilentFailures({
      product: 'tax-agent',
      source: sourceOf([
        ...Array.from({ length: 97 }, () => partsLessTurn),
        ...Array.from({ length: 59 }, () => encryptedTurn),
      ]),
      sink,
      expectsToolCalls: true,
    })

    const blind = sink.alerts.find((a) => a.key.endsWith(':tool_surface_unmeasurable'))
    expect(blind).toBeDefined()
    expect(blind?.severity).toBe('warning')
    expect(blind?.details.join('\n')).toContain('97 turn(s) persisted no parts at all')
    expect(blind?.details.join('\n')).toContain('__encrypted_parts__')
    // The reader must not be able to mistake it for the behavioural finding.
    expect(blind?.details.join('\n')).toContain('NOT a dead tool surface finding')
  })

  it('still pages when the parts ARE readable and genuinely carry no tool call', async () => {
    // The detector must keep working — this is the regression that would make
    // the fix a silencer rather than a correction.
    const sink = recordingSink()
    const result = await sweepSilentFailures({
      product: 'filer',
      source: sourceOf(Array.from({ length: 29 }, () => textTurn)),
      sink,
      expectsToolCalls: true,
    })

    expect(result.toolReadableTurns).toBe(29)
    const dead = sink.alerts.find((a) => a.key.endsWith(':dead_tool_surface'))
    expect(dead).toBeDefined()
    expect(dead?.severity).toBe('critical')
  })

  it('does not let parts-less rows pad the denominator of a real finding', async () => {
    // 29 readable tool-free turns still page; the 97 empty rows are named as
    // unjudged rather than counted as corroboration.
    const sink = recordingSink()
    await sweepSilentFailures({
      product: 'filer',
      source: sourceOf([
        ...Array.from({ length: 29 }, () => textTurn),
        ...Array.from({ length: 97 }, () => partsLessTurn),
      ]),
      sink,
      expectsToolCalls: true,
    })

    const dead = sink.alerts.find((a) => a.key.endsWith(':dead_tool_surface'))
    expect(dead?.data?.turnsJudged).toBe(29)
    expect(dead?.data?.noPartsTurns).toBe(97)
    expect(dead?.details.join('\n')).toContain('97 further turn(s) persisted no parts at all')
  })
})

describe('decodeParts restores a real verdict for a product that stores parts opaquely', () => {
  /** Stand-in for tax's wrapper: the array is JSON inside `data`. */
  const wrap = (parts: unknown): string =>
    JSON.stringify([{ type: '__encrypted_parts__', data: JSON.stringify(parts) }])
  const unwrap = (raw: unknown): unknown => {
    const outer = JSON.parse(String(raw))
    const w = outer.find((p: { type?: string }) => p?.type === '__encrypted_parts__')
    return w ? JSON.parse(w.data) : null
  }

  it('counts tool calls the sweep could not otherwise read', async () => {
    const sink = recordingSink()
    const rows = Array.from({ length: 20 }, () => ({
      content: 'ciphertext',
      parts: wrap([
        { type: 'tool', tool: 'submit_tax_citation', state: { status: 'completed', input: {} } },
        { type: 'text', text: 'Filed it.' },
      ]),
    }))

    const result = await sweepSilentFailures({
      product: 'tax-agent',
      source: sourceOf(rows),
      sink,
      expectsToolCalls: true,
      decodeParts: unwrap,
    })

    expect(result.toolCalls).toBe(20)
    expect(result.turnsWithToolCalls).toBe(20)
    expect(result.toolReadableTurns).toBe(20)
    expect(result.opaquePartsTurns).toBe(0)
    expect(sink.alerts.find((a) => a.key.endsWith(':dead_tool_surface'))).toBeUndefined()
    expect(sink.alerts.find((a) => a.key.endsWith(':tool_surface_unmeasurable'))).toBeUndefined()
  })

  it('finds the REAL dead surface once decoding makes it visible', async () => {
    // The point of the seam: a decoded window that truly has no tool call must
    // page. Otherwise decoding would only ever be able to clear an alarm.
    const sink = recordingSink()
    const rows = Array.from({ length: 20 }, () => ({
      content: 'ciphertext',
      parts: wrap([{ type: 'text', text: 'Here is your answer.' }]),
    }))

    await sweepSilentFailures({
      product: 'tax-agent',
      source: sourceOf(rows),
      sink,
      expectsToolCalls: true,
      decodeParts: unwrap,
    })

    expect(sink.alerts.find((a) => a.key.endsWith(':dead_tool_surface'))?.severity).toBe('critical')
  })

  it('reports a throwing decoder as blindness, never as an empty parts array', async () => {
    // A decoder that fails must degrade to "cannot read" (which is reported),
    // not to "read successfully, found nothing" (which is silent and is the
    // exact bug this file exists for).
    const sink = recordingSink()
    const result = await sweepSilentFailures({
      product: 'tax-agent',
      source: sourceOf(Array.from({ length: 20 }, () => encryptedTurn)),
      sink,
      expectsToolCalls: true,
      decodeParts: () => {
        throw new Error('wrong key')
      },
    })

    expect(result.opaquePartsTurns).toBe(20)
    expect(result.noPartsTurns).toBe(0)
    expect(result.toolReadableTurns).toBe(0)
    expect(sink.alerts.find((a) => a.key.endsWith(':dead_tool_surface'))).toBeUndefined()
    expect(sink.alerts.find((a) => a.key.endsWith(':tool_surface_unmeasurable'))).toBeDefined()
  })
})
