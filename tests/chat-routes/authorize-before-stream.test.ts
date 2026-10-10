/**
 * Incident-class gate: no shared route answers, opens a stream or touches
 * product state before its `authorize` has resolved, and a refusal is always a
 * plain response.
 *
 * agent-app 0.60.48 and 0.60.49 shipped a progress-first turn stream that
 * opened before `authorize` ran (#944, fixed in #947): an unadmitted caller got
 * an open stream and a stage event before its refusal. Every agent app shares
 * these routes, so the property is checked here for each of them, and for the
 * `prepareTurn` seam that runs product work after admission.
 */
import { describe, expect, it } from 'vitest'

import {
  createChatTurnRoutes,
  settleTurnResponse,
  TURN_PROGRESS_FIRST,
  TURN_PROGRESS_HEADER,
  type ChatTurnAuthorization,
  type ChatTurnMessageStore,
  type ChatTurnPrepareResult,
} from '../../src/chat-routes/index'
import { createMemoryTurnEventStore, type TurnEventStore } from '../../src/stream/index'
import { createTurnStreamUpgradeHandler, type TurnStreamNamespaceLike } from '../../src/turn-stream/index'

const SETTLE_MS = 30

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/** Resolves to `'pending'` when `promise` has not settled within `ms`. */
async function stateAfter(promise: Promise<unknown>, ms = SETTLE_MS): Promise<'pending' | 'settled'> {
  return Promise.race([
    promise.then(() => 'settled' as const, () => 'settled' as const),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms)),
  ])
}

/** Every product-state touch the routes can make, in order. */
function harness() {
  const touches: string[] = []
  const store: ChatTurnMessageStore = {
    async listMessages() { touches.push('store.listMessages'); return [] },
    async appendMessage(input) { touches.push(`store.append:${input.role}`); return { id: `m-${touches.length}` } },
  }
  const memory = createMemoryTurnEventStore()
  const turnStore: TurnEventStore = new Proxy(memory, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        touches.push(`turnStore.${String(key)}`)
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  })
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => { touches.push('waitUntil'); pending.push(p) } }
  return { touches, store, turnStore, ctx, pending }
}

function makeRoutes(
  h: ReturnType<typeof harness>,
  authorize: () => Promise<ChatTurnAuthorization<{ prepared: boolean }>>,
  prepareTurn?: (args: { progress(phase: string, message: string): void; context: { prepared: boolean } }) => Promise<ChatTurnPrepareResult>,
) {
  return createChatTurnRoutes<{ prepared: boolean }>({
    projectId: 'guard',
    authorize,
    store: h.store,
    turnStore: h.turnStore,
    incrementalPersistence: false,
    turnLock: {
      warm: () => { h.touches.push('lock.warm') },
      acquire: () => { h.touches.push('lock.acquire'); return { acquired: true as const, handle: 'lock' } },
      release: () => { h.touches.push('lock.release') },
    },
    ...(prepareTurn ? { prepareTurn: async (args) => { h.touches.push('prepareTurn'); return prepareTurn(args) } } : {}),
    produce: () => {
      h.touches.push('produce')
      return {
        stream: (async function* () { yield { type: 'text', text: 'ok' } as { type: string; data?: Record<string, unknown> } })(),
        finalText: () => 'ok',
      }
    },
    log: () => {},
  })
}

const admitted = (): ChatTurnAuthorization<{ prepared: boolean }> =>
  ({ ok: true, tenantId: 'ws-1', userId: 'user-1', context: { prepared: false } })
const refused = (status: number): ChatTurnAuthorization<{ prepared: boolean }> =>
  ({ ok: false, response: Response.json({ error: `refused ${status}` }, { status }) })

function turnRequest(progressFirst: boolean): Request {
  return new Request('http://app.test/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(progressFirst ? { [TURN_PROGRESS_HEADER]: TURN_PROGRESS_FIRST } : {}),
    },
    body: JSON.stringify({ threadId: 't-1', content: 'hi' }),
  })
}

