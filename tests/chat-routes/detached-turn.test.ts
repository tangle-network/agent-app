import { describe, expect, it } from 'vitest'

import { runDetachedTurn } from '../../src/chat-routes/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'

function partUpdated(part: Record<string, unknown>, delta?: string): Record<string, unknown> {
  return { type: 'message.part.updated', data: { part, ...(delta !== undefined ? { delta } : {}) } }
}

describe('runDetachedTurn', () => {
  it('projects a detached turn into the buffer and is discoverable mid-run', async () => {
    const store = createMemoryTurnEventStore()
    let runningMidStream: string[] = []
    async function* events(): AsyncGenerator<unknown> {
      yield partUpdated({ type: 'text', id: 'x1', text: 'Hel' }, 'Hel')
      // The browser re-attach path (`listRunning(scopeId)`) must find this turn
      // WHILE it is still streaming — that is the whole point of the tap.
      runningMidStream = await store.listRunning!('thread-1')
      yield partUpdated({ type: 'text', id: 'x1', text: 'Hello' })
      yield { type: 'result', data: { finalText: 'Hello' } }
    }

    const res = await runDetachedTurn({
      store,
      turnId: 't1',
      scopeId: 'thread-1',
      model: 'anthropic/claude',
      events: events(),
    })

    expect(res).toMatchObject({ state: 'completed', text: 'Hello', cached: false })
    expect(runningMidStream).toContain('t1')
    expect(await store.getStatus('t1')).toBe('complete')
    const buffered = await store.read('t1', 0)
    expect(buffered.length).toBeGreaterThan(0)
  })

  it('is idempotent: an already-complete turn returns the cached result without re-streaming', async () => {
    const store = createMemoryTurnEventStore()
    await store.setStatus('t1', 'complete', 'thread-1')
    let iterated = false
    async function* events(): AsyncGenerator<unknown> {
      iterated = true
      yield partUpdated({ type: 'text', id: 'x', text: 'nope' }, 'nope')
    }

    const res = await runDetachedTurn({
      store,
      turnId: 't1',
      scopeId: 'thread-1',
      events: events(),
      completedResult: async () => ({ text: 'cached', usage: { inputTokens: 10, outputTokens: 2 } }),
    })

    expect(res).toEqual({
      state: 'completed',
      text: 'cached',
      usage: { inputTokens: 10, outputTokens: 2 },
      cached: true,
    })
    expect(iterated).toBe(false)
    expect(await store.read('t1', 0)).toHaveLength(0)
  })

  it('marks the turn failed on a terminal error event, keeping partial text', async () => {
    const store = createMemoryTurnEventStore()
    async function* events(): AsyncGenerator<unknown> {
      yield partUpdated({ type: 'text', id: 'x1', text: 'partial' }, 'partial')
      yield { type: 'error', data: { message: 'model exploded' } }
    }

    const res = await runDetachedTurn({ store, turnId: 't1', scopeId: 'thread-1', events: events() })

    expect(res).toMatchObject({ state: 'failed', error: 'model exploded' })
    expect(await store.getStatus('t1')).toBe('error')
  })

  it('falls back to completedResult for usage when the stream carries none', async () => {
    const store = createMemoryTurnEventStore()
    async function* events(): AsyncGenerator<unknown> {
      yield partUpdated({ type: 'text', id: 'x1', text: 'hi' }, 'hi')
      yield { type: 'result', data: { finalText: 'hi' } }
    }

    const res = await runDetachedTurn({
      store,
      turnId: 't1',
      scopeId: 'thread-1',
      events: events(),
      completedResult: async () => ({ usage: { inputTokens: 200, outputTokens: 40, costUsd: 0.03 } }),
    })

    expect(res.state).toBe('completed')
    expect(res.text).toBe('hi')
    expect(res.usage).toMatchObject({ inputTokens: 200, outputTokens: 40, costUsd: 0.03 })
  })

  it('settles error and rethrows when the stream throws mid-turn', async () => {
    const store = createMemoryTurnEventStore()
    async function* events(): AsyncGenerator<unknown> {
      yield partUpdated({ type: 'text', id: 'x1', text: 'oops' }, 'oops')
      throw new Error('stream died')
    }

    await expect(
      runDetachedTurn({ store, turnId: 't1', scopeId: 'thread-1', events: events() }),
    ).rejects.toThrow('stream died')
    expect(await store.getStatus('t1')).toBe('error')
  })
})
