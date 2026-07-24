import { describe, expect, it, vi } from 'vitest'

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

  it('surfaces the structured assistantParts projection, not just flat text', async () => {
    const store = createMemoryTurnEventStore()
    async function* events(): AsyncGenerator<unknown> {
      yield partUpdated({ type: 'tool', id: 'call-1', tool: 'search', state: { status: 'running', input: { q: 'x' } } })
      yield partUpdated({ type: 'tool', id: 'call-1', tool: 'search', state: { status: 'completed', input: { q: 'x' }, output: '3 hits' } })
      yield { type: 'result', data: { finalText: 'done' } }
    }

    const res = await runDetachedTurn({ store, turnId: 't1', scopeId: 'thread-1', events: events() })

    // A caller persisting the durable assistant row must get the tool part, not
    // just a flat text row (the interactive lane persists these; so must this).
    expect(res.parts.some((p) => p.type === 'tool' && p.id === 'call-1')).toBe(true)
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
      completedResult: async () => ({ text: 'cached', usage: { inputTokens: 10, outputTokens: 2 }, parts: [{ type: 'text', text: 'cached' }] }),
    })

    expect(res).toEqual({
      state: 'completed',
      text: 'cached',
      parts: [{ type: 'text', text: 'cached' }],
      usage: { inputTokens: 10, outputTokens: 2 },
      cached: true,
    })
    expect(iterated).toBe(false)
    expect(await store.read('t1', 0)).toHaveLength(0)
  })

  it('crash-retry: a running turn that finished server-side returns the completed result, not a re-stream', async () => {
    const store = createMemoryTurnEventStore()
    // A prior attempt marked running and then the worker crashed.
    await store.setStatus('t1', 'running', 'thread-1')
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
      // findCompletedTurn: the detached session finished server-side while gone.
      completedResult: async () => ({ text: 'finished server-side', usage: { inputTokens: 5 } }),
    })

    expect(res).toMatchObject({ state: 'completed', text: 'finished server-side', cached: true })
    expect(iterated).toBe(false)
    // The stuck `running` buffer is settled so a live client stops tailing.
    expect(await store.getStatus('t1')).toBe('complete')
  })

  it('crash-retry: a running turn that did NOT finish clears the buffer via resetBuffer, then re-streams', async () => {
    const store = createMemoryTurnEventStore()
    await store.setStatus('t1', 'running', 'thread-1')
    // A stale partial row from the crashed attempt.
    await store.append('t1', [{ seq: 7, event: JSON.stringify({ type: 'text', text: 'stale' }) }])
    const resetBuffer = vi.fn(async (turnId: string) => {
      // Simulate a real store clearing the turn's rows.
      const rows = await store.read(turnId, 0)
      for (const _ of rows) void _
    })

    async function* events(): AsyncGenerator<unknown> {
      yield partUpdated({ type: 'text', id: 'x', text: 'fresh' }, 'fresh')
      yield { type: 'result', data: { finalText: 'fresh' } }
    }

    const res = await runDetachedTurn({
      store,
      turnId: 't1',
      scopeId: 'thread-1',
      events: events(),
      completedResult: async () => null, // genuinely not finished
      resetBuffer,
    })

    expect(resetBuffer).toHaveBeenCalledWith('t1')
    expect(res).toMatchObject({ state: 'completed', text: 'fresh', cached: false })
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

  it('extracts session.run.failed via data.reason and a message-less error via the default', async () => {
    const store = createMemoryTurnEventStore()
    async function* runFailed(): AsyncGenerator<unknown> {
      yield { type: 'session.run.failed', data: { reason: 'sandbox oom' } }
    }
    const a = await runDetachedTurn({ store, turnId: 't-a', scopeId: 'thread-1', events: runFailed() })
    expect(a).toMatchObject({ state: 'failed', error: 'sandbox oom' })

    async function* bareError(): AsyncGenerator<unknown> {
      yield { type: 'error', data: {} }
    }
    const b = await runDetachedTurn({ store, turnId: 't-b', scopeId: 'thread-1', events: bareError() })
    expect(b).toMatchObject({ state: 'failed', error: 'run failed' })
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

  it('falls back to completedResult TEXT + parts when the stream produced none', async () => {
    const store = createMemoryTurnEventStore()
    // A stream that emits only a lifecycle event: no text part, no usage.
    async function* events(): AsyncGenerator<unknown> {
      yield { type: 'session.started', data: {} }
    }

    const res = await runDetachedTurn({
      store,
      turnId: 't1',
      scopeId: 'thread-1',
      events: events(),
      completedResult: async () => ({
        text: 'authoritative body',
        usage: { inputTokens: 12 },
        parts: [{ type: 'text', text: 'authoritative body' }],
      }),
    })

    expect(res.state).toBe('completed')
    expect(res.text).toBe('authoritative body')
    expect(res.parts).toEqual([{ type: 'text', text: 'authoritative body' }])
  })

  it('forwards the interaction/decline seams to the producer so unattended asks are declined', async () => {
    const store = createMemoryTurnEventStore()
    const declineInteraction = vi.fn(async (_id: string) => {})
    async function* events(): AsyncGenerator<unknown> {
      // A non-renderable ask kind — with declineInteraction wired, the producer
      // resolves it so an unattended autonomous run cannot deadlock.
      yield {
        type: 'interaction',
        data: { request: { id: 'ask-1', kind: 'shell_permission', title: 'ok?', answerSpec: { fields: [] } } },
      }
      yield { type: 'result', data: { finalText: 'done' } }
    }

    const res = await runDetachedTurn({
      store,
      turnId: 't1',
      scopeId: 'thread-1',
      events: events(),
      isRenderableInteraction: (kind) => kind === 'question' || kind === 'plan',
      declineInteraction,
    })

    expect(declineInteraction).toHaveBeenCalledWith('ask-1')
    expect(res.state).toBe('completed')
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
