import { describe, expect, it, vi } from 'vitest'
import {
  readCompletedSandboxTurn,
  runDetachedTurn,
  type CompletedSandboxTurnSource,
} from '../../src/chat-routes/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'

const identity = { turnId: 'turn', sessionId: 'session' }
function recoverySource(input: { cache?: unknown; messages?: unknown[]; cacheError?: boolean; messagesError?: boolean } = {}) {
  const aggregate = vi.fn(async () => ({ response: 'A newer turn finished', usage: { inputTokens: 99_999 } }))
  const box = {
    findCompletedTurn: vi.fn(async () => {
      if (input.cacheError) throw new Error('cache unavailable')
      return input.cache ?? null
    }),
    session: vi.fn(() => ({
      messages: vi.fn(async () => {
        if (input.messagesError) throw new Error('messages unavailable')
        return input.messages ?? []
      }),
      result: aggregate,
    })),
  } as unknown as CompletedSandboxTurnSource
  return { box, aggregate }
}
const completedMessage = () => ({
  id: 'assistant', role: 'assistant', timestamp: '2030-01-01T00:00:00Z',
  metadata: { turnId: 'turn', completed: true },
  parts: [{ type: 'text', id: 'text', text: 'The original answer' }],
})

describe('exact completed-turn recovery', () => {
  it.each([{ cacheError: true }, { messagesError: true }, { cacheError: true, messagesError: true }])(
    'does not treat unavailable evidence as absence: %j', async input => {
      await expect(readCompletedSandboxTurn(recoverySource(input).box, identity)).rejects.toThrow('could not be verified')
    },
  )
  it('does not read a session aggregate that may have advanced after the message read', async () => {
    const source = recoverySource({ messages: [completedMessage()] })
    const result = await readCompletedSandboxTurn(source.box, identity)
    expect(result?.text).toBe('The original answer')
    expect(result?.usage).toBeUndefined()
    expect(source.aggregate).not.toHaveBeenCalled()
  })
  it('retains message-specific usage while the cache is unavailable', async () => {
    const message = completedMessage()
    const source = recoverySource({ cacheError: true, messages: [{ ...message, parts: [
      ...message.parts, { type: 'step-finish', tokens: { input: 7, output: 2 }, cost: 0.01 },
    ] }] })
    await expect(readCompletedSandboxTurn(source.box, identity)).resolves.toMatchObject({
      text: 'The original answer', usage: { inputTokens: 7, outputTokens: 2, costUsd: 0.01 },
    })
    expect(source.aggregate).not.toHaveBeenCalled()
  })
  it('recovers an independently keyed cache when session reads fail', async () => {
    const source = recoverySource({ messagesError: true, cache: {
      ...identity, completedAt: '2030-01-01T00:00:00Z', result: { response: 'Keyed result', usage: { inputTokens: 8 } },
    } })
    await expect(readCompletedSandboxTurn(source.box, identity)).resolves.toMatchObject({ text: 'Keyed result' })
  })
  it('healthy absent reads remain a non-completed result', async () => {
    await expect(readCompletedSandboxTurn(recoverySource().box, identity)).resolves.toBeNull()
  })
})

function forbiddenEvents() {
  const opened = vi.fn()
  const events = (async function* () {
    opened()
    yield { type: 'result', data: { finalText: 'Unexpected replay' } }
  })()
  return { opened, events }
}

