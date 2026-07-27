import { describe, expect, it, vi } from 'vitest'
import { classifyTurnOutcome } from '../../src/turn-health/classify.js'
import { createTurnHealthLifecycle } from '../../src/turn-health/lifecycle.js'
import {
  type AlertSink,
  createThrottledAlertSink,
  createWebhookAlertSink,
  type TurnHealthAlert,
} from '../../src/turn-health/sink.js'
import {
  createD1TurnHealthSource,
  sweepSilentFailures,
  type TurnHealthSource,
} from '../../src/turn-health/sweep.js'

/** Collects delivered alerts. */
function recordingSink(): AlertSink & { alerts: TurnHealthAlert[] } {
  const alerts: TurnHealthAlert[] = []
  return {
    alerts,
    async deliver(alert) {
      alerts.push(alert)
    },
  }
}

describe('classifyTurnOutcome — the three measured production shapes', () => {
  it('flags the verbatim blank-completion capture', () => {
    // Copied from a real production event:
    // {"type":"result","data":{"outcome":{"type":"completed"},
    //  "finalText":"","tokenUsage":{"outputTokens":0}}}
    const verdict = classifyTurnOutcome({
      finalText: '',
      parts: [],
      outputTokens: 0,
      durationMs: 340_000,
    })

    expect(verdict.healthy).toBe(false)
    expect(verdict.severity).toBe('critical')
    expect(verdict.reasons).toEqual([
      { kind: 'empty_completion', outputTokens: 0, partCount: 0, durationMs: 340_000 },
    ])
  })

  it('flags the agent-runtime #626 collapsed parallel tool call', () => {
    // The real failure: six `submit_proposal` calls, each emitted complete with
    // a distinct id and NO index, collapsed into one accumulator so their
    // `arguments` JSON concatenated into an unparseable string.
    const collapsed = Array.from(
      { length: 6 },
      (_, i) => `{"title":"Proposal ${i}","body":"body ${i}"}`,
    ).join('')

    const verdict = classifyTurnOutcome({
      finalText: '',
      parts: [
        {
          type: 'tool',
          id: 'call_0',
          tool: 'submit_proposal',
          state: { status: 'completed', input: collapsed },
        },
      ],
    })

    expect(verdict.healthy).toBe(false)
    const malformed = verdict.reasons.find((r) => r.kind === 'malformed_tool_call')
    expect(malformed).toBeDefined()
    expect(malformed).toMatchObject({ kind: 'malformed_tool_call', tool: 'submit_proposal' })
    // The concatenation is genuinely unparseable — the premise of the detector.
    expect(() => JSON.parse(collapsed)).toThrow()
    // And the turn also delivered nothing to the user.
    expect(verdict.reasons.some((r) => r.kind === 'empty_completion')).toBe(true)
  })

  it('flags a tool call that never reached a settled state', () => {
    const verdict = classifyTurnOutcome({
      finalText: 'working on it',
      parts: [
        {
          type: 'tool',
          id: 'call_1',
          tool: 'submit_proposal',
          state: { status: 'running', input: { title: 'ok' } },
        },
      ],
    })

    expect(verdict.reasons).toContainEqual({
      kind: 'tool_call_no_effect',
      tool: 'submit_proposal',
      status: 'running',
    })
    // Readable text was still delivered, so this degrades rather than pages.
    expect(verdict.severity).toBe('warning')
  })

  it('flags an explicit failure and carries the reason', () => {
    // The exact text gtm customers received for sixteen days.
    const verdict = classifyTurnOutcome({
      failed: true,
      failureReason: 'All 2 model(s) failed. gpt-5-mini: TANGLE_HUB_URL is required',
      finalText: '',
    })
    expect(verdict.severity).toBe('critical')
    expect(verdict.reasons[0]).toMatchObject({ kind: 'turn_failed' })
  })

  it('passes a healthy turn with text and a well-formed tool call', () => {
    const verdict = classifyTurnOutcome({
      finalText: 'Here are the six proposals.',
      parts: [
        { type: 'text', text: 'Here are the six proposals.' },
        {
          type: 'tool',
          id: 'c1',
          tool: 'submit_proposal',
          state: { status: 'completed', input: { title: 'A' }, output: { ok: true } },
        },
      ],
      outputTokens: 412,
    })
    expect(verdict.healthy).toBe(true)
    expect(verdict.severity).toBeNull()
  })

  it('passes a turn that produced an artifact but no prose', () => {
    // A file/work-product IS delivery. Treating it as empty would page on
    // every legitimate document-producing turn.
    const verdict = classifyTurnOutcome({
      finalText: '',
      parts: [{ type: 'file', filename: 'return.pdf' }],
    })
    expect(verdict.healthy).toBe(true)
  })

  it('never throws on a corrupt parts blob', () => {
    expect(() =>
      classifyTurnOutcome({ finalText: 'x', parts: [null, 'nonsense', 42, { type: 'tool' }] }),
    ).not.toThrow()
  })
})

