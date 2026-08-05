import { describe, expect, it, vi } from 'vitest'

import {
  classifyTerminalFailure,
  createSandboxChatProducer,
  isCommittingSandboxEvent,
  MAX_EMPTY_TURN_RETRIES,
  runDetachedTurn,
  streamWithModelFailover,
  type AssistantDraftStore,
  type EmptyTurnRetryInfo,
} from '../../src/chat-routes/index'
import { ModelFailoverExhaustedError } from '../../src/model-resolution/failover'
import { createMemoryTurnEventStore } from '../../src/stream/index'

/**
 * The VERBATIM event sequence a real box emitted for a model whose upstream
 * cannot serve (sandbox.tangle.tools, box sandbox-0c3fb8817ac8, 2026-07-26,
 * opencode backend with `backend.model` → the router). Captured, not invented:
 * the failure arrives as a RESOLVED terminal `error` event — the stream never
 * throws — and NINE inert events precede it. Any of those nine committing
 * would pin the turn to the dead model and kill the failover.
 */
const DEAD_MODEL_SEQUENCE: Array<Record<string, unknown>> = [
  { type: 'start', data: { id: '9611bb99-dd1d-4bca-af1c-2179f1b8bbaa', identifier: 'default', created_at: 1785088487 }, id: '578' },
  { type: 'execution.started', data: { executionId: '9611bb99-dd1d-4bca-af1c-2179f1b8bbaa', sessionId: 'capture-dead-1785088486531', timestamp: 1785088487405 }, id: '579' },
  { type: 'status', data: { status: 'generating_response' }, id: '580' },
  { type: 'status', data: { status: 'started' }, id: '581' },
  { type: 'status', data: { status: 'processing', detail: 'Sending prompt to model' }, id: '582' },
  { type: 'session.updated', data: { sessionId: 'ses_0606f500fffeGzTTfS5Xm8D6G3', sessionID: 'ses_0606f500fffeGzTTfS5Xm8D6G3', title: 'New session - 2026-07-26T17:54:47.408Z' }, id: '583' },
  { type: 'session.updated', data: { sessionId: 'ses_0606f500fffeGzTTfS5Xm8D6G3', sessionID: 'ses_0606f500fffeGzTTfS5Xm8D6G3', title: 'New session - 2026-07-26T17:54:47.408Z' }, id: '584' },
  { type: 'warning', data: { code: 'OPENCODE_PROVIDER_RETRY', message: 'Model provider is retrying after Model "definitely-not-a-model-xyz" is not currently available..' }, id: '585' },
  { type: 'warning', data: { code: 'OPENCODE_PROVIDER_RETRY', message: 'Model provider is retrying after Model "definitely-not-a-model-xyz" is not currently available..' }, id: '586' },
  {
    type: 'error',
    data: {
      message:
        'OpenCode provider inference is unavailable for openai-compat/definitely-not-a-model-xyz: Model "definitely-not-a-model-xyz" is not currently available.. Session: ses_0606f500fffeGzTTfS5Xm8D6G3.',
      requestId: '9611bb99-dd1d-4bca-af1c-2179f1b8bbaa',
      code: 'provider_inference_unavailable',
    },
    id: '587',
  },
  { type: 'done', data: { requestId: '9611bb99-dd1d-4bca-af1c-2179f1b8bbaa' }, id: '588' },
]

/** The VERBATIM healthy sequence (`gpt-5-mini`) from the same box, abridged to
 *  the shape-bearing events. Note the platform opens the text part with
 *  `text: ""` BEFORE the first token — that empty part must not commit. */
const HEALTHY_MODEL_SEQUENCE: Array<Record<string, unknown>> = [
  { type: 'start', data: { id: '11e5f96e-98d3-4a0e-aa1b-e076ced7a449', identifier: 'default', created_at: 1785088512 }, id: '589' },
  { type: 'execution.started', data: { executionId: '11e5f96e-98d3-4a0e-aa1b-e076ced7a449', sessionId: 'capture-gpt-5-mini-1785088511766', timestamp: 1785088512859 }, id: '590' },
  { type: 'status', data: { status: 'generating_response' }, id: '591' },
  { type: 'session.updated', data: { sessionId: 'ses_0606eec9affe1brmDUiMIyvaX4', sessionID: 'ses_0606eec9affe1brmDUiMIyvaX4' }, id: '594' },
  { type: 'message.part.updated', data: { part: { id: 'prt_f9f911ac5001DE5xRJwv1B3R2x', messageID: 'msg_f9f91139f001yMwSGCTIAUsriP', sessionID: 'ses_0606eec9affe1brmDUiMIyvaX4', type: 'step-start' } }, id: '596' },
  { type: 'message.part.updated', data: { part: { id: 'prt_f9f911ade001WYaJ1E6wO9KfEP', messageID: 'msg_f9f91139f001yMwSGCTIAUsriP', sessionID: 'ses_0606eec9affe1brmDUiMIyvaX4', type: 'text', text: '' } }, id: '597' },
  { type: 'model-processing', data: { phase: 'generating' }, id: '598' },
  { type: 'message.part.updated', data: { part: { id: 'prt_f9f911ade001WYaJ1E6wO9KfEP', messageID: 'msg_f9f91139f001yMwSGCTIAUsriP', sessionID: 'ses_0606eec9affe1brmDUiMIyvaX4', type: 'text', text: 'ok' }, delta: 'ok' }, id: '599' },
  { type: 'message.part.updated', data: { part: { id: 'prt_f9f911ae3001PNMPkKh8IjaLO8', reason: 'stop', messageID: 'msg_f9f91139f001yMwSGCTIAUsriP', type: 'step-finish', tokens: { total: 13954, input: 1144, output: 10, reasoning: 0, cache: { write: 0, read: 12800 } }, cost: 0 } }, id: '601' },
  {
    type: 'result',
    data: {
      outcome: { type: 'completed' },
      finalText: 'ok',
      toolInvocations: [],
      metadata: { sessionId: 'ses_0606eec9affe1brmDUiMIyvaX4', backendType: 'sdk', domains: [], agentIdentifier: 'default' },
      tokenUsage: { inputTokens: 1144, outputTokens: 10, totalTokens: 13954, reasoningTokens: 0, cacheReadInputTokens: 12800, cacheCreationInputTokens: 0, cost: 0 },
    },
    id: '604',
  },
  { type: 'done', data: { requestId: '11e5f96e-98d3-4a0e-aa1b-e076ced7a449', outcome: { type: 'completed' } }, id: '605' },
]

