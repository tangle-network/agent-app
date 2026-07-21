import { describe, expect, it, vi } from 'vitest'

import { createSandboxChatProducer } from '../../src/chat-routes/index'

function partUpdated(part: Record<string, unknown>, delta?: string): Record<string, unknown> {
  return { type: 'message.part.updated', data: { part, ...(delta !== undefined ? { delta } : {}) } }
}

async function* feed(events: Array<Record<string, unknown>>): AsyncGenerator<unknown> {
  for (const event of events) yield event
}

async function drain(stream: AsyncGenerator<{ type: string }, void, unknown>) {
  const out: Array<Record<string, unknown>> = []
  for await (const event of stream) out.push(event as Record<string, unknown>)
  return out
}

describe('createSandboxChatProducer', () => {
  it('maps text deltas, snapshots, reasoning, and result finalText into the client vocabulary', async () => {
    const producer = createSandboxChatProducer({
      events: feed([
        partUpdated({ type: 'reasoning', id: 'r1', text: 'thinking' }, 'thinking'),
        partUpdated({ type: 'text', id: 'x1', text: 'Hel' }, 'Hel'),
        // Snapshot-only update (no delta): suffix must be derived, not re-appended.
        partUpdated({ type: 'text', id: 'x1', text: 'Hello' }),
        { type: 'result', data: { finalText: 'Hello' } },
      ]),
      model: 'anthropic/claude',
    })
    const events = await drain(producer.stream)

    expect(events).toEqual([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
    ])
    expect(producer.finalText()).toBe('Hello')
    expect(producer.model).toBe('anthropic/claude')
    expect(producer.assistantParts?.()).toEqual([
      expect.objectContaining({ type: 'reasoning', text: 'thinking' }),
      expect.objectContaining({ type: 'text', text: 'Hello' }),
    ])
  })

  it('announces a tool once and settles it once, with the persisted tool part tracking state', async () => {
    const producer = createSandboxChatProducer({
      events: feed([
        partUpdated({ type: 'tool', id: 'call-1', tool: 'search', state: { status: 'running', input: { q: 'x' } } }),
        partUpdated({ type: 'tool', id: 'call-1', tool: 'search', state: { status: 'running', input: { q: 'x' } } }),
        partUpdated({ type: 'tool', id: 'call-1', tool: 'search', state: { status: 'completed', input: { q: 'x' }, output: '3 hits' } }),
        { type: 'result', data: { finalText: 'done' } },
      ]),
    })
    const events = await drain(producer.stream)

    expect(events).toEqual([
      { type: 'tool_call', call: { toolCallId: 'call-1', toolName: 'search', args: { q: 'x' } } },
      {
        type: 'tool_result',
        toolCallId: 'call-1',
        toolName: 'search',
        outcome: { ok: true, result: '3 hits' },
      },
    ])
    const parts = producer.assistantParts?.() ?? []
    expect(parts[0]).toMatchObject({ type: 'tool', id: 'call-1', tool: 'search', state: { status: 'completed', output: '3 hits' } })
  })

  it('accumulates the usage receipt from step-finish parts and emits a usage line', async () => {
    const producer = createSandboxChatProducer({
      events: feed([
        partUpdated({ type: 'step-finish', tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 7, write: 3 } }, cost: 0.02 }),
        partUpdated({ type: 'step-finish', tokens: { input: 50, output: 10 }, cost: 0.01 }),
      ]),
    })
    const events = await drain(producer.stream)

    expect(events).toEqual([
      { type: 'usage', usage: { promptTokens: 100, completionTokens: 20 } },
      { type: 'usage', usage: { promptTokens: 150, completionTokens: 30 } },
    ])
    expect(producer.usage?.()).toEqual({
      inputTokens: 150,
      outputTokens: 30,
      reasoningTokens: 5,
      cacheReadTokens: 7,
      cacheWriteTokens: 3,
      costUsd: 0.03,
    })
    // The per-step receipts also persist — one part per step, never merged.
    expect(producer.assistantParts?.()).toEqual([
      { type: 'step-finish', tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 7, write: 3 } }, cost: 0.02 },
      { type: 'step-finish', tokens: { input: 50, output: 10 }, cost: 0.01 },
    ])
  })

  it('persists file/image parts from the stream into the transcript projection', async () => {
    const producer = createSandboxChatProducer({
      events: feed([
        partUpdated({ type: 'text', id: 't1', text: 'see the chart' }, 'see the chart'),
        partUpdated({ type: 'file', id: 'f1', filename: 'out.csv', mediaType: 'text/csv', path: 'outputs/out.csv' }),
        partUpdated({ type: 'image', filename: 'plot.png', mediaType: 'image/png', url: 'data:image/png;base64,AA' }),
        { type: 'result', data: { finalText: 'see the chart' } },
      ]),
    })
    await drain(producer.stream)

    expect(producer.assistantParts?.()).toEqual([
      expect.objectContaining({ type: 'text', text: 'see the chart' }),
      { type: 'file', id: 'f1', filename: 'out.csv', mediaType: 'text/csv', path: 'outputs/out.csv' },
      { type: 'image', filename: 'plot.png', mediaType: 'image/png', url: 'data:image/png;base64,AA' },
    ])
  })

  it('forwards renderable asks and auto-declines non-renderable ones', async () => {
    const declineInteraction = vi.fn(async () => {})
    const ask = (id: string, kind: string) => ({
      type: 'interaction',
      data: {
        request: {
          id,
          kind,
          title: 'Need input',
          answerSpec: { fields: [] },
        },
      },
    })
    const producer = createSandboxChatProducer({
      events: feed([ask('q-1', 'question'), ask('p-1', 'permission')]),
      declineInteraction,
      log: () => {},
    })
    const events = await drain(producer.stream)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'interaction', data: { request: { id: 'q-1', kind: 'question' } } })
    expect(declineInteraction).toHaveBeenCalledExactlyOnceWith('p-1')
    expect(producer.assistantParts?.()).toEqual([expect.objectContaining({
      type: 'interaction',
      id: 'q-1',
      status: 'pending',
    })])
  })

  it('lets a durable projection materialize acknowledged answers', async () => {
    const projection = {
      upsertAsk: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      materialize: vi.fn(async () => [{
        type: 'interaction' as const,
        id: 'q-1',
        kind: 'question',
        title: 'Need input',
        answerSpec: { fields: [] },
        status: 'answered' as const,
        answers: { confirmed: true },
      }]),
    }
    const producer = createSandboxChatProducer({
      events: feed([
        {
          type: 'interaction',
          data: { request: { id: 'q-1', kind: 'question', title: 'Need input', answerSpec: { fields: [] } } },
        },
      ]),
      interactionProjection: projection,
    })

    await drain(producer.stream)
    expect(projection.upsertAsk).toHaveBeenCalledOnce()
    expect(projection.cancel).not.toHaveBeenCalled()
    expect(producer.assistantParts?.()).toEqual([expect.objectContaining({
      type: 'interaction',
      id: 'q-1',
      status: 'answered',
      answers: { confirmed: true },
    })])
  })

  it('persists an explicit cancel outcome without inferring it from disappearance', async () => {
    const producer = createSandboxChatProducer({
      events: feed([
        {
          type: 'interaction',
          data: { request: { id: 'q-1', kind: 'question', title: 'Need input', answerSpec: { fields: [] } } },
        },
        { type: 'interaction.cancel', data: { id: 'q-1', reason: 'timeout' } },
      ]),
    })
    await drain(producer.stream)
    expect(producer.assistantParts?.()).toEqual([expect.objectContaining({
      type: 'interaction',
      id: 'q-1',
      status: 'expired',
      cancelReason: 'timeout',
    })])
  })

  it('forwards and persists live durable plan submissions without a session id', async () => {
    const producer = createSandboxChatProducer({
      events: feed([{
        type: 'plan.submitted',
        data: {
          plan: {
            id: 'plan-1',
            revision: 1,
            body: '1. Research\n2. Execute',
            submittedAt: '2026-07-21T00:00:00.000Z',
          },
        },
      }]),
    })

    expect(await drain(producer.stream)).toEqual([{
      type: 'plan.submitted',
      data: {
        plan: {
          id: 'plan-1',
          revision: 1,
          body: '1. Research\n2. Execute',
          submittedAt: '2026-07-21T00:00:00.000Z',
        },
      },
    }])
    expect(producer.assistantParts?.()).toEqual([{
      type: 'plan',
      planId: 'plan-1',
      revision: 1,
      body: '1. Research\n2. Execute',
      submittedAt: '2026-07-21T00:00:00.000Z',
      status: 'pending',
    }])
  })

  it('forwards error and cancel events verbatim and drops malformed interactions', async () => {
    const log = vi.fn()
    const producer = createSandboxChatProducer({
      events: feed([
        { type: 'interaction', data: {} },
        { type: 'interaction.cancel', data: { id: 'q-1', reason: 'timeout' } },
        { type: 'error', details: 'boom' },
      ]),
      log,
    })
    const events = await drain(producer.stream)

    expect(events).toEqual([
      { type: 'interaction.cancel', data: { id: 'q-1', reason: 'timeout' } },
      { type: 'error', details: 'boom' },
    ])
    expect(log).toHaveBeenCalledOnce()
  })
})