describe('detached recovery admission guards', () => {
  it('refuses to consume a source when its retained status is unavailable', async () => {
    const store = createMemoryTurnEventStore()
    vi.spyOn(store, 'getStatus').mockRejectedValue(new Error('status unavailable'))
    const source = forbiddenEvents()
    await expect(runDetachedTurn({ store, turnId: 'turn', scopeId: 'thread', events: source.events }))
      .rejects.toThrow('status unavailable')
    expect(source.opened).not.toHaveBeenCalled()
  })

  it.each(['running', 'complete'] as const)('does not reopen %s when its exact result cannot be read', async status => {
    const store = createMemoryTurnEventStore()
    await store.setStatus('turn', status, 'thread')
    const source = forbiddenEvents()
    const resetBuffer = vi.fn(async () => undefined)
    await expect(runDetachedTurn({
      store, turnId: 'turn', scopeId: 'thread', events: source.events, resetBuffer,
      completedResult: async () => { throw new Error('completion unavailable') },
    })).rejects.toThrow('completion unavailable')
    expect(source.opened).not.toHaveBeenCalled()
    expect(resetBuffer).not.toHaveBeenCalled()
    expect(await store.getStatus('turn')).toBe(status)
  })

  it.each([false, true])('refuses an absent/failed reset before replay: failure=%s', async failReset => {
    const store = createMemoryTurnEventStore()
    await store.setStatus('turn', 'running', 'thread')
    const retained = [{ seq: 7, event: '{"type":"text","text":"Retained"}' }]
    await store.append('turn', retained)
    const source = forbiddenEvents()
    await expect(runDetachedTurn({
      store, turnId: 'turn', scopeId: 'thread', events: source.events,
      completedResult: async () => null,
      ...(failReset ? { resetBuffer: async () => { throw new Error('reset unavailable') } } : {}),
    })).rejects.toThrow(failReset ? 'reset unavailable' : 'requires resetBuffer')
    expect(source.opened).not.toHaveBeenCalled()
    expect(await store.read('turn', 0)).toEqual(retained)
  })

  it('returns the exact completed result without another stream or buffer reset', async () => {
    const store = createMemoryTurnEventStore()
    await store.setStatus('turn', 'running', 'thread')
    const source = forbiddenEvents()
    const resetBuffer = vi.fn(async () => undefined)
    await expect(runDetachedTurn({
      store, turnId: 'turn', scopeId: 'thread', events: source.events, resetBuffer,
      completedResult: async () => ({ text: 'Retained result', usage: { inputTokens: 8 } }),
    })).resolves.toMatchObject({ state: 'completed', cached: true, text: 'Retained result' })
    expect(source.opened).not.toHaveBeenCalled()
    expect(resetBuffer).not.toHaveBeenCalled()
    expect(await store.getStatus('turn')).toBe('complete')
  })

  it('does not acknowledge a failed terminal-status write as successful settlement', async () => {
    const store = createMemoryTurnEventStore()
    await store.setStatus('turn', 'running', 'thread')
    vi.spyOn(store, 'setStatus').mockRejectedValueOnce(new Error('status write unavailable'))
    const source = forbiddenEvents()
    await expect(runDetachedTurn({
      store, turnId: 'turn', scopeId: 'thread', events: source.events,
      completedResult: async () => ({ text: 'Remote completion' }),
    })).rejects.toThrow('status write unavailable')
    expect(source.opened).not.toHaveBeenCalled()
    expect(await store.getStatus('turn')).toBe('running')
  })

  it('the shared completion reader propagates uncertainty through the detached wrapper', async () => {
    const store = createMemoryTurnEventStore()
    await store.setStatus('turn', 'running', 'thread')
    const source = forbiddenEvents()
    const remote = recoverySource({ cacheError: true, messagesError: true })
    const resetBuffer = vi.fn(async () => undefined)
    await expect(runDetachedTurn({
      store, turnId: 'turn', scopeId: 'thread', events: source.events, resetBuffer,
      completedResult: () => readCompletedSandboxTurn(remote.box, identity),
    })).rejects.toThrow('could not be verified')
    expect(source.opened).not.toHaveBeenCalled()
    expect(resetBuffer).not.toHaveBeenCalled()
  })
})


describe('cached completion evidence', () => {
  it('does not fabricate an empty success when both retained result and row are missing', async () => {
    const store = createMemoryTurnEventStore()
    await store.setStatus('turn', 'complete', 'thread')
    const source = forbiddenEvents()
    await expect(runDetachedTurn({
      store, turnId: 'turn', scopeId: 'thread', events: source.events,
      completedResult: async () => null,
    })).rejects.toThrow('no retained result or assistant row')
    expect(source.opened).not.toHaveBeenCalled()
  })

  it.each([undefined, { inputTokens: 0, costUsd: 0 }])(
    'keeps exact persisted usage unless the completed receipt supplies a measurement: %j', async override => {
      const store = createMemoryTurnEventStore()
      await store.setStatus('turn', 'complete', 'thread')
      const source = forbiddenEvents()
      const row = {
        id: 'assistant:turn', role: 'assistant' as const, content: 'Persisted answer',
        inputTokens: 11, outputTokens: 4, reasoningTokens: 2,
        cacheReadTokens: 3, cacheWriteTokens: 1, costUsd: 0.12,
      }
      const updateMessage = vi.fn(async () => row)
      const result = await runDetachedTurn({
        store, turnId: 'turn', scopeId: 'thread', events: source.events,
        completedResult: async () => ({ text: 'Persisted answer', usage: override }),
        persist: { threadId: 'thread', store: {
          listMessages: async () => [row], appendMessage: vi.fn(async () => row), updateMessage,
        } },
      })
      const usage = { inputTokens: 11, outputTokens: 4, reasoningTokens: 2,
        cacheReadTokens: 3, cacheWriteTokens: 1, costUsd: 0.12, ...override }
      expect(result).toMatchObject({ cached: true, usage })
      expect(updateMessage).toHaveBeenCalledWith('assistant:turn', expect.objectContaining(usage))
      expect(source.opened).not.toHaveBeenCalled()
    },
  )

  it('keeps absent usage unknown rather than manufacturing a zero receipt', async () => {
    const store = createMemoryTurnEventStore()
    await store.setStatus('turn', 'complete', 'thread')
    const source = forbiddenEvents()
    const result = await runDetachedTurn({ store, turnId: 'turn', scopeId: 'thread', events: source.events,
      completedResult: async () => ({ text: 'Completed without reported usage' }),
    })
    expect(result.usage).toEqual({})
    expect(source.opened).not.toHaveBeenCalled()
  })
})