/**
 * The VERBATIM sequence a real box emitted for a turn that COMPLETED and
 * produced nothing (sandbox.tangle.tools, gtm-agent production profile —
 * 36,121 B prompt, 6 MCP servers, 6 subagents — 2026-07-27). No error, no
 * throw, `outcome: { type: 'completed' }`, zero `token` events, `finalText: ''`.
 * The customer's message is blank and every existing classifier says the turn
 * succeeded. Measured on 28 turns that day, this shape accounted for every
 * blank answer, and a same-model re-run recovered them.
 */
const EMPTY_COMPLETED_SEQUENCE: Array<Record<string, unknown>> = [
  { type: 'start', data: { id: 'b450d3c1-32e9-4bc0-a0fa-a1ce6564ca37', identifier: 'default' }, id: '1' },
  { type: 'execution.started', data: { executionId: 'b450d3c1-32e9-4bc0-a0fa-a1ce6564ca37', sessionId: 'abprobe-empty' }, id: '2' },
  { type: 'status', data: { status: 'generating_response' }, id: '3' },
  { type: 'session.updated', data: { sessionId: 'ses_05b98f800ffeI04ciTCHI5LNHG' }, id: '4' },
  { type: 'message.part.updated', data: { part: { id: 'prt_step', messageID: 'msg_1', type: 'step-start' } }, id: '5' },
  { type: 'message.part.updated', data: { part: { id: 'prt_fin', messageID: 'msg_1', reason: 'stop', type: 'step-finish', tokens: { total: 21080, input: 13011, output: 0 }, cost: 0 } }, id: '6' },
  { type: 'status', data: { status: 'completed' }, id: '7' },
  { type: 'result', data: { outcome: { type: 'completed' }, finalText: '', toolInvocations: [], tokenUsage: { inputTokens: 13997, outputTokens: 0 } }, id: '8' },
  { type: 'done', data: { requestId: 'b450d3c1-32e9-4bc0-a0fa-a1ce6564ca37', outcome: { type: 'completed' } }, id: '9' },
]

async function* feed(events: Array<Record<string, unknown>>): AsyncGenerator<unknown> {
  for (const event of events) yield event
}

async function collect(source: AsyncGenerator<unknown>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const event of source) out.push(event as Record<string, unknown>)
  return out
}

/**
 * Token totals of every `step-finish` receipt that survived to the consumer.
 *
 * A `step-finish` is never a top-level event type — it is nested at
 * `data.part.type` inside a `message.part.updated`. Each receipt is billable,
 * so the totals identify WHICH pass leaked: the blank pass bills 21,080 and
 * the healthy pass 13,954.
 */
function stepFinishTokenTotals(events: Array<Record<string, unknown>>): number[] {
  const totals: number[] = []
  for (const event of events) {
    if (event.type !== 'message.part.updated') continue
    const part = (event.data as { part?: { type?: string; tokens?: { total?: number } } })?.part
    if (part?.type !== 'step-finish') continue
    totals.push(part.tokens?.total ?? -1)
  }
  return totals
}

describe('isCommittingSandboxEvent — the commit-point rule', () => {
  it('treats every pre-error event of the real dead-model sequence as non-committing', () => {
    // The terminal `error` and trailing `done` are classified elsewhere; the
    // point here is that NOTHING before the error commits the dead model.
    for (const event of DEAD_MODEL_SEQUENCE.slice(0, -2)) {
      expect(isCommittingSandboxEvent(event), `expected non-committing: ${JSON.stringify(event).slice(0, 120)}`).toBe(false)
    }
  })

  it('does not commit on an EMPTY text part but commits on the first real token', () => {
    const emptyPart = HEALTHY_MODEL_SEQUENCE[5]!
    const tokenPart = HEALTHY_MODEL_SEQUENCE[7]!
    expect(isCommittingSandboxEvent(emptyPart)).toBe(false)
    expect(isCommittingSandboxEvent(tokenPart)).toBe(true)
  })

  it.each(['model-processing', 'model.processing'])(
    'treats %s as non-committing liveness',
    (type) => {
      expect(isCommittingSandboxEvent({ type, data: { phase: 'generating' } })).toBe(false)
    },
  )

  it('commits on unknown event types — the safe direction is a missed failover, never a duplicated answer', () => {
    expect(isCommittingSandboxEvent({ type: 'token', data: { value: 'ok' } })).toBe(true)
    expect(isCommittingSandboxEvent({ type: 'some.future.event', data: {} })).toBe(true)
  })

  it('commits on tool parts and interaction asks', () => {
    expect(
      isCommittingSandboxEvent({ type: 'message.part.updated', data: { part: { type: 'tool', id: 'call-1', tool: 'search' } } }),
    ).toBe(true)
    expect(isCommittingSandboxEvent({ type: 'interaction', data: { request: { id: 'i1', kind: 'question' } } })).toBe(true)
  })
})