describe.each([
  ['plain', false],
  ['progress-first', true],
])('turn route (%s): nothing before authorize resolves', (_name, progressFirst) => {
  it('does not answer, stream or touch state while authorize is pending', async () => {
    const h = harness()
    const auth = deferred<ChatTurnAuthorization<{ prepared: boolean }>>()
    const routes = makeRoutes(h, () => auth.promise, async () => ({ ok: true }))
    const response = routes.turn(turnRequest(progressFirst), h.ctx)
    expect(await stateAfter(response)).toBe('pending')
    expect(h.touches).toEqual([])
    auth.resolve(refused(401))
    const answered = await response
    expect(answered.status).toBe(401)
    expect(answered.headers.get(TURN_PROGRESS_HEADER)).toBeNull()
    expect(await answered.json()).toEqual({ error: 'refused 401' })
    expect(h.touches).toEqual([])
  })

  it.each([400, 401, 402, 403, 404, 409, 429])('answers an authorization %i plainly and runs nothing', async (status) => {
    const h = harness()
    const routes = makeRoutes(h, async () => refused(status), async () => ({ ok: true }))
    const answered = await routes.turn(turnRequest(progressFirst), h.ctx)
    expect(answered.status).toBe(status)
    expect(answered.headers.get(TURN_PROGRESS_HEADER)).toBeNull()
    expect(answered.headers.get('content-type')).toContain('application/json')
    expect(h.touches).toEqual([])
  })

  it('runs prepareTurn only after admission, before any read, lock or producer', async () => {
    const h = harness()
    const routes = makeRoutes(h, async () => admitted(), async ({ context }) => {
      context.prepared = true
      return { ok: true }
    })
    const response = await routes.turn(turnRequest(progressFirst), h.ctx)
    await response.text()
    await Promise.all(h.pending)
    const order = h.touches.filter((touch) => touch !== 'waitUntil' && !touch.startsWith('turnStore.'))
    expect(order.slice(0, 4)).toEqual(['lock.warm', 'prepareTurn', 'store.listMessages', 'lock.acquire'])
    expect(order).toContain('produce')
  })

  it('a prepareTurn refusal answers like a held lock and runs nothing after it', async () => {
    const h = harness()
    const routes = makeRoutes(h, async () => admitted(), async () => ({
      ok: false,
      response: Response.json({ error: 'Unknown agent profile' }, { status: 400 }),
    }))
    const response = await routes.turn(turnRequest(progressFirst), h.ctx)
    const settled = await settleTurnResponse(response, () => {})
    await Promise.all(h.pending)
    expect(settled.status).toBe(400)
    expect(await settled.json()).toEqual({ error: 'Unknown agent profile' })
    expect(h.touches.filter((touch) => touch !== 'waitUntil')).toEqual(['lock.warm', 'prepareTurn'])
  })
})

describe('progress-first: prepareTurn stages', () => {
  it('names its stages between admission and the lock', async () => {
    const h = harness()
    const routes = makeRoutes(h, async () => admitted(), async ({ progress }) => {
      progress('profile', 'Loading the agent profile…')
      return { ok: true }
    })
    const response = await routes.turn(turnRequest(true), h.ctx)
    const phases: string[] = []
    const settled = await settleTurnResponse(response, (phase) => phases.push(phase.phase))
    await settled.text()
    expect(phases).toEqual(['accepted', 'profile', 'preparing'])
  })
})

describe('replay and running routes: nothing before authorize resolves', () => {
  it.each(['replay', 'running'] as const)('%s waits for authorize and reads no turn state before it', async (route) => {
    const h = harness()
    const auth = deferred<ChatTurnAuthorization<{ prepared: boolean }>>()
    const routes = makeRoutes(h, () => auth.promise)
    const response = route === 'replay'
      ? routes.replay(new Request('http://app.test/api/chat/turn-1?fromSeq=0'), { turnId: 'turn-1' })
      : routes.running(new Request('http://app.test/api/chat/running?threadId=t-1'))
    expect(await stateAfter(response)).toBe('pending')
    expect(h.touches).toEqual([])
    auth.resolve(refused(404))
    const answered = await response
    expect(answered.status).toBe(404)
    expect(h.touches).toEqual([])
  })
})

describe('turn-stream upgrade: nothing before authorize resolves', () => {
  it('does not reach the Durable Object while authorize is pending, nor after a refusal', async () => {
    const reached: string[] = []
    const namespace = {
      idFromName: (name: string) => { reached.push(`id:${name}`); return name },
      get: () => { reached.push('get'); return { fetch: async () => new Response(null, { status: 200 }) } },
    } as unknown as TurnStreamNamespaceLike
    const auth = deferred<{ ok: true } | { ok: false; response: Response }>()
    const upgrade = createTurnStreamUpgradeHandler({
      namespace,
      authSecret: 'x'.repeat(32),
      authorize: () => auth.promise,
    })
    const response = upgrade(new Request('http://app.test/api/session-stream?workspaceId=ws-1', {
      headers: { Upgrade: 'websocket' },
    }))
    expect(await stateAfter(response)).toBe('pending')
    expect(reached).toEqual([])
    auth.resolve({ ok: false, response: new Response('Forbidden', { status: 403 }) })
    expect((await response)?.status).toBe(403)
    expect(reached).toEqual([])
  })
})
