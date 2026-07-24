import { describe, expect, it, vi } from 'vitest'

import { createSandboxChatProducer } from '../../src/chat-routes/index'

function partUpdated(part: Record<string, unknown>, delta?: string): Record<string, unknown> {
  return { type: 'message.part.updated', data: { part, ...(delta !== undefined ? { delta } : {}) } }
}

async function* feed(events: Array<Record<string, unknown>>): AsyncGenerator<unknown> {
  for (const event of events) yield event
}

async function* throwingFeed(events: Array<Record<string, unknown>>, error: Error): AsyncGenerator<unknown> {
  for (const event of events) yield event
  throw error
}

function interaction(id: string, kind: string): Record<string, unknown> {
  return {
    type: 'interaction',
    data: {
      request: {
        id,
        kind,
        title: 'Need input',
        answerSpec: { fields: [] },
      },
    },
  }
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

  it('uses rich terminal done usage and emits the authoritative token totals', async () => {
    const producer = createSandboxChatProducer({
      events: feed([{
        type: 'done',
        data: {
          tokenUsage: {
            inputTokens: '101',
            outputTokens: 22,
            reasoningTokens: 7,
            cacheReadInputTokens: 11,
            cacheCreationInputTokens: 4,
          },
          totalCostUsd: '0.123',
        },
      }]),
    })

    expect(await drain(producer.stream)).toEqual([
      { type: 'usage', usage: { promptTokens: 101, completionTokens: 22 } },
      expect.objectContaining({ type: 'done' }),
    ])
    expect(producer.usage?.()).toEqual({
      inputTokens: 101,
      outputTokens: 22,
      reasoningTokens: 7,
      cacheReadTokens: 11,
      cacheWriteTokens: 4,
      costUsd: 0.123,
    })
  })

  it('lets later parseable done usage override result usage', async () => {
    const producer = createSandboxChatProducer({
      events: feed([
        { type: 'result', data: { tokenUsage: { inputTokens: 10, outputTokens: 2, cost: 0.01 } } },
        { type: 'done', data: { tokenUsage: { inputTokens: 20, outputTokens: 5 }, totalCostUsd: 0.02 } },
      ]),
    })

    expect(await drain(producer.stream)).toEqual([
      { type: 'usage', usage: { promptTokens: 10, completionTokens: 2 } },
      { type: 'usage', usage: { promptTokens: 20, completionTokens: 5 } },
      expect.objectContaining({ type: 'done' }),
    ])
    expect(producer.usage?.()).toEqual({ inputTokens: 20, outputTokens: 5, costUsd: 0.02 })
  })

  it('retains prior usage when done carries no parseable terminal usage', async () => {
    const producer = createSandboxChatProducer({
      events: feed([
        partUpdated({ type: 'step-finish', tokens: { input: 8, output: 3 }, cost: 0.04 }),
        { type: 'done', data: { tokenUsage: { inputTokens: 'bad', outputTokens: 9 } } },
      ]),
    })

    expect(await drain(producer.stream)).toEqual([
      { type: 'usage', usage: { promptTokens: 8, completionTokens: 3 } },
      expect.objectContaining({ type: 'done' }),
    ])
    expect(producer.usage?.()).toEqual({ inputTokens: 8, outputTokens: 3, costUsd: 0.04 })
  })

  it('maps rich result tokenUsage fields while keeping result swallowed', async () => {
    const producer = createSandboxChatProducer({
      events: feed([{
        type: 'result',
        data: {
          tokenUsage: {
            inputTokens: 44,
            outputTokens: 12,
            reasoningTokens: 3,
            cacheReadInputTokens: 6,
            cacheCreationInputTokens: 2,
            cost: 0.08,
          },
        },
      }]),
    })

    expect(await drain(producer.stream)).toEqual([
      { type: 'usage', usage: { promptTokens: 44, completionTokens: 12 } },
    ])
    expect(producer.usage?.()).toEqual({
      inputTokens: 44,
      outputTokens: 12,
      reasoningTokens: 3,
      cacheReadTokens: 6,
      cacheWriteTokens: 2,
      costUsd: 0.08,
    })
  })

  it('keeps the legacy result.data.usage override as a fallback', async () => {
    const producer = createSandboxChatProducer({
      events: feed([{ type: 'result', data: { usage: { inputTokens: 9, outputTokens: 4 } } }]),
    })

    expect(await drain(producer.stream)).toEqual([])
    expect(producer.usage?.()).toEqual({ inputTokens: 9, outputTokens: 4 })
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
    const producer = createSandboxChatProducer({
      events: feed([interaction('q-1', 'question'), interaction('p-1', 'permission')]),
      declineInteraction,
      log: () => {},
    })
    const events = await drain(producer.stream)

    expect(events).toEqual([
      interaction('q-1', 'question'),
      {
        type: 'notice',
        id: 'auto-declined-p-1',
        noticeKind: 'auto-declined',
        text: 'The agent requested permission approval — auto-declined by policy.',
      },
    ])
    expect(declineInteraction).toHaveBeenCalledExactlyOnceWith('p-1')
    expect(producer.assistantParts?.()).toEqual([
      expect.objectContaining({
        type: 'interaction',
        id: 'q-1',
        status: 'answered',
      }),
      {
        type: 'notice',
        id: 'auto-declined-p-1',
        noticeKind: 'auto-declined',
        text: 'The agent requested permission approval — auto-declined by policy.',
      },
    ])
  })

  it('persists and emits the failed auto-decline notice when decline throws', async () => {
    const producer = createSandboxChatProducer({
      events: feed([interaction('p-2', 'permission')]),
      declineInteraction: async () => { throw new Error('broker down') },
      log: () => {},
    })

    const notice = {
      type: 'notice',
      id: 'auto-declined-p-2',
      noticeKind: 'auto-declined',
      text: 'The agent requested permission approval; declining it failed — it will expire on its own.',
    }
    expect(await drain(producer.stream)).toEqual([notice])
    expect(producer.assistantParts?.()).toEqual([notice])
  })

  it('persists and emits the failed auto-decline notice when no decline callback is wired', async () => {
    const producer = createSandboxChatProducer({
      events: feed([interaction('p-3', 'permission')]),
      log: () => {},
    })

    const notice = {
      type: 'notice',
      id: 'auto-declined-p-3',
      noticeKind: 'auto-declined',
      text: 'The agent requested permission approval; declining it failed — it will expire on its own.',
    }
    expect(await drain(producer.stream)).toEqual([notice])
    expect(producer.assistantParts?.()).toEqual([notice])
  })

  it('gates plan asks through isRenderableInteraction while still forwarding questions', async () => {
    const declineInteraction = vi.fn(async () => {})
    const producer = createSandboxChatProducer({
      events: feed([interaction('plan-1', 'plan'), interaction('q-2', 'question')]),
      isRenderableInteraction: (kind) => kind === 'question',
      declineInteraction,
    })

    const events = await drain(producer.stream)
    expect(events).toEqual([
      expect.objectContaining({
        type: 'notice',
        id: 'auto-declined-plan-1',
        noticeKind: 'auto-declined',
      }),
      interaction('q-2', 'question'),
    ])
    expect(declineInteraction).toHaveBeenCalledExactlyOnceWith('plan-1')
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
      expect.objectContaining({ key: 'id:f1', error: 'vault write failed' }),
    )
    expect(events).toEqual([{ type: 'text', text: 'still here' }])
    expect(producer.assistantParts?.()).toEqual([
      { type: 'file', id: 'f1', filename: 'out.csv', url: 'data:text/csv;base64,AA' },
      expect.objectContaining({ type: 'text', text: 'still here' }),
    ])
  })

  it('falls back to the raw file part and keeps draining when the promotion callback throws SYNCHRONOUSLY (not via a rejected promise)', async () => {
    // A non-async callback whose body throws before ever returning a promise —
    // `promote(part)` itself throws, so a bare `.catch` on its return value has
    // nothing to attach to. The producer must wrap the call so this still
    // resolves through the same `{succeeded:false}` path as a rejected promise.
    const log = vi.fn()
    const promoteFilePart = vi.fn((): Promise<never> => {
      throw new Error('sync boom')
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
      expect.objectContaining({ key: 'id:f1', error: 'sync boom' }),
    )
    // The raw part persists (the fallback path) and the stream keeps draining
    // past the synchronous throw instead of the whole generator dying.
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

  it('persists both promoted parts on the success path for two keyless occurrences, keyed per their own outcome.key (no memo collapse)', async () => {
    let call = 0
    const promoteFilePart = vi.fn(async () => {
      call += 1
      return {
        succeeded: true as const,
        part: { type: 'file', filename: `mystery-${call}.bin`, path: `vault/mystery-${call}.bin` },
        key: `attachment:vault/mystery-${call}.bin`,
      }
    })
    const producer = createSandboxChatProducer({
      events: feed([
        partUpdated({ type: 'file', filename: 'mystery.bin' }),
        partUpdated({ type: 'file', filename: 'mystery.bin' }),
      ]),
      promoteFilePart,
    })
    await drain(producer.stream)

    expect(promoteFilePart).toHaveBeenCalledTimes(2)
    // Each keyless occurrence is its own un-memoized attempt, so both
    // promoted parts land in the transcript under their own `getPartKey`
    // (here, the outcome's own `key`) rather than one collapsing onto the
    // other's memo entry.
    expect(producer.assistantParts?.()).toEqual([
      { type: 'file', filename: 'mystery-1.bin', path: 'vault/mystery-1.bin' },
      { type: 'file', filename: 'mystery-2.bin', path: 'vault/mystery-2.bin' },
    ])
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

  it('persists and emits warning notices while preserving raw warning forwarding', async () => {
    const rawWarning = { type: 'warning', data: { code: 'FILE_DENIED', message: 'Outside workspace' } }
    const producer = createSandboxChatProducer({ events: feed([rawWarning]) })

    expect(await drain(producer.stream)).toEqual([
      {
        type: 'notice',
        id: 'warning-1',
        noticeKind: 'warning',
        text: 'FILE_DENIED: Outside workspace',
      },
      rawWarning,
    ])
    expect(producer.assistantParts?.()).toEqual([{
      type: 'notice',
      id: 'warning-1',
      noticeKind: 'warning',
      text: 'FILE_DENIED: Outside workspace',
    }])
  })

  it('composes raw errors after visible output and forwards the original error last', async () => {
    const rawError = { type: 'error', data: { message: 'upstream reset', retryable: false } }
    const producer = createSandboxChatProducer({
      events: feed([
        partUpdated({ type: 'text', id: 't1', text: 'Partial answer' }, 'Partial answer'),
        rawError,
      ]),
    })

    const events = await drain(producer.stream)
    expect(events).toEqual([
      { type: 'text', text: 'Partial answer' },
      {
        type: 'text',
        text: '\n\n---\nThe sandbox model stream stopped before a clean completion.\n\nError: upstream reset',
      },
      rawError,
    ])
    expect(producer.finalText()).toBe(
      'Partial answer\n\n---\nThe sandbox model stream stopped before a clean completion.\n\nError: upstream reset',
    )
    expect(producer.assistantParts?.()).toEqual([{
      type: 'text',
      text: 'Partial answer\n\n---\nThe sandbox model stream stopped before a clean completion.\n\nError: upstream reset',
    }])
  })

  it('composes a no-visible-answer error without a separator', async () => {
    const rawError = { type: 'error', data: { error: 'model rejected' } }
    const producer = createSandboxChatProducer({ events: feed([rawError]) })

    expect(await drain(producer.stream)).toEqual([
      {
        type: 'text',
        text: 'The sandbox agent returned an error before producing a visible answer.\n\nError: model rejected',
      },
      rawError,
    ])
    expect(producer.finalText()).not.toContain('---')
  })

  it('settles a dangling tool live and in persistence when a raw error arrives', async () => {
    const producer = createSandboxChatProducer({
      events: feed([
        partUpdated({ type: 'tool', id: 'call-2', tool: 'search', state: { status: 'running', input: { q: 'x' } } }),
        { type: 'error', data: { message: 'stream failed' } },
      ]),
    })

    const events = await drain(producer.stream)
    expect(events).toEqual([
      { type: 'tool_call', call: { toolCallId: 'call-2', toolName: 'search', args: { q: 'x' } } },
      expect.objectContaining({ type: 'text' }),
      {
        type: 'tool_result',
        toolCallId: 'call-2',
        toolName: 'search',
        outcome: {
          ok: false,
          message: 'Tool did not report a terminal result before the assistant turn completed.',
        },
      },
      { type: 'error', data: { message: 'stream failed' } },
    ])
    expect(producer.assistantParts?.()).toEqual([
      expect.objectContaining({
        type: 'tool',
        id: 'call-2',
        state: {
          status: 'error',
          input: { q: 'x' },
          error: 'Tool did not report a terminal result before the assistant turn completed.',
          metadata: {
            terminalized: true,
            terminalReason: 'missing-tool-terminal',
          },
        },
      }),
      expect.objectContaining({ type: 'text' }),
    ])
  })

  it('terminalizes each dangling tool only once when error is followed by done', async () => {
    const producer = createSandboxChatProducer({
      events: feed([
        partUpdated({ type: 'tool', id: 'call-3', tool: 'search', state: { status: 'running', input: {} } }),
        { type: 'error', data: { message: 'failed' } },
        { type: 'done', data: {} },
      ]),
    })

    const events = await drain(producer.stream)
    expect(events.filter((event) => event.type === 'tool_result')).toHaveLength(1)
    expect(events.at(-1)).toEqual({ type: 'done', data: {} })
  })

  it('catches a severed stream, persists partial content, and emits a structured failure normally', async () => {
    const streamError = Object.assign(new Error('socket severed'), {
      streamMessage: 'sandbox stream disconnected',
      diagnostics: { sessionId: 's-1', lastEventId: 'evt-9' },
    })
    const producer = createSandboxChatProducer({
      events: throwingFeed([
        partUpdated({ type: 'text', id: 't1', text: 'Partial' }, 'Partial'),
        partUpdated({ type: 'tool', id: 'call-4', tool: 'fetch', state: { status: 'running', input: {} } }),
      ], streamError),
      log: () => {},
    })

    const events = await drain(producer.stream)
    const structuredError = events.at(-1) as {
      type: string
      data: { message: string; code: string; details: { failureNote: string } }
    }
    expect(events.filter((event) => event.type === 'tool_result')).toEqual([
      expect.objectContaining({
        toolCallId: 'call-4',
        outcome: expect.objectContaining({ ok: false }),
      }),
    ])
    expect(structuredError.type).toBe('error')
    expect(structuredError.data.code).toBe('sandbox.stream_failed')
    expect(structuredError.data.message).toContain('Please retry')
    expect(structuredError.data.details.failureNote).toContain('sandbox stream disconnected')
    expect(structuredError.data.details.failureNote).toContain('"lastEventId":"evt-9"')
    expect(producer.finalText()).toContain('Partial\n\n---\nThe sandbox model stream stopped')
    expect(producer.assistantParts?.()).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('Partial\n\n---\nThe sandbox model stream stopped'),
      }),
      expect.objectContaining({
        type: 'tool',
        id: 'call-4',
        state: expect.objectContaining({ status: 'error', metadata: expect.objectContaining({ terminalized: true }) }),
      }),
    ])
  })

  it('finalizes pending interactions as expired on error and answered on clean completion', async () => {
    const failed = createSandboxChatProducer({
      events: feed([interaction('q-expired', 'question'), { type: 'error', data: { message: 'failed' } }]),
    })
    await drain(failed.stream)
    expect(failed.assistantParts?.()).toContainEqual(expect.objectContaining({
      type: 'interaction',
      id: 'q-expired',
      status: 'expired',
    }))

    const clean = createSandboxChatProducer({
      events: feed([interaction('q-answered', 'question'), { type: 'done', data: {} }]),
    })
    await drain(clean.stream)
    expect(clean.assistantParts?.()).toContainEqual(expect.objectContaining({
      type: 'interaction',
      id: 'q-answered',
      status: 'answered',
    }))
  })

  it('still drops malformed interactions while forwarding valid cancel events', async () => {
    const log = vi.fn()
    const producer = createSandboxChatProducer({
      events: feed([
        { type: 'interaction', data: {} },
        { type: 'interaction.cancel', data: { id: 'q-1', reason: 'timeout' } },
      ]),
      log,
    })

    expect(await drain(producer.stream)).toEqual([
      { type: 'interaction.cancel', data: { id: 'q-1', reason: 'timeout' } },
    ])
    expect(log).toHaveBeenCalledOnce()
  })
})