describe('classifyTerminalFailure — the RESOLVED outage shape', () => {
  it('classifies the verbatim resolved terminal error as an outage', () => {
    const error = DEAD_MODEL_SEQUENCE[9]!
    expect(classifyTerminalFailure(error)).toMatchObject({
      outage: true,
      code: 'provider_inference_unavailable',
    })
  })

  it('classifies a non-outage terminal failure as terminal but NOT an outage', () => {
    const failure = classifyTerminalFailure({
      type: 'error',
      data: { message: 'Invalid request: messages must be an array', code: 'invalid_request' },
    })
    expect(failure).not.toBeNull()
    expect(failure!.outage).toBe(false)
  })

  it('returns null for non-terminal events', () => {
    expect(classifyTerminalFailure(DEAD_MODEL_SEQUENCE[0])).toBeNull()
    expect(classifyTerminalFailure(HEALTHY_MODEL_SEQUENCE[7])).toBeNull()
  })
})

describe('streamWithModelFailover — over the verbatim sequences', () => {
  it('bounds a silent preferred model, closes it, and serves the fallback', async () => {
    vi.useFakeTimers()
    try {
      const opened: string[] = []
      const closePrimary = vi.fn(async () => ({ done: true as const, value: undefined }))
      let primaryStarted = false
      const silentPrimary: AsyncIterable<unknown> = {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            if (!primaryStarted) {
              primaryStarted = true
              return Promise.resolve({ done: false as const, value: { type: 'start' } })
            }
            return new Promise<IteratorResult<unknown>>(() => {})
          },
          return: closePrimary,
        }),
      }
      const handle = streamWithModelFailover({
        models: ['silent-model', 'gpt-5-mini'],
        firstResponseTimeoutMs: 50,
        open: ({ model }) => {
          opened.push(model)
          return model === 'silent-model' ? silentPrimary : feed(HEALTHY_MODEL_SEQUENCE)
        },
      })

      let events: Array<Record<string, unknown>> | undefined
      void collect(handle.events).then((value) => { events = value })
      await vi.advanceTimersByTimeAsync(50)
      await Promise.resolve()

      expect(opened).toEqual(['silent-model', 'gpt-5-mini'])
      expect(events).toEqual(HEALTHY_MODEL_SEQUENCE)
      expect(closePrimary).toHaveBeenCalledOnce()
      expect(handle.servingModel()).toBe('gpt-5-mini')
      expect(handle.attempts()[0]?.reason).toContain('first answer-bearing event')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses one hard first-response deadline across both processing aliases', async () => {
    vi.useFakeTimers()
    try {
      const liveness = [
        { type: 'model-processing', data: { phase: 'thinking' } },
        { type: 'model.processing', data: { phase: 'thinking' } },
      ]
      let index = 0
      const closePrimary = vi.fn(async () => ({ done: true as const, value: undefined }))
      const livenessOnly: AsyncIterable<unknown> = {
        [Symbol.asyncIterator]: () => ({
          next: async () => index < liveness.length
            ? { done: false as const, value: liveness[index++] }
            : new Promise<IteratorResult<unknown>>(() => {}),
          return: closePrimary,
        }),
      }
      const handle = streamWithModelFailover({
        models: ['liveness-only', 'healthy'],
        firstResponseTimeoutMs: 40,
        open: ({ model }) => model === 'liveness-only' ? livenessOnly : feed(HEALTHY_MODEL_SEQUENCE),
      })

      let events: Array<Record<string, unknown>> | undefined
      void collect(handle.events).then((value) => { events = value })
      await vi.advanceTimersByTimeAsync(40)
      await Promise.resolve()

      expect(events).toEqual(HEALTHY_MODEL_SEQUENCE)
      expect(closePrimary).toHaveBeenCalledOnce()
      expect(handle.usedFallback()).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps source opening separate from the provider first-response deadline', async () => {
    vi.useFakeTimers()
    try {
      async function* coldSource(): AsyncGenerator<unknown> {
        await new Promise((resolve) => setTimeout(resolve, 80))
        yield* feed(HEALTHY_MODEL_SEQUENCE)
      }
      const handle = streamWithModelFailover({
        models: ['cold-model', 'fallback'],
        openTimeoutMs: 100,
        firstResponseTimeoutMs: 20,
        // Async-generator setup runs on the first `next()`, not construction.
        // That cold work belongs to the source-open phase.
        open: ({ model }) => model === 'cold-model' ? coldSource() : feed(HEALTHY_MODEL_SEQUENCE),
      })

      let events: Array<Record<string, unknown>> | undefined
      void collect(handle.events).then((value) => { events = value })
      await vi.advanceTimersByTimeAsync(80)
      await Promise.resolve()

      expect(events).toEqual(HEALTHY_MODEL_SEQUENCE)
      expect(handle.servingModel()).toBe('cold-model')
      expect(handle.usedFallback()).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds source opening and closes a source that arrives after abandonment', async () => {
    vi.useFakeTimers()
    try {
      let resolveLate!: (source: AsyncIterable<unknown>) => void
      const lateSource = new Promise<AsyncIterable<unknown>>((resolve) => { resolveLate = resolve })
      const closeLate = vi.fn(async () => ({ done: true as const, value: undefined }))
      const opened: string[] = []
      let abandonedSignal: AbortSignal | undefined
      const handle = streamWithModelFailover({
        models: ['cold-model', 'healthy'],
        openTimeoutMs: 30,
        firstResponseTimeoutMs: 30,
        open: ({ model, signal }) => {
          opened.push(model)
          if (model === 'cold-model') abandonedSignal = signal
          return model === 'cold-model' ? lateSource : feed(HEALTHY_MODEL_SEQUENCE)
        },
      })

      let events: Array<Record<string, unknown>> | undefined
      void collect(handle.events).then((value) => { events = value })
      await vi.advanceTimersByTimeAsync(30)
      await Promise.resolve()

      expect(opened).toEqual(['cold-model', 'healthy'])
      expect(events).toEqual(HEALTHY_MODEL_SEQUENCE)
      expect(abandonedSignal?.aborted).toBe(true)

      resolveLate({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<unknown>>(() => {}),
          return: closeLate,
        }),
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(closeLate).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('commits on reasoning before the deadline and never falls back after a later outage', async () => {
    const opened: string[] = []
    async function* reasoningThenFailure(): AsyncGenerator<unknown> {
      yield {
        type: 'message.part.updated',
        data: { part: { id: 'reasoning-1', type: 'reasoning', text: 'Considering' } },
      }
      throw new Error('502 Bad Gateway after reasoning started')
    }
    const handle = streamWithModelFailover({
      models: ['reasoning-model', 'fallback'],
      firstResponseTimeoutMs: 50,
      open: ({ model }) => {
        opened.push(model)
        return model === 'reasoning-model' ? reasoningThenFailure() : feed(HEALTHY_MODEL_SEQUENCE)
      },
    })

    await expect(collect(handle.events)).rejects.toThrow('502 Bad Gateway after reasoning started')
    expect(opened).toEqual(['reasoning-model'])
    expect(handle.servingModel()).toBe('reasoning-model')
    expect(handle.usedFallback()).toBe(false)
  })

  it('abandons the dead model at its resolved error and serves the fallback, replaying its buffer intact', async () => {
    const opened: string[] = []
    const handle = streamWithModelFailover({
      models: ['dead-model', 'gpt-5-mini'],
      open: ({ model }) => {
        opened.push(model)
        return feed(model === 'dead-model' ? DEAD_MODEL_SEQUENCE : HEALTHY_MODEL_SEQUENCE)
      },
    })

    const events = await collect(handle.events)

    expect(opened).toEqual(['dead-model', 'gpt-5-mini'])
    expect(handle.servingModel()).toBe('gpt-5-mini')
    expect(handle.usedFallback()).toBe(true)
    expect(handle.attempts()).toEqual([
      { model: 'dead-model', ok: false, reason: expect.stringContaining('provider inference is unavailable') },
      { model: 'gpt-5-mini', ok: true },
    ])
    // The healthy sequence flows through COMPLETE and in order…
    expect(events).toEqual(HEALTHY_MODEL_SEQUENCE)
    // …and nothing from the dead attempt leaks — above all not its usage.
    expect(events.some((e) => JSON.stringify(e).includes('definitely-not-a-model-xyz'))).toBe(false)
  })

  it('surfaces a NON-outage terminal error without walking the chain', async () => {
    const opened: string[] = []
    const badRequest = { type: 'error', data: { message: 'Invalid request', code: 'invalid_request' }, id: '1' }
    const handle = streamWithModelFailover({
      models: ['model-a', 'model-b'],
      open: ({ model }) => {
        opened.push(model)
        return feed([badRequest])
      },
    })

    const events = await collect(handle.events)

    expect(opened).toEqual(['model-a'])
    expect(events).toEqual([badRequest])
    expect(handle.servingModel()).toBe('model-a')
    expect(handle.usedFallback()).toBe(false)
  })

  it('does NOT retry a clean stream that produced nothing — an empty answer is not an outage', async () => {
    const opened: string[] = []
    const handle = streamWithModelFailover({
      models: ['model-a', 'model-b'],
      open: ({ model }) => {
        opened.push(model)
        return feed([])
      },
    })

    await collect(handle.events)
    expect(opened).toEqual(['model-a'])
  })

  it('still does not retry an empty turn by DEFAULT — `emptyTurnRetries` is opt-in', async () => {
    const opened: string[] = []
    const handle = streamWithModelFailover({
      models: ['model-a', 'model-b'],
      open: ({ model }) => {
        opened.push(model)
        return feed(EMPTY_COMPLETED_SEQUENCE)
      },
    })

    const events = await collect(handle.events)
    expect(opened).toEqual(['model-a'])
    expect(events).toHaveLength(EMPTY_COMPLETED_SEQUENCE.length)
  })

  it('re-runs the SAME model on a completed-but-blank turn, and never walks the chain for it', async () => {
    const opened: string[] = []
    const retries: Array<{ model: string; retry: number }> = []
    const handle = streamWithModelFailover({
      models: ['model-a', 'model-b'],
      emptyTurnRetries: 2,
      onEmptyTurnRetry: ({ model, retry }) => retries.push({ model, retry }),
      open: ({ model }) => {
        opened.push(model)
        // Blank on the first pass, a real answer on the second — the measured
        // production behavior.
        return feed(opened.length === 1 ? EMPTY_COMPLETED_SEQUENCE : HEALTHY_MODEL_SEQUENCE)
      },
    })

    const events = await collect(handle.events)
    // The re-run is the SAME model: attribution is untouched, `model-b` is never
    // reached, and `usedFallback` stays false so no downgrade notice is emitted.
    expect(opened).toEqual(['model-a', 'model-a'])
    expect(handle.servingModel()).toBe('model-a')
    expect(handle.usedFallback()).toBe(false)
    expect(retries).toEqual([{ model: 'model-a', retry: 1 }])
    // The blank pass is discarded whole — including its `step-finish` token
    // receipt, which must never be billed.
    // A `step-finish` is NEVER a top-level event type — in both fixtures it
    // arrives nested as `data.part.type` inside `message.part.updated`, so a
    // top-level filter would read 0 even with both receipts leaked. Assert on
    // the nested shape and identify each receipt by its token total: the blank
    // pass billed 21,080 and the healthy pass 13,954.
    expect(stepFinishTokenTotals(events)).toEqual([13954])
    expect(events.some((e) => e.type === 'result' && (e.data as { finalText?: string })?.finalText === 'ok')).toBe(true)
    expect(events.filter((e) => e.type === 'result')).toHaveLength(1)
  })

  it('gives up after the budget and commits the blank turn exactly as today', async () => {
    const opened: string[] = []
    const handle = streamWithModelFailover({
      models: ['model-a', 'model-b'],
      emptyTurnRetries: 2,
      open: ({ model }) => {
        opened.push(model)
        return feed(EMPTY_COMPLETED_SEQUENCE)
      },
    })

    const events = await collect(handle.events)
    expect(opened).toEqual(['model-a', 'model-a', 'model-a'])
    expect(handle.servingModel()).toBe('model-a')
    expect(events).toHaveLength(EMPTY_COMPLETED_SEQUENCE.length)
  })

  it.each([
    ['NaN', Number.NaN, 1],
    ['Infinity', Number.POSITIVE_INFINITY, 1],
    ['-Infinity', Number.NEGATIVE_INFINITY, 1],
    ['negative', -5, 1],
    ['fractional 2.7 → 2', 2.7, 3],
    ['above the ceiling', 99, 1 + MAX_EMPTY_TURN_RETRIES],
  ])('bounds a %s budget instead of looping forever', async (_label, budget, expectedOpens) => {
    // `Math.trunc(NaN)` is NaN and `retry >= NaN` is false for every retry, so
    // an unguarded clamp opens sandbox streams until the worker dies.
    const opened: string[] = []
    const handle = streamWithModelFailover({
      models: ['model-a'],
      emptyTurnRetries: budget as number,
      open: ({ model }) => {
        opened.push(model)
        if (opened.length > 50) throw new Error('unbounded retry loop')
        return feed(EMPTY_COMPLETED_SEQUENCE)
      },
    })

    await collect(handle.events)
    expect(opened).toHaveLength(expectedOpens as number)
  })

  it('never re-runs a turn that produced text — a delivered answer is never produced twice', async () => {
    const opened: string[] = []
    const handle = streamWithModelFailover({
      models: ['model-a'],
      emptyTurnRetries: 3,
      open: ({ model }) => {
        opened.push(model)
        return feed(HEALTHY_MODEL_SEQUENCE)
      },
    })

    await collect(handle.events)
    expect(opened).toEqual(['model-a'])
  })

  it('an OUTAGE still walks the chain even with an empty-turn budget set', async () => {
    const opened: string[] = []
    const handle = streamWithModelFailover({
      models: ['model-a', 'model-b'],
      emptyTurnRetries: 2,
      open: ({ model }) => {
        opened.push(model)
        return feed(model === 'model-a' ? DEAD_MODEL_SEQUENCE : HEALTHY_MODEL_SEQUENCE)
      },
    })

    await collect(handle.events)
    expect(opened).toEqual(['model-a', 'model-b'])
    expect(handle.usedFallback()).toBe(true)
  })

  it('re-throws a thrown non-outage error from the first model without opening the second', async () => {
    const opened: string[] = []
    async function* throwing(): AsyncGenerator<unknown> {
      throw new Error('schema validation failed: content is required')
      yield undefined
    }
    const handle = streamWithModelFailover({
      models: ['model-a', 'model-b'],
      open: ({ model }) => {
        opened.push(model)
        return throwing()
      },
    })

    await expect(collect(handle.events)).rejects.toThrow('schema validation failed')
    expect(opened).toEqual(['model-a'])
  })

  it('fails over on a THROWN outage error too (the classifier covers both signal shapes)', async () => {
    async function* throwing(): AsyncGenerator<unknown> {
      throw new Error('502 Bad Gateway')
      yield undefined
    }
    const handle = streamWithModelFailover({
      models: ['dead-model', 'gpt-5-mini'],
      open: ({ model }) => (model === 'dead-model' ? throwing() : feed(HEALTHY_MODEL_SEQUENCE)),
    })

    const events = await collect(handle.events)
    expect(handle.servingModel()).toBe('gpt-5-mini')
    expect(events).toEqual(HEALTHY_MODEL_SEQUENCE)
  })

  it('throws ModelFailoverExhaustedError with the full trail when every model is dead', async () => {
    const handle = streamWithModelFailover({
      models: ['dead-a', 'dead-b'],
      open: () => feed(DEAD_MODEL_SEQUENCE),
    })

    const error = await collect(handle.events).then(
      () => null,
      (err: unknown) => err,
    )
    expect(error).toBeInstanceOf(ModelFailoverExhaustedError)
    expect((error as ModelFailoverExhaustedError).attempts.map((a) => a.model)).toEqual(['dead-a', 'dead-b'])
    // The trail survives onto the handle so a receipt can still name every model tried.
    expect(handle.attempts().map((a) => a.model)).toEqual(['dead-a', 'dead-b'])
  })

  it('a one-model chain opens exactly once', async () => {
    const opened: string[] = []
    const handle = streamWithModelFailover({
      models: ['only-model'],
      open: ({ model, attempt }) => {
        opened.push(`${model}#${attempt}`)
        return feed(HEALTHY_MODEL_SEQUENCE)
      },
    })
    await collect(handle.events)
    expect(opened).toEqual(['only-model#1'])
  })
})

describe('createSandboxChatProducer — failover wiring', () => {
  function producerFor(opts: { failover?: false; onFallback?: (info: { from: string; to: string }) => void } = {}) {
    const opened: string[] = []
    const producer = createSandboxChatProducer({
      model: 'dead-model',
      ...(opts.failover === false ? { modelFailover: false as const } : { fallbackModels: ['gpt-5-mini'] }),
      openEvents: ({ model }) => {
        opened.push(model)
        return feed(model === 'dead-model' ? DEAD_MODEL_SEQUENCE : HEALTHY_MODEL_SEQUENCE)
      },
      ...(opts.onFallback ? { onModelFallback: opts.onFallback } : {}),
      log: () => {},
    })
    return { producer, opened }
  }

  it('serves the fallback, reports the SERVING model, and emits + persists a notice naming both models', async () => {
    const fallbacks: Array<{ from: string; to: string }> = []
    const { producer, opened } = producerFor({ onFallback: (info) => fallbacks.push(info) })

    const events = await collect(producer.stream as AsyncGenerator<unknown>)

    expect(opened).toEqual(['dead-model', 'gpt-5-mini'])
    // The producer's `model` is the model that ACTUALLY served — this is what
    // turn-routes writes onto the persisted assistant row and the receipt.
    expect(producer.model).toBe('gpt-5-mini')
    expect(producer.finalText()).toBe('ok')
    // Rich usage came from the FALLBACK's result — never the dead attempt.
    expect(producer.usage?.()).toMatchObject({ inputTokens: 1144, outputTokens: 10 })

    // Visible attribution: a notice event naming both models…
    const notice = events.find((e) => (e as { type?: string }).type === 'notice') as { text?: string } | undefined
    expect(notice?.text).toContain('dead-model')
    expect(notice?.text).toContain('gpt-5-mini')
    // …that lands BEFORE the fallback's first content event…
    const noticeIndex = events.findIndex((e) => (e as { type?: string }).type === 'notice')
    const textIndex = events.findIndex((e) => (e as { type?: string }).type === 'text')
    expect(noticeIndex).toBeGreaterThanOrEqual(0)
    expect(noticeIndex).toBeLessThan(textIndex)
    // …and is PERSISTED so the durable transcript carries the downgrade.
    expect(
      producer.assistantParts?.().some(
        (part) => part.type === 'notice' && String(part.text).includes('gpt-5-mini'),
      ),
    ).toBe(true)

    expect(fallbacks).toEqual([expect.objectContaining({ from: 'dead-model', to: 'gpt-5-mini' })])
    expect(producer.modelFailover?.()).toMatchObject({
      model: 'gpt-5-mini',
      usedFallback: true,
      attempts: [expect.objectContaining({ model: 'dead-model', ok: false }), { model: 'gpt-5-mini', ok: true }],
    })
  })

  it('surfaces a structured timeout when every configured model stays silent', async () => {
    vi.useFakeTimers()
    try {
      const closed: string[] = []
      const started = new Set<string>()
      const signals = new Map<string, AbortSignal>()
      const producer = createSandboxChatProducer({
        model: 'silent-a',
        fallbackModels: ['silent-b'],
        firstResponseTimeoutMs: 25,
        openEvents: ({ model, signal }) => {
          signals.set(model, signal)
          return {
            [Symbol.asyncIterator]: () => ({
              next: () => {
                if (!started.has(model)) {
                  started.add(model)
                  return Promise.resolve({
                    done: false as const,
                    value: { type: 'model.processing', data: { phase: 'generating' } },
                  })
                }
                return new Promise<IteratorResult<unknown>>(() => {})
              },
              return: async () => {
                closed.push(model)
                return { done: true as const, value: undefined }
              },
            }),
          }
        },
        log: () => {},
      })

      let events: Array<Record<string, unknown>> | undefined
      void collect(producer.stream as AsyncGenerator<unknown>).then((value) => { events = value })
      await vi.advanceTimersByTimeAsync(50)
      await Promise.resolve()

      const terminal = events?.find((event) => event.type === 'error') as
        | { data?: { code?: string; details?: { failureNote?: string } } }
        | undefined
      expect(terminal?.data?.code).toBe('provider_first_response_timeout')
      expect(terminal?.data?.details?.failureNote).toContain('silent-b')
      expect(closed).toEqual(['silent-a', 'silent-b'])
      expect([...signals.values()].every((signal) => signal.aborted)).toBe(true)
      expect(producer.modelFailover?.().attempts.map((attempt) => attempt.model)).toEqual([
        'silent-a',
        'silent-b',
      ])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('opt-out (`modelFailover: false`) opens only the preferred model and surfaces the failure', async () => {
    const { producer, opened } = producerFor({ failover: false })

    const events = await collect(producer.stream as AsyncGenerator<unknown>)

    expect(opened).toEqual(['dead-model'])
    expect(producer.model).toBe('dead-model')
    expect(producer.modelFailover?.()).toMatchObject({ usedFallback: false })
    // The resolved terminal error flows through to the client as today.
    expect(events.some((e) => (e as { type?: string }).type === 'error')).toBe(true)
  })

  it('the legacy already-open `events` form is unchanged — one model, no failover machinery', async () => {
    const producer = createSandboxChatProducer({
      events: feed(HEALTHY_MODEL_SEQUENCE),
      model: 'gpt-5-mini',
      log: () => {},
    })
    await collect(producer.stream as AsyncGenerator<unknown>)
    expect(producer.model).toBe('gpt-5-mini')
    expect(producer.finalText()).toBe('ok')
    expect(producer.modelFailover?.()).toMatchObject({ usedFallback: false, attempts: [] })
  })

  it('rejects `openEvents` without `model`, and rejects neither-form', () => {
    expect(() => createSandboxChatProducer({ openEvents: () => feed([]) })).toThrow(/requires `model`/)
    expect(() => createSandboxChatProducer({} as Parameters<typeof createSandboxChatProducer>[0])).toThrow(
      /`openEvents` \(failover-capable\) or `events`/,
    )
  })

  it('re-runs a blank turn through the PRODUCER seam, billing only the pass that answered', async () => {
    // `createChatTurnRoutes` and `runDetachedTurn` call the producer, not
    // `streamWithModelFailover` directly, so the forwarding of
    // `emptyTurnRetries`/`onEmptyTurnRetry` is what a product actually
    // depends on. Exercised here end-to-end rather than one layer down.
    const opened: string[] = []
    const retries: EmptyTurnRetryInfo[] = []
    const producer = createSandboxChatProducer({
      model: 'model-a',
      fallbackModels: ['model-b'],
      emptyTurnRetries: 1,
      onEmptyTurnRetry: (info) => retries.push(info),
      openEvents: ({ model }) => {
        opened.push(model)
        return feed(opened.length === 1 ? EMPTY_COMPLETED_SEQUENCE : HEALTHY_MODEL_SEQUENCE)
      },
      log: () => {},
    })

    await collect(producer.stream as AsyncGenerator<unknown>)

    // Same model twice — the chain is never walked, so `model-b` never runs
    // and the answer stays attributable to the model the product chose.
    expect(opened).toEqual(['model-a', 'model-a'])
    expect(producer.model).toBe('model-a')
    expect(producer.finalText()).toBe('ok')
    expect(retries).toEqual([{ model: 'model-a', retry: 1, remaining: 0 }])
    // Usage is the HEALTHY pass's receipt alone. The blank pass burned 13,011
    // input tokens; billing them here would overcharge for a turn the
    // customer never saw.
    expect(producer.usage?.()).toMatchObject({ inputTokens: 1144, outputTokens: 10 })
    // A same-model re-run is NOT a downgrade, so it must not emit the
    // fallback notice that a real chain walk does.
    expect(producer.modelFailover?.()).toMatchObject({ usedFallback: false })
    expect(producer.assistantParts?.().some((part) => part.type === 'notice')).toBe(false)
  })

  it('refuses a retry budget it cannot honour on a fixed `events` stream', () => {
    // A fixed stream has nothing to re-open, so the budget would be a silent
    // no-op: the product believes blank turns are retried and none are.
    expect(() =>
      createSandboxChatProducer({ model: 'gpt-5-mini', events: feed([]), emptyTurnRetries: 2 }),
    ).toThrow(/`emptyTurnRetries` requires `openEvents`/)
    // An unusable budget resolves to 0, which is honestly "no retries" on
    // either form — it must NOT throw, or a NaN from `Number(env)` would take
    // down a product that never asked for the feature.
    expect(() =>
      createSandboxChatProducer({ model: 'gpt-5-mini', events: feed([]), emptyTurnRetries: Number.NaN }),
    ).not.toThrow()
    expect(() =>
      createSandboxChatProducer({ model: 'gpt-5-mini', events: feed([]), emptyTurnRetries: 0 }),
    ).not.toThrow()
  })

  it('exhaustion (every model dead) ends the turn as a structured failure, with the fallback notice still recorded', async () => {
    const producer = createSandboxChatProducer({
      model: 'dead-a',
      fallbackModels: ['dead-b'],
      openEvents: () => feed(DEAD_MODEL_SEQUENCE),
      log: () => {},
    })

    const events = await collect(producer.stream as AsyncGenerator<unknown>)

    // The producer's severed-stream catch turns the thrown exhaustion into the
    // structured terminal error the route maps to `failed: true` — never a
    // silent empty completion.
    const terminal = events.find((e) => (e as { type?: string }).type === 'error') as
      | { data?: { code?: string } }
      | undefined
    expect(terminal?.data?.code).toBe('sandbox.stream_failed')
    expect(producer.modelFailover?.()).toMatchObject({
      attempts: [
        expect.objectContaining({ model: 'dead-a', ok: false }),
        expect.objectContaining({ model: 'dead-b', ok: false }),
      ],
    })
  })
})

describe('createChatTurnRoutes — failover attribution through the full route assembly', () => {
  it('persists the SERVING model on the assistant row and reports it on the billing receipt with the trail', async () => {
    const { createChatTurnRoutes } = await import('../../src/chat-routes/index')
    const rows: Array<Record<string, unknown>> = []
    const store = {
      listMessages: async () => [],
      appendMessage: async (input: Record<string, unknown>) => {
        rows.push(input)
        return { id: `m${rows.length}`, ...input }
      },
    }
    let receipt: Record<string, unknown> | undefined
    const pending: Promise<unknown>[] = []

    const routes = createChatTurnRoutes({
      projectId: 'failover-test',
      authorize: async () => ({ ok: true, tenantId: 'ws-1', userId: 'u-1', context: undefined }),
      store: store as never,
      turnStore: createMemoryTurnEventStore(),
      produce: () =>
        createSandboxChatProducer({
          model: 'dead-model',
          fallbackModels: ['gpt-5-mini'],
          openEvents: ({ model }) => feed(model === 'dead-model' ? DEAD_MODEL_SEQUENCE : HEALTHY_MODEL_SEQUENCE),
          log: () => {},
        }),
      onTurnComplete: async (input) => {
        receipt = input as unknown as Record<string, unknown>
      },
      log: () => {},
    })

    const res = await routes.turn(
      new Request('http://app.test/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: 't-1', content: 'q?' }),
      }),
      { waitUntil: (p: Promise<unknown>) => void pending.push(p) },
    )
    await new Response(res.body!).text()
    await Promise.all(pending)

    // Persisted assistant row: serving model, not the requested one.
    const assistant = rows.find((r) => r.role === 'assistant')
    expect(assistant?.model).toBe('gpt-5-mini')
    expect(assistant?.content).toBe('ok')
    // The row's usage is the FALLBACK's receipt (1144/10 verbatim from the
    // capture) — the dead attempt's tokens were discarded with its stream.
    expect(assistant?.inputTokens).toBe(1144)
    expect(assistant?.outputTokens).toBe(10)
    // Billing receipt: same serving model + the full attempt trail.
    expect(receipt?.model).toBe('gpt-5-mini')
    expect(receipt?.failed).toBe(false)
    expect(receipt?.modelFailover).toMatchObject({
      model: 'gpt-5-mini',
      usedFallback: true,
      attempts: [expect.objectContaining({ model: 'dead-model', ok: false }), { model: 'gpt-5-mini', ok: true }],
    })
  })
})

describe('runDetachedTurn — failover attribution on the autonomous lane', () => {
  it('completes on the fallback and stamps the serving model + trail onto the result and the durable row', async () => {
    const store = createMemoryTurnEventStore()
    const rows = new Map<string, Record<string, unknown>>()
    const draftStore: AssistantDraftStore = {
      listMessages: async () => [],
      appendMessage: async (input) => {
        rows.set(input.id ?? 'row', { ...input })
      },
      updateMessage: async (id, patch) => {
        rows.set(id, { ...rows.get(id), ...patch })
      },
    }

    const res = await runDetachedTurn({
      store,
      turnId: 't1',
      scopeId: 'thread-1',
      model: 'dead-model',
      fallbackModels: ['gpt-5-mini'],
      openEvents: ({ model }) => feed(model === 'dead-model' ? DEAD_MODEL_SEQUENCE : HEALTHY_MODEL_SEQUENCE),
      persist: { store: draftStore, threadId: 'thread-1' },
    })

    expect(res.state).toBe('completed')
    expect(res.text).toBe('ok')
    // The RESULT names the model that served — the caller's billing/scoring key.
    expect(res.model).toBe('gpt-5-mini')
    expect(res.usedModelFallback).toBe(true)
    expect(res.modelAttempts?.map((a) => a.model)).toEqual(['dead-model', 'gpt-5-mini'])
    // The DURABLE ROW converged onto the serving model, not the requested one.
    const finalRow = rows.get('assistant:t1')
    expect(finalRow, `expected row assistant:t1, have ${JSON.stringify([...rows.keys()])}`).toBeTruthy()
    expect(finalRow?.model).toBe('gpt-5-mini')
  })

  it('without failover config the detached result still reports the (single) model it ran', async () => {
    const store = createMemoryTurnEventStore()
    const res = await runDetachedTurn({
      store,
      turnId: 't2',
      scopeId: 'thread-1',
      model: 'gpt-5-mini',
      events: feed(HEALTHY_MODEL_SEQUENCE),
    })
    expect(res.model).toBe('gpt-5-mini')
    expect(res.usedModelFallback).toBe(false)
  })
})
