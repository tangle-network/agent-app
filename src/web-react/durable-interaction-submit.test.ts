import { describe, expect, it, vi } from 'vitest'
import {
  createDurableInteractionAnswerSubmitter,
  createMemoryInteractionAttemptStore,
  createSessionInteractionAttemptStore,
} from './durable-interaction-submit'

describe('createDurableInteractionAnswerSubmitter', () => {
  it('reuses an attempt key after an ambiguous failure and clears it after acknowledgement', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      if (bodies.length === 1) throw new TypeError('connection reset')
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const submit = createDurableInteractionAnswerSubmitter({
      url: '/api/interactions',
      attempts: createMemoryInteractionAttemptStore(),
      createAttemptKey: () => 'attempt-1',
      fetchImpl,
    })
    const submission = { id: 'ask-1', outcome: 'accepted' as const, data: { tone: ['Formal'] } }

    await expect(submit(submission)).resolves.toMatchObject({ ok: false })
    await expect(submit(submission)).resolves.toEqual({ ok: true })
    expect(bodies.map((body) => body.attemptKey)).toEqual(['attempt-1', 'attempt-1'])
  })

  it('uses a new attempt for changed answer data', async () => {
    let sequence = 0
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      throw new TypeError('connection reset')
    }) as unknown as typeof fetch
    const submit = createDurableInteractionAnswerSubmitter({
      url: '/api/interactions',
      attempts: createMemoryInteractionAttemptStore(),
      createAttemptKey: () => `attempt-${++sequence}`,
      fetchImpl,
    })

    await submit({ id: 'ask-1', outcome: 'accepted', data: { tone: ['Formal'] } })
    await submit({ id: 'ask-1', outcome: 'accepted', data: { tone: ['Casual'] } })
    expect(bodies.map((body) => body.attemptKey)).toEqual(['attempt-1', 'attempt-2'])
  })

  it('reuses an attempt key while durable reconciliation is pending', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({ code: 'INTERACTION_RECONCILIATION_PENDING' }), { status: 503 })
    }) as unknown as typeof fetch
    const submit = createDurableInteractionAnswerSubmitter({
      url: '/api/interactions',
      attempts: createMemoryInteractionAttemptStore(),
      createAttemptKey: () => 'attempt-pending',
      fetchImpl,
    })
    const submission = { id: 'ask-1', outcome: 'accepted' as const, data: { confirmed: true } }

    await submit(submission)
    await submit(submission)
    expect(bodies.map((body) => body.attemptKey)).toEqual(['attempt-pending', 'attempt-pending'])
  })

  it('stores full submission signatures without hash collisions', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    }
    const attempts = createSessionInteractionAttemptStore(storage)
    attempts.set('ask-1', '{"answer":"first"}', 'attempt-1')
    attempts.set('ask-1', '{"answer":"second"}', 'attempt-2')

    expect(attempts.get('ask-1', '{"answer":"first"}')).toBe('attempt-1')
    expect(attempts.get('ask-1', '{"answer":"second"}')).toBe('attempt-2')
  })
})
