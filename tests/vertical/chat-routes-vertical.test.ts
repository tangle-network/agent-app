/**
 * Vertical scenario for `/chat-routes`: the mini-app's hand-rolled chat route
 * replaced by `createChatTurnRoutes` + `createSandboxChatProducer` — the same
 * assembled modules (app-auth guard, chat-store persistence, stream
 * normalizers, client parser), driven through the factory instead of ~150
 * lines of bespoke pump. Assertions are user-visible outcomes only: what the
 * client stream showed, what a later page load reads back, what a replay
 * returns after a drop.
 */

import { describe, expect, it } from 'vitest'

import {
  createChatTurnRoutes,
  createSandboxChatProducer,
} from '../../src/chat-routes/index'
import type { ChatStepFinishPart, ChatToolPart } from '../../src/chat-store/index'
import { guardResolution } from '../../src/platform/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import { streamChatTurn, type ChatStreamCallbacks } from '../../src/web-react/chat-stream'
import { createMiniApp, MINI_APP_MODEL, type MiniApp } from './mini-app'

const BASE = 'http://localhost:3000'

/** Raw sandbox events, as `streamSandboxPrompt` would yield them. */
const RAW_TURN_EVENTS: Array<Record<string, unknown>> = [
  { type: 'message.part.updated', data: { part: { type: 'reasoning', id: 'r1', text: 'checking the vault' }, delta: 'checking the vault' } },
  { type: 'message.part.updated', data: { part: { type: 'text', id: 'txt1', text: 'Filed ' }, delta: 'Filed ' } },
  { type: 'message.part.updated', data: { part: { type: 'tool', id: 'call-1', tool: 'vault_search', state: { status: 'running', input: { query: 'lease' } } } } },
  { type: 'message.part.updated', data: { part: { type: 'tool', id: 'call-1', tool: 'vault_search', state: { status: 'completed', input: { query: 'lease' }, output: { hits: 2 } } } } },
  { type: 'message.part.updated', data: { part: { type: 'text', id: 'txt1', text: 'Filed the lease summary.' }, delta: 'the lease summary.' } },
  { type: 'message.part.updated', data: { part: { type: 'step-finish', reason: 'stop', tokens: { input: 40, output: 20, reasoning: 5, cache: { read: 10, write: 2 } }, cost: 0.0123 } } },
  { type: 'result', data: { finalText: 'Filed the lease summary.' } },
]

async function* feed(events: Array<Record<string, unknown>>): AsyncGenerator<unknown> {
  for (const event of events) yield event
}

function factoryRoutes(app: MiniApp, turnStore = createMemoryTurnEventStore()) {
  const pending: Promise<unknown>[] = []
  const routes = createChatTurnRoutes({
    projectId: 'vertical-mini',
    authorize: async ({ request }) => {
      const auth = await guardResolution(() => app.appAuth.requireApiUser(request))
      if (!auth.ok) return auth
      const { user } = auth.value
      return { ok: true as const, tenantId: 'ws1', userId: user.id, context: undefined }
    },
    store: app.store,
    turnStore,
    produce: () => createSandboxChatProducer({ events: feed(RAW_TURN_EVENTS), model: MINI_APP_MODEL }),
    log: () => {},
  })
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) }
  return { routes, ctx, settle: () => Promise.all(pending) }
}

describe('vertical: createChatTurnRoutes replaces the hand-rolled chat route', () => {
  it('runs the full turn through the factory: client stream, persisted rows, receipt columns, replay after the fact', async () => {
    const app = await createMiniApp()
    await app.createWorkspace('ws1')
    const cookie = await app.signUp('factory@example.com')
    app.grantMembership('factory@example.com', 'ws1')
    const thread = await app.store.createThread({ workspaceId: 'ws1', firstMessage: 'File my lease summary' })

    const { routes, ctx, settle } = factoryRoutes(app)

    const log: Array<[string, unknown]> = []
    let turnId: string | null = null
    const cb: ChatStreamCallbacks = {
      onTurnId: (id) => { turnId = id },
      onText: (t) => log.push(['text', t]),
      onReasoning: (t) => log.push(['reasoning', t]),
      onToolCall: (c) => log.push(['tool_call', c.toolName]),
      onToolResult: (r) => log.push(['tool_result', r.outcome?.ok]),
      onUsage: (u) => log.push(['usage', u]),
      onErrorEvent: (m) => log.push(['error', m]),
    }
    const result = await streamChatTurn({
      start: () => routes.turn(
        new Request(`${BASE}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ threadId: thread.id, content: 'File my lease summary' }),
        }),
        ctx,
      ),
      resume: (id, fromSeq) => routes.replay(new Request(`${BASE}/api/chat/replay/${id}?fromSeq=${fromSeq}`, { headers: { cookie } }), { turnId: id }),
      callbacks: cb,
    })
    await settle()

    // The client saw the whole vocabulary the mini-app's bespoke route emits.
    expect(result.receivedContent).toBe(true)
    expect(turnId).toBeTruthy()
    expect(log.filter(([k]) => k === 'text').map(([, v]) => v).join('')).toBe('Filed the lease summary.')
    expect(log).toContainEqual(['reasoning', 'checking the vault'])
    expect(log).toContainEqual(['tool_call', 'vault_search'])
    expect(log).toContainEqual(['tool_result', true])
    expect(log).toContainEqual(['usage', { promptTokens: 40, completionTokens: 20 }])
    expect(log.filter(([k]) => k === 'error')).toEqual([])

    // A later page load reads back both rows with typed parts + the receipt.
    const messages = await app.store.listMessages(thread.id)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    const assistant = messages[1]!
    expect(assistant.content).toBe('Filed the lease summary.')
    expect(assistant.model).toBe(MINI_APP_MODEL)
    expect(assistant.inputTokens).toBe(40)
    expect(assistant.outputTokens).toBe(20)
    expect(assistant.reasoningTokens).toBe(5)
    expect(assistant.cacheReadTokens).toBe(10)
    expect(assistant.cacheWriteTokens).toBe(2)
    expect(assistant.costUsd).toBeCloseTo(0.0123)
    const parts = assistant.parts ?? []
    const tool = parts.find((p): p is ChatToolPart => p.type === 'tool')
    expect(tool).toMatchObject({ tool: 'vault_search', state: { status: 'completed' } })
    const receipt = parts.find((p): p is ChatStepFinishPart => p.type === 'step-finish')
    expect(receipt?.tokens).toMatchObject({ input: 40, output: 20 })

    // The buffered turn replays in full after the live stream is long gone.
    const replayRes = await routes.replay(
      new Request(`${BASE}/api/chat/replay/${turnId}?fromSeq=0`, { headers: { cookie } }),
      { turnId: turnId! },
    )
    const replayText = await new Response(replayRes.body).text()
    const replayLines = replayText.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(replayLines.filter((l) => l.type === 'text').map((l) => String(l.text)).join('')).toBe('Filed the lease summary.')
    expect(replayLines.at(-1)).toMatchObject({ type: 'turn_status', status: 'complete' })
  })

  it('rejects an unauthenticated turn with the guard 401 contract, before any row is written', async () => {
    const app = await createMiniApp()
    await app.createWorkspace('ws1')
    const thread = await app.store.createThread({ workspaceId: 'ws1', firstMessage: 'seed' })
    const { routes, ctx } = factoryRoutes(app)

    const res = await routes.turn(
      new Request(`${BASE}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId: thread.id, content: 'hi' }),
      }),
      ctx,
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: 'auth.unauthenticated' })
    expect(await app.store.listMessages(thread.id)).toEqual([])
  })
})