describe('sweepSilentFailures — the outage no per-turn hook can see', () => {
  /** Source mirroring gtm-agent's measured state: many pending, nothing out. */
  function outageSource(): TurnHealthSource {
    return {
      async findUnansweredThreads() {
        return [
          { threadId: 't1', pendingMessages: 21, oldestAgeMs: 16 * 24 * 3_600_000 },
          { threadId: 't2', pendingMessages: 18, oldestAgeMs: 12 * 24 * 3_600_000 },
        ]
      },
      async listRecentAssistantTurns() {
        return []
      },
    }
  }

  it('passes the abandonment window down so an ancient backlog stops paging', async () => {
    // gtm's table holds 384 unanswered messages whose oldest is 1,676h old.
    // Paging hourly on a backlog nobody will ever answer is how a channel gets
    // muted — and a muted channel is the state this module exists to escape.
    let seen: { minAgeMs: number; maxAgeMs: number } | null = null
    const sink = recordingSink()
    await sweepSilentFailures({
      product: 'gtm-agent',
      source: {
        async findUnansweredThreads(input) {
          seen = { minAgeMs: input.minAgeMs, maxAgeMs: input.maxAgeMs }
          return []
        },
        async listRecentAssistantTurns() {
          return []
        },
      },
      sink,
      now: 1_800_000_000_000,
    })
    expect(seen).toEqual({ minAgeMs: 15 * 60_000, maxAgeMs: 7 * 24 * 3_600_000 })
    expect(sink.alerts).toHaveLength(0)
  })

  it('pages on threads accumulating unanswered user messages', async () => {
    const sink = recordingSink()
    const result = await sweepSilentFailures({
      product: 'gtm-agent',
      source: outageSource(),
      sink,
      now: 1_800_000_000_000,
    })

    expect(result.unansweredThreads).toBe(2)
    expect(result.pendingUserMessages).toBe(39)
    expect(sink.alerts).toHaveLength(1)
    expect(sink.alerts[0]!.severity).toBe('critical')
    expect(sink.alerts[0]!.title).toContain('39 user message(s) unanswered')
  })

  it('does NOT count a blank assistant row as an answer', async () => {
    // The predicate that decides whether this catches the outage or sleeps
    // through it: during the outage the message table was not empty, it was
    // full of blank/error assistant rows.
    const sink = recordingSink()
    const result = await sweepSilentFailures({
      product: 'gtm-agent',
      source: {
        async findUnansweredThreads() {
          return [{ threadId: 't1', pendingMessages: 5, oldestAgeMs: 3 * 3_600_000 }]
        },
        async listRecentAssistantTurns() {
          // Twelve settled turns, every one blank — a product that looks busy.
          return Array.from({ length: 12 }, (_, i) => ({
            id: `m${i}`,
            threadId: 't1',
            content: '',
            parts: '[]',
            outputTokens: 0,
            createdAt: 1_800_000_000_000,
          }))
        },
      },
      sink,
      now: 1_800_000_000_000,
    })

    expect(result.emptyCompletions).toBe(12)
    expect(result.unhealthyTurns).toBe(12)
    const rateAlert = sink.alerts.find((a) => a.key.endsWith('empty_completion_rate'))
    expect(rateAlert).toBeDefined()
    expect(rateAlert!.title).toContain('100.0% of turns completed with no output')
  })

  it('pages on the FIRST malformed tool call, at any rate', async () => {
    const sink = recordingSink()
    const result = await sweepSilentFailures({
      product: 'legal-agent',
      source: {
        async findUnansweredThreads() {
          return []
        },
        async listRecentAssistantTurns() {
          return [
            {
              id: 'm1',
              threadId: 't1',
              content: 'done',
              parts: JSON.stringify([
                {
                  type: 'tool',
                  id: 'c1',
                  tool: 'submit_proposal',
                  state: { status: 'completed', input: '{"a":1}{"b":2}' },
                },
              ]),
              outputTokens: 50,
              createdAt: 1_800_000_000_000,
            },
          ]
        },
      },
      sink,
      now: 1_800_000_000_000,
    })

    expect(result.malformedToolCalls).toBe(1)
    const alert = sink.alerts.find((a) => a.key.endsWith('malformed_tool_call'))
    expect(alert).toBeDefined()
    expect(alert!.severity).toBe('critical')
    expect(alert!.title).toContain('deliverables silently dropped')
  })

  it('stays quiet when the product is healthy', async () => {
    const sink = recordingSink()
    const result = await sweepSilentFailures({
      product: 'tax-agent',
      source: {
        async findUnansweredThreads() {
          return []
        },
        async listRecentAssistantTurns() {
          return Array.from({ length: 20 }, (_, i) => ({
            id: `m${i}`,
            threadId: 't1',
            content: 'a real answer',
            parts: JSON.stringify([{ type: 'text', text: 'a real answer' }]),
            outputTokens: 120,
            createdAt: 1_800_000_000_000,
          }))
        },
      },
      sink,
      now: 1_800_000_000_000,
    })

    expect(result.unhealthyTurns).toBe(0)
    expect(sink.alerts).toHaveLength(0)
  })

  it('does not compute a rate from too few turns', async () => {
    const sink = recordingSink()
    await sweepSilentFailures({
      product: 'workcomp-agent',
      source: {
        async findUnansweredThreads() {
          return []
        },
        async listRecentAssistantTurns() {
          return [
            {
              id: 'm1',
              threadId: 't1',
              content: '',
              parts: '[]',
              outputTokens: 0,
              createdAt: 1_800_000_000_000,
            },
          ]
        },
      },
      sink,
      now: 1_800_000_000_000,
    })
    expect(sink.alerts.find((a) => a.key.endsWith('empty_completion_rate'))).toBeUndefined()
  })
})

