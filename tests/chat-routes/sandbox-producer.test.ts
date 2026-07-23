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

  it('terminalizes a tool left running when the stream ends abnormally', async () => {
    const producer = createSandboxChatProducer({
      events: feed([
        partUpdated({ type: 'tool', id: 'call-1', tool: 'search', state: { status: 'running', input: { q: 'x' } } }),
        // Stream ends here — no tool_result, no result event.
      ]),
    })
    await drain(producer.stream)

    const parts = producer.assistantParts?.() ?? []
    expect(parts[0]).toMatchObject({
      type: 'tool',
      id: 'call-1',
      state: { status: 'error', metadata: { terminalized: true } },
    })
    expect(parts.some((p) => (p.state as Record<string, unknown> | undefined)?.status === 'running')).toBe(false)
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

  it('promotes a file part exactly once across duplicate stream events and drops the raw url-bearing part', async () => {
    const promoteFilePart = vi.fn(async (raw: Record<string, unknown>) => ({
      succeeded: true as const,
      part: { type: 'file', id: raw.id, filename: raw.filename, path: `vault/${raw.filename}` },
      key: `attachment:vault/${raw.filename}`,
    }))
    const producer = createSandboxChatProducer({
      events: feed([
        partUpdated({ type: 'file', id: 'f1', filename: 'out.csv', url: 'data:text/csv;base64,AA' }),
        // Duplicate re-emission of the same part (same id) — must fold onto
        // the first promotion, not trigger a second one.
        partUpdated({ type: 'file', id: 'f1', filename: 'out.csv', url: 'data:text/csv;base64,AA' }),
      ]),
      promoteFilePart,
    })
    await drain(producer.stream)

    expect(promoteFilePart).toHaveBeenCalledOnce()
    expect(producer.assistantParts?.()).toEqual([
      { type: 'file', id: 'f1', filename: 'out.csv', path: 'vault/out.csv' },
    ])
  })

  it('falls back to persisting the raw file part when promotion reports failure', async () => {
    const promoteFilePart = vi.fn(async () => ({ succeeded: false as const, reason: 'too large' }))
    const producer = createSandboxChatProducer({
      events: feed([
        partUpdated({ type: 'file', id: 'f1', filename: 'out.csv', url: 'data:text/csv;base64,AA' }),
      ]),
      promoteFilePart,
    })
    const events = await drain(producer.stream)

    expect(events).toEqual([])
    expect(promoteFilePart).toHaveBeenCalledOnce()
    expect(producer.assistantParts?.()).toEqual([
      { type: 'file', id: 'f1', filename: 'out.csv', url: 'data:text/csv;base64,AA' },
    ])
  })

  it('falls back to the raw file part and keeps draining when the promotion callback throws', async () => {
    const log = vi.fn()
    const promoteFilePart = vi.fn(async () => {
      throw new Error('vault write failed')
    })
    const producer = createSandboxChatProducer({
      events: feed([
        partUpdated({ type: 'file', id: 'f1', filename: 'out.csv', url: 'data:text/csv;base64,AA' }),
        partUpdated({ type: 'text', id: 't1', text: 'still here' }, 'still here'),
      ]),
      promoteFilePart,
      log,
    })
    const events = await drain(producer.stream)

    expect(promoteFilePart).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith(
      '[chat-routes] file part promotion threw',
      expect.objectContaining({ key: 'f1', error: 'vault write failed' }),
    )
    expect(events).toEqual([{ type: 'text', text: 'still here' }])
    expect(producer.assistantParts?.()).toEqual([
      { type: 'file', id: 'f1', filename: 'out.csv', url: 'data:text/csv;base64,AA' },
      expect.objectContaining({ type: 'text', text: 'still here' }),
    ])
  })

  it('leaves file/image persistence byte-identical to today when promoteFilePart is not wired', async () => {
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

  it('invokes promotion (un-memoized) for a file part with neither id nor url', async () => {
    // gtm never skips promotion outright — a part with no id/url still gets
    // routed through the callback, which fails "carries no url" on its own;
    // there is simply nothing to key a memo on, so each occurrence is its own
    // un-memoized attempt.
    const promoteFilePart = vi.fn(async () => ({ succeeded: true as const, part: { type: 'file' } }))
    const producer = createSandboxChatProducer({
      events: feed([
        partUpdated({ type: 'file', filename: 'mystery.bin' }),
      ]),
      promoteFilePart,
    })
    await drain(producer.stream)

    expect(promoteFilePart).toHaveBeenCalledOnce()
    expect(producer.assistantParts?.()).toEqual([
      { type: 'file' },
    ])
  })

  it('invokes promotion again (not memoized) on a second keyless occurrence', async () => {
    const promoteFilePart = vi.fn(async () => ({ succeeded: false as const, reason: 'no url' }))
    const producer = createSandboxChatProducer({
      events: feed([
        partUpdated({ type: 'file', filename: 'mystery.bin' }),
        partUpdated({ type: 'file', filename: 'mystery.bin' }),
      ]),
      promoteFilePart,
    })
    await drain(producer.stream)

    expect(promoteFilePart).toHaveBeenCalledTimes(2)
  })

  it('persists the substituted part (e.g. a warning notice) on failure, never the raw url-bearing part', async () => {
    const noticePart = { type: 'notice', kind: 'warning', id: 'file-1', text: 'Could not attach out.csv: too large' }
    const promoteFilePart = vi.fn(async () => ({
      succeeded: false as const,
      reason: 'too large',
      part: noticePart,
    }))
    const producer = createSandboxChatProducer({
      events: feed([
        partUpdated({ type: 'file', id: 'f1', filename: 'out.csv', url: 'data:text/csv;base64,AA' }),
      ]),
      promoteFilePart,
    })
    await drain(producer.stream)

    expect(promoteFilePart).toHaveBeenCalledOnce()
    expect(producer.assistantParts?.()).toEqual([noticePart])
    // The raw url-bearing part must be absent — it never reaches the transcript.
    const persisted = producer.assistantParts?.() ?? []
    expect(persisted.some((p) => 'url' in p)).toBe(false)
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
