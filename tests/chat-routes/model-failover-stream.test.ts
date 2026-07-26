import { describe, expect, it, vi } from 'vitest'

import {
  classifyTerminalFailure,
  createSandboxChatProducer,
  isCommittingSandboxEvent,
  runDetachedTurn,
  streamWithModelFailover,
  type AssistantDraftStore,
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

async function* feed(events: Array<Record<string, unknown>>): AsyncGenerator<unknown> {
  for (const event of events) yield event
}

async function collect(source: AsyncGenerator<unknown>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const event of source) out.push(event as Record<string, unknown>)
  return out
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
