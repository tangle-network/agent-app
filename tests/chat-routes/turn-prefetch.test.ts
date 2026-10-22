/**
 * The route's `prefetch` reads a turn's prompt inputs while `authorize` finishes. Checked through the composed route:
 *
 *  - a refused turn runs the prefetch (started at `identified`) but answers today's refusal, aborts the prefetch,
 *    writes no row and hands nothing on;
 *  - an allowed turn's prefetch starts before `authorize` ends, and `produce` starts only after `authorize` ends,
 *    with the prefetched value for that identity;
 *  - an `authorize` that never calls `identified` still gets the prefetch, after it allows the turn.
 */
import { describe, expect, it } from 'vitest'

import { createChatTurnRoutes, type ChatTurnAuthorization, type ChatTurnMessageStore } from '../../src/chat-routes/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function harness(options: { refuse?: boolean; signal?: boolean } = {}) {
  const log: Array<{ at: number; what: string }> = []
  const mark = (what: string) => log.push({ at: performance.now(), what })
  const rows: string[] = []
  const store: ChatTurnMessageStore = {
    async listMessages() { return [] },
    async appendMessage(input) { rows.push(input.role); return { id: `m-${rows.length}` } },
  }
  const signals: AbortSignal[] = []
  const prefetchedSeen: unknown[] = []
  const routes = createChatTurnRoutes<Record<string, never>>({
    projectId: 'turn-prefetch',
    authorize: async ({ identified }): Promise<ChatTurnAuthorization<Record<string, never>>> => {
      mark('authorize.start')
      await tick(10)
      // Identity verified; the slow checks (billing, rate limits) follow.
      if (options.signal !== false) identified?.({ tenantId: 'ws-1', userId: 'user-1' })
      await tick(80)
      mark('authorize.end')
      if (options.refuse) return { ok: false, response: Response.json({ error: 'No seat' }, { status: 402 }) }
      return { ok: true, tenantId: 'ws-1', userId: 'user-1', context: {} }
    },
    prefetch: async ({ tenantId, userId, signal }) => {
      mark('prefetch.start')
      signals.push(signal)
      await tick(40)
      mark('prefetch.end')
      return { prompt: `profile for ${userId} in ${tenantId}` }
    },
    store,
    turnStore: createMemoryTurnEventStore(),
    incrementalPersistence: false,
    produce: async (args) => {
      mark('produce.start')
      prefetchedSeen.push(await args.prefetched)
      return {
        stream: (async function* () { yield { type: 'message.part.updated', data: { part: { type: 'text', text: 'ok' }, delta: 'ok' } } })(),
        finalText: () => 'ok',
      }
    },
    log: () => {},
  })
  const pending: Promise<unknown>[] = []
  const send = () => routes.turn(new Request('http://app.test/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: 't-1', content: 'hi' }),
  }), { waitUntil: (p: Promise<unknown>) => { pending.push(p) } })
  const at = (what: string) => log.find((entry) => entry.what === what)?.at
  return { send, log, rows, signals, prefetchedSeen, pending, at }
}

describe('turn prefetch', () => {
  it('answers a refused turn with its refusal, aborts the prefetch and hands nothing on', async () => {
    const h = harness({ refuse: true })
    const response = await h.send()
    expect(response.status).toBe(402)
    expect(await response.json()).toEqual({ error: 'No seat' })
    expect(h.at('prefetch.start')).toBeDefined()
    expect(h.signals[0]!.aborted).toBe(true)
    expect(h.at('produce.start')).toBeUndefined()
    expect(h.prefetchedSeen).toEqual([])
    expect(h.rows).toEqual([])
  })

  it('reads beside authorize and hands the result to produce only after authorize ends', async () => {
    const h = harness()
    const response = await h.send()
    await response.text()
    await Promise.all(h.pending)
    expect(h.at('prefetch.start')!).toBeLessThan(h.at('authorize.end')!)
    expect(h.at('produce.start')!).toBeGreaterThanOrEqual(h.at('authorize.end')!)
    expect(h.prefetchedSeen).toEqual([{ prompt: 'profile for user-1 in ws-1' }])
    expect(h.signals[0]!.aborted).toBe(false)
  })

  it('still prefetches for an authorize that never calls identified, after it allows the turn', async () => {
    const h = harness({ signal: false })
    const response = await h.send()
    await response.text()
    await Promise.all(h.pending)
    expect(h.at('prefetch.start')!).toBeGreaterThanOrEqual(h.at('authorize.end')!)
    expect(h.prefetchedSeen).toEqual([{ prompt: 'profile for user-1 in ws-1' }])
  })
})
