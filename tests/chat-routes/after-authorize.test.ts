/**
 * `afterAuthorize` starts a turn's box, keys and session the moment the caller is admitted, so that work overlaps the
 * history read, the lock, the history recheck and the user-row insert. Three things
 * make that safe, and each is checked through the composed route:
 *
 *  - it never runs for a caller `authorize` or `modelPolicy` refused, because billable work waits for admission;
 *  - `produce` receives what it started, through the context both seams share;
 *  - a turn that ends without `produce` (held lock, changed history, a gate's answer, a prepareTurn refusal, a throw)
 *    frees it once, without making the refusal wait, and a turn that reaches `produce` never frees it.
 */
import { describe, expect, it } from 'vitest'

import {
  createChatTurnRoutes,
  TURN_PROGRESS_FIRST,
  TURN_PROGRESS_HEADER,
  settleTurnResponse,
  type ChatTurnAuthorization,
  type ChatTurnGateResult,
  type ChatTurnLockResult,
  type ChatTurnMessageStore,
  type ChatTurnPrepareResult,
} from '../../src/chat-routes/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'

interface Context {
  /** What `afterAuthorize` started: the box a producer awaits. */
  box?: Promise<string>
}

function harness(options: {
  lock?: ChatTurnLockResult
  gate?: ChatTurnGateResult
  prepare?: ChatTurnPrepareResult
  authorize?: ChatTurnAuthorization<Context>
  modelDenied?: boolean
  afterAuthorize?: 'throws' | 'async-release'
  /** The thread's rows at the nth read (1-based). */
  history?: (read: number) => { id: string; role: 'user' | 'assistant'; content: string }[]
} = {}) {
  const events: string[] = []
  const pending: Promise<unknown>[] = []
  let reads = 0
  const store: ChatTurnMessageStore = {
    async listMessages() { events.push('history'); reads += 1; return options.history?.(reads) ?? [] },
    async appendMessage(input) { events.push(`append:${input.role}`); return { id: `m-${events.length}` } },
  }
  const release = { calls: 0 }
  const routes = createChatTurnRoutes<Context>({
    projectId: 'after-authorize',
    authorize: async () => options.authorize ?? { ok: true, tenantId: 'ws-1', userId: 'user-1', context: {} },
    ...(options.modelDenied ? { modelPolicy: { catalog: [], filter: () => true } } : {}),
    afterAuthorize: ({ context, threadId, tenantId, userId }) => {
      events.push(`afterAuthorize:${tenantId}:${userId}:${threadId}`)
      if (options.afterAuthorize === 'throws') throw new Error('box start exploded')
      context.box = Promise.resolve('box-1')
      return () => {
        release.calls += 1
        events.push('release')
        // A product that waits for its unused box to settle before it frees keys must not hold the answer.
        if (options.afterAuthorize === 'async-release') return new Promise<void>(() => {})
      }
    },
    store,
    turnStore: createMemoryTurnEventStore(),
    incrementalPersistence: false,
    turnLock: {
      acquire: () => { events.push('lock.acquire'); return options.lock ?? { acquired: true as const, handle: 'lock' } },
      release: () => { events.push('lock.release') },
    },
    prepareTurn: async () => { events.push('prepareTurn'); return options.prepare ?? { ok: true } },
    contextGate: async () => { events.push('gate'); return options.gate ?? { proceed: true } },
    produce: async ({ context }) => {
      events.push('produce')
      const box = await context.box
      return {
        stream: (async function* () { yield { type: 'text', text: `answered on ${box}` } as { type: string; data?: Record<string, unknown> } })(),
        finalText: () => `answered on ${box}`,
      }
    },
    log: () => {},
  })
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p) } }
  return { routes, events, release, ctx, pending }
}

function turnRequest(extra: Record<string, unknown> = {}, progressFirst = false): Request {
  return new Request('http://app.test/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(progressFirst ? { [TURN_PROGRESS_HEADER]: TURN_PROGRESS_FIRST } : {}) },
    body: JSON.stringify({ threadId: 't-1', content: 'hi', ...extra }),
  })
}

describe.each([
  ['plain', false],
  ['progress-first', true],
])('afterAuthorize (%s)', (_name, progressFirst) => {
  it('starts after admission, before prepareTurn, the history read and the lock, and produce receives what it started', async () => {
    const h = harness()
    const response = await h.routes.turn(turnRequest({}, progressFirst), h.ctx)
    expect(await response.text()).toContain('answered on box-1')
    await Promise.all(h.pending)
    expect(h.events.slice(0, 5)).toEqual(['afterAuthorize:ws-1:user-1:t-1', 'prepareTurn', 'history', 'lock.acquire', 'history'])
    expect(h.events).toContain('produce')
    // The turn owns the work now: the route frees nothing the producer took.
    expect(h.release.calls).toBe(0)
  })

  it('never starts for a refused caller', async () => {
    const h = harness({ authorize: { ok: false, response: Response.json({ error: 'nope' }, { status: 403 }) } })
    const response = await h.routes.turn(turnRequest({}, progressFirst), h.ctx)
    expect(response.status).toBe(403)
    expect(h.events).toEqual([])
  })

  it('never starts for a model the policy refused', async () => {
    const h = harness({ modelDenied: true })
    const response = await h.routes.turn(turnRequest({ model: 'acme/unclassified' }, progressFirst), h.ctx)
    expect(response.status).toBe(403)
    expect(h.events).toEqual([])
  })

  it.each([
    ['a held lock', { lock: { acquired: false, response: Response.json({ code: 'chat_turn_in_flight' }, { status: 409 }) } as ChatTurnLockResult }, 409],
    ['a gate that answers', { gate: { proceed: false, response: Response.json({ answered: true }, { status: 200 }) } as ChatTurnGateResult }, 200],
    ['a prepareTurn refusal', { prepare: { ok: false, response: Response.json({ error: 'bad profile' }, { status: 400 }) } as ChatTurnPrepareResult }, 400],
    // The recheck under the lock sees a row the first read did not: another tab sent a message.
    ['a history that changed under the lock', { history: (read: number) => (read === 1 ? [] : [{ id: 'm-late', role: 'user' as const, content: 'sent from another tab' }]) }, 409],
  ])('frees the work once when %s ends the turn before produce', async (_case, setup, status) => {
    const h = harness(setup)
    const response = await h.routes.turn(turnRequest({}, progressFirst), h.ctx)
    const settled = await settleTurnResponse(response, () => {})
    await Promise.all(h.pending)
    expect(settled.status).toBe(status)
    expect(h.release.calls).toBe(1)
    expect(h.events).not.toContain('produce')
  })

  it('answers a refusal without waiting for the product to free its work', async () => {
    const h = harness({
      afterAuthorize: 'async-release',
      lock: { acquired: false, response: Response.json({ code: 'chat_turn_in_flight' }, { status: 409 }) },
    })
    const response = await h.routes.turn(turnRequest({}, progressFirst), h.ctx)
    const settled = await settleTurnResponse(response, () => {})
    expect(settled.status).toBe(409)
    expect(h.release.calls).toBe(1)
  })

  it('goes on without the early work when the seam throws', async () => {
    const h = harness({ afterAuthorize: 'throws' })
    const response = await h.routes.turn(turnRequest({}, progressFirst), h.ctx)
    expect(await response.text()).toContain('answered on undefined')
    await Promise.all(h.pending)
    expect(h.release.calls).toBe(0)
  })
})
