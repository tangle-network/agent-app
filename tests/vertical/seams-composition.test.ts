/**
 * Composition scenario for the #200 turn-lifecycle seams the rest of the
 * vertical suite doesn't exercise: `turnLock` + `lifecycle` + `contextGate`
 * wired together on the assembled `createChatTurnRoutes`, driven through the
 * same fake-producer harness (`createSandboxChatProducer` over scripted sidecar
 * events) the other vertical tests use.
 *
 * Two invariants:
 *  - a `contextGate` reject short-circuits BEFORE the producer/lifecycle run, so
 *    no assistant row is written (the user row is intentionally kept — a real
 *    user turn — per the seam's contract);
 *  - the `turnLock` serializes a duplicate: a second turn fired while the lock
 *    is held is refused with the product's 409 and writes ZERO rows (the lock is
 *    acquired before any side effect, so the refused turn never runs `produce`).
 */

import { describe, expect, it } from 'vitest'

import { createChatTurnRoutes, createSandboxChatProducer } from '../../src/chat-routes/index'
import { guardResolution } from '../../src/platform/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import { createMiniApp, MINI_APP_MODEL, type MiniApp } from './mini-app'

const BASE = 'http://localhost:3000'

const RAW_TURN_EVENTS: Array<Record<string, unknown>> = [
  { type: 'message.part.updated', data: { part: { type: 'text', id: 'txt1', text: 'Done.' }, delta: 'Done.' } },
  { type: 'result', data: { finalText: 'Done.' } },
]

async function* feed(events: Array<Record<string, unknown>>, gate?: Promise<void>): AsyncGenerator<unknown> {
  if (gate) await gate
  for (const event of events) yield event
}

function seamRoutes(app: MiniApp, opts: { rejectGate?: boolean; gate?: Promise<void> } = {}) {
  const pending: Promise<unknown>[] = []
  const lifecycleEvents: string[] = []
  const state = { held: false, produceCount: 0 }
  const routes = createChatTurnRoutes({
    projectId: 'seams-mini',
    authorize: async ({ request }) => {
      const auth = await guardResolution(() => app.appAuth.requireApiUser(request))
      if (!auth.ok) return auth
      return { ok: true as const, tenantId: 'ws1', userId: auth.value.user.id, context: undefined }
    },
    store: app.store,
    turnStore: createMemoryTurnEventStore(),
    produce: () => {
      state.produceCount += 1
      return createSandboxChatProducer({ events: feed(RAW_TURN_EVENTS, opts.gate), model: MINI_APP_MODEL })
    },
    contextGate: async () =>
      opts.rejectGate
        ? { proceed: false, response: Response.json({ needContext: true }, { status: 409 }) }
        : { proceed: true },
    turnLock: {
      acquire: () => {
        if (state.held) return { acquired: false as const, response: Response.json({ code: 'in_flight' }, { status: 409 }) }
        state.held = true
        return { acquired: true as const, handle: 'lock' }
      },
      release: () => { state.held = false },
    },
    lifecycle: {
      onTurnStart: () => { lifecycleEvents.push('start') },
      onTurnComplete: () => { lifecycleEvents.push('complete') },
      onTurnError: () => { lifecycleEvents.push('error') },
    },
    log: () => {},
  })
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) }
  return { routes, ctx, settle: () => Promise.all(pending), lifecycleEvents, state }
}

function turnRequest(cookie: string, threadId: string, content: string): Request {
  return new Request(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ threadId, content }),
  })
}

describe('vertical: turnLock + lifecycle + contextGate composition (#200 seams)', () => {
  it('contextGate reject writes no assistant row and never runs the producer or lifecycle', async () => {
    const app = await createMiniApp()
    await app.createWorkspace('ws1')
    const cookie = await app.signUp('gate@example.com')
    app.grantMembership('gate@example.com', 'ws1')
    const thread = await app.store.createThread({ workspaceId: 'ws1', firstMessage: 'need context' })

    const { routes, ctx, settle, lifecycleEvents, state } = seamRoutes(app, { rejectGate: true })
    const res = await routes.turn(turnRequest(cookie, thread.id, 'do the thing'), ctx)
    await settle()

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ needContext: true })
    expect(state.produceCount).toBe(0) // gate short-circuits before produce
    expect(lifecycleEvents).toEqual([]) // gate runs before onTurnStart
    const messages = await app.store.listMessages(thread.id)
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(0)
  })

  it('turnLock serializes a duplicate: the second turn is refused 409 and writes zero rows', async () => {
    const app = await createMiniApp()
    await app.createWorkspace('ws1')
    const cookie = await app.signUp('lock@example.com')
    app.grantMembership('lock@example.com', 'ws1')
    const thread = await app.store.createThread({ workspaceId: 'ws1', firstMessage: 'serialize me' })

    // Hold the first turn's producer open so its lock stays held while the
    // duplicate fires (a tiny synchronous producer would drain and release
    // before the second call, making the race untestable).
    let openGate!: () => void
    const gate = new Promise<void>((resolve) => { openGate = resolve })
    const { routes, ctx, settle, lifecycleEvents, state } = seamRoutes(app, { gate })

    // First turn acquires the lock and returns a streaming Response; its lock is
    // released only when the drain settles (blocked on the gate here).
    const first = await routes.turn(turnRequest(cookie, thread.id, 'first'), ctx)
    expect(first.status).toBe(200)

    // Duplicate fired while the lock is held → refused, no side effects at all.
    const dup = await routes.turn(turnRequest(cookie, thread.id, 'duplicate'), ctx)
    expect(dup.status).toBe(409)
    expect(await dup.json()).toEqual({ code: 'in_flight' })

    // Exactly one turn ran the producer; the refused one is acquired-before-
    // any-side-effect, so it wrote no user row either.
    const beforeDrain = await app.store.listMessages(thread.id)
    expect(state.produceCount).toBe(1)
    expect(beforeDrain.filter((m) => m.role === 'user')).toHaveLength(1)

    // Open the gate, drain the winner so its lock releases and its assistant
    // row persists.
    openGate()
    await new Response(first.body).text()
    await settle()

    const messages = await app.store.listMessages(thread.id)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(messages[1]!.content).toBe('Done.')
    expect(lifecycleEvents).toEqual(['start', 'complete'])
  })
})