describe('createD1TurnHealthSource — an error row is not an answer', () => {
  /** Records the SQL and the bound parameters. */
  function recordingDb() {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    return {
      calls,
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            calls.push({ sql, params })
            return { async all() { return { results: [] } } }
          },
        }
      },
    }
  }

  it('binds each error prefix as a parameter, never into the SQL text', async () => {
    // The row that fooled the first version of this detector, verbatim from
    // gtm production on 2026-07-27 — 246 chars of prose that answers nothing:
    // "The sandbox model stream stopped before a clean completion. Error:
    //  All 2 model(s) failed. gpt-5-mini: TANGLE_HUB_URL is required …"
    const db = recordingDb()
    const source = createD1TurnHealthSource(db, {
      errorReplyPrefixes: ["The sandbox model stream stopped", "All 2 model(s) failed"],
    })
    await source.findUnansweredThreads({ minAgeMs: 60_000, maxAgeMs: 600_000, now: 1_800_000_000_000 })

    const call = db.calls[0]!
    // Two NOT LIKE terms, and the prose is in the PARAMS, not the SQL.
    expect(call.sql.match(/NOT LIKE/g)).toHaveLength(2)
    expect(call.sql).not.toContain('sandbox model stream stopped')
    expect(call.params.slice(2)).toEqual([
      'The sandbox model stream stopped',
      'All 2 model(s) failed',
    ])
  })

  it('emits no error clause when the product supplies none', async () => {
    const db = recordingDb()
    const source = createD1TurnHealthSource(db)
    await source.findUnansweredThreads({ minAgeMs: 60_000, maxAgeMs: 600_000, now: 1_800_000_000_000 })
    const call = db.calls[0]!
    expect(call.sql).not.toContain('NOT LIKE')
    expect(call.params).toHaveLength(2)
  })

  it('refuses an unsafe table identifier', () => {
    expect(() => createD1TurnHealthSource(recordingDb(), { messageTable: 'message; DROP TABLE x' }))
      .toThrow(/unsafe table identifier/)
  })
})

describe('alert routing', () => {
  it('collapses an alert storm to one message per window', async () => {
    // 384 pending messages is one incident, not 384 pages.
    const inner = recordingSink()
    const throttled = createThrottledAlertSink(inner, { windowMs: 3_600_000 })
    const base = {
      product: 'gtm-agent',
      severity: 'critical' as const,
      key: 'turn:gtm-agent:empty_completion',
      title: 'blank',
      details: [],
    }

    for (let i = 0; i < 384; i += 1) {
      await throttled.deliver({ ...base, at: 1_800_000_000_000 + i * 1_000 })
    }
    expect(inner.alerts).toHaveLength(1)

    // But an incident still burning after the window re-pages. Going
    // permanently silent after one message is how 17 days stay invisible.
    await throttled.deliver({ ...base, at: 1_800_000_000_000 + 3_700_000 })
    expect(inner.alerts).toHaveLength(2)
  })

  it('posts the ops-webhook body and raises when the webhook rejects', async () => {
    const calls: Array<{ url: string; body: string }> = []
    const sink = createWebhookAlertSink({
      webhookUrl: 'https://hooks.example/T/B/X',
      fetchImpl: async (url, init) => {
        calls.push({ url, body: init.body })
        return { ok: true, status: 200 }
      },
    })
    await sink.deliver({
      product: 'gtm-agent',
      severity: 'critical',
      key: 'k',
      title: 'gtm-agent: turn delivered nothing',
      details: ['completed with NO output'],
      at: 1_800_000_000_000,
    })
    expect(calls).toHaveLength(1)
    const body = JSON.parse(calls[0]!.body) as { text: string }
    expect(body.text).toContain('gtm-agent: turn delivered nothing')
    expect(body.text).toContain(':rotating_light:')

    const failing = createWebhookAlertSink({
      webhookUrl: 'https://hooks.example/T/B/X',
      fetchImpl: async () => ({ ok: false, status: 500 }),
    })
    // A dropped alert is a silent failure of the detector itself.
    await expect(
      failing.deliver({
        product: 'p',
        severity: 'critical',
        key: 'k',
        title: 't',
        details: [],
        at: 1,
      }),
    ).rejects.toThrow('alert webhook responded 500')
  })
})

describe('createTurnHealthLifecycle — the live lane', () => {
  it('pages when a turn settles blank, and stays silent when it does not', async () => {
    const sink = recordingSink()
    const lifecycle = createTurnHealthLifecycle({ product: 'tax-agent', sink })

    await lifecycle.onTurnComplete({
      finalText: '',
      usage: { outputTokens: 0 },
      durationMs: 303_000,
      threadId: 'thread-1',
      executionId: 'exec-1',
    })
    expect(sink.alerts).toHaveLength(1)
    expect(sink.alerts[0]!.data).toMatchObject({ threadId: 'thread-1', turnId: 'exec-1' })

    await lifecycle.onTurnComplete({
      finalText: 'a real answer',
      usage: { outputTokens: 120 },
      durationMs: 4_000,
    })
    expect(sink.alerts).toHaveLength(1)
  })

  it('reports a turn error without ever failing the turn', async () => {
    const exploding: AlertSink = {
      async deliver() {
        throw new Error('webhook down')
      },
    }
    const onError = vi.fn()
    const lifecycle = createTurnHealthLifecycle({
      product: 'gtm-agent',
      sink: { deliver: async (a) => exploding.deliver(a) },
    })
    // Telemetry that can crash the turn it measures is worse than none.
    await expect(
      lifecycle.onTurnError({ error: new Error('TANGLE_HUB_URL is required'), durationMs: 12 }),
    ).resolves.toBeUndefined()
    expect(onError).not.toHaveBeenCalled()
  })
})
