/**
 * Vertical composition evals — the assembled mini chat app from `./mini-app`
 * exercised end-to-end as a hostile integrator would: every assertion is a
 * USER-VISIBLE outcome (what the client stream showed, what a later page load
 * reads back from the store, what an attacker's request returned), never a
 * module internal.
 *
 * This suite is the composition gate for the merged #189/#190/#191/#192
 * modules: a future subpath change that still passes its unit tests but breaks
 * assembly (a seam rename, a contract drift between stream parts and persisted
 * parts, a guard/store access mismatch) fails here.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  consumeChatStream,
  streamChatTurn,
  type ChatStreamCallbacks,
} from '../../src/web-react/chat-stream'
import {
  dedupeQuestionInteractionsByContent,
  persistedPartToInteraction,
  type ChatInteraction,
  type InteractionRequestWire,
} from '../../src/interactions/index'
import type { ChatInteractionPart, ChatMessagePart, ChatStepFinishPart, ChatToolPart } from '../../src/chat-store/index'
import { createMiniApp, MINI_APP_MODEL, type MiniApp, type ProducerEvent } from './mini-app'

const BASE = 'http://localhost:3000'

// ── request helpers ──────────────────────────────────────────────────────────

function jsonRequest(path: string, body: unknown, cookie?: string): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })
}

function getRequest(path: string, cookie?: string): Request {
  return new Request(`${BASE}${path}`, { headers: cookie ? { cookie } : {} })
}

function recorder() {
  const log: Array<[string, unknown]> = []
  const interactions: ChatInteraction[] = []
  const cb: ChatStreamCallbacks = {
    onText: (t) => log.push(['text', t]),
    onReasoning: (t) => log.push(['reasoning', t]),
    onToolCall: (c) => log.push(['tool_call', c.toolName]),
    onToolResult: (r) => log.push(['tool_result', r.outcome?.ok]),
    onUsage: (u) => log.push(['usage', u]),
    onMetadata: (d) => log.push(['metadata', d.modelUsed]),
    onErrorEvent: (m) => log.push(['error', m]),
    onInteraction: (i) => {
      log.push(['interaction', i.id])
      interactions.push(i)
    },
  }
  const text = () => log.filter(([k]) => k === 'text').map(([, v]) => v).join('')
  return { log, cb, interactions, text }
}

async function seedUser(app: MiniApp, email: string, workspaceIds: string[]): Promise<string> {
  const cookie = await app.signUp(email)
  for (const workspaceId of workspaceIds) app.grantMembership(email, workspaceId)
  return cookie
}

async function messagesOf(app: MiniApp, threadId: string) {
  return app.store.listMessages(threadId)
}

function partsOf(message: { parts: ChatMessagePart[] | null }): ChatMessagePart[] {
  return message.parts ?? []
}

// ── scripts ──────────────────────────────────────────────────────────────────

const FULL_TURN_SCRIPT: ProducerEvent[] = [
  { type: 'message.part.updated', part: { type: 'reasoning', id: 'r1', text: 'checking the vault' }, delta: 'checking the vault' },
  { type: 'message.part.updated', part: { type: 'text', id: 'txt1', text: 'Filed ' }, delta: 'Filed ' },
  {
    type: 'message.part.updated',
    part: { type: 'tool', id: 'call-1', callID: 'call-1', tool: 'vault_search', state: { status: 'running', input: { query: 'lease' } } },
  },
  {
    type: 'message.part.updated',
    part: {
      type: 'tool',
      id: 'call-1',
      callID: 'call-1',
      tool: 'vault_search',
      state: { status: 'completed', input: { query: 'lease' }, output: { hits: 2 }, time: { start: 1_000, end: 5_000 } },
    },
  },
  { type: 'message.part.updated', part: { type: 'text', id: 'txt1', text: 'Filed the lease summary.' }, delta: 'the lease summary.' },
  {
    type: 'message.part.updated',
    part: {
      type: 'step-finish',
      reason: 'stop',
      tokens: { total: 65, input: 40, output: 20, reasoning: 5, cache: { read: 10, write: 2 } },
      cost: 0.0123,
    },
  },
]

function question(id: string, overrides: Partial<InteractionRequestWire> = {}): InteractionRequestWire {
  return {
    id,
    kind: 'question',
    title: 'Which tone should the summary use?',
    answerSpec: {
      fields: [
        {
          type: 'select',
          name: 'tone',
          label: 'Tone',
          required: true,
          multi: false,
          options: [
            { value: 'Formal', label: 'Formal' },
            { value: 'Casual', label: 'Casual' },
          ],
        },
      ],
    },
    ...overrides,
  } as InteractionRequestWire
}

// ── scenario 1: full turn ────────────────────────────────────────────────────

describe('vertical: full turn', () => {
  it('streams text/tool/usage to the client and persists the assistant message with parts + token receipt', async () => {
    const app = await createMiniApp({ script: FULL_TURN_SCRIPT })
    await app.createWorkspace('ws1')
    const cookie = await seedUser(app, 'ada@example.com', ['ws1'])

    const { log, cb, text } = recorder()
    const response = await app.routes.chat(
      jsonRequest('/api/chat', { workspaceId: 'ws1', message: 'Draft the lease summary\nfull details follow' }, cookie),
    )
    expect(response.status).toBe(200)
    const threadId = response.headers.get('x-thread-id')!
    expect(threadId).toBeTruthy()

    const result = await consumeChatStream(response.body!, cb)
    expect(result.receivedContent).toBe(true)
    expect(result.turnId).toBe(response.headers.get('x-turn-id'))

    // Client lane: the user watched the whole turn happen.
    expect(text()).toBe('Filed the lease summary.')
    expect(log).toContainEqual(['reasoning', 'checking the vault'])
    expect(log).toContainEqual(['tool_call', 'vault_search'])
    expect(log).toContainEqual(['tool_result', true])
    expect(log).toContainEqual(['usage', { promptTokens: 40, completionTokens: 20 }])
    expect(log).toContainEqual(['metadata', MINI_APP_MODEL])

    // Persistence lane: a reload reads the same turn back.
    const thread = await app.store.getThread(threadId)
    expect(thread?.title).toBe('Draft the lease summary')

    const messages = await messagesOf(app, threadId)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(messages[0]?.content).toContain('Draft the lease summary')

    const assistant = messages[1]!
    expect(assistant.content).toBe('Filed the lease summary.')
    expect(assistant.model).toBe(MINI_APP_MODEL)
    expect(assistant.inputTokens).toBe(40)
    expect(assistant.outputTokens).toBe(20)
    expect(assistant.reasoningTokens).toBe(5)
    expect(assistant.cacheReadTokens).toBe(10)
    expect(assistant.cacheWriteTokens).toBe(2)
    expect(assistant.costUsd).toBeCloseTo(0.0123)

    const parts = partsOf(assistant)
    const textPart = parts.find((p) => p.type === 'text')
    expect(textPart).toMatchObject({ type: 'text', text: 'Filed the lease summary.' })

    const toolPart = parts.find((p) => p.type === 'tool') as ChatToolPart | undefined
    expect(toolPart).toMatchObject({
      type: 'tool',
      tool: 'vault_search',
      state: { status: 'completed', input: { query: 'lease' }, output: { hits: 2 } },
    })

    const stepFinish = parts.find((p) => p.type === 'step-finish') as ChatStepFinishPart | undefined
    expect(stepFinish?.tokens).toMatchObject({ input: 40, output: 20, reasoning: 5, cache: { read: 10, write: 2 } })
    expect(stepFinish?.cost).toBeCloseTo(0.0123)
  })

  it('rejects an unauthenticated turn with the guard 401 contract', async () => {
    const app = await createMiniApp({ script: FULL_TURN_SCRIPT })
    await app.createWorkspace('ws1')
    const response = await app.routes.chat(jsonRequest('/api/chat', { workspaceId: 'ws1', message: 'hi' }))
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: 'auth.unauthenticated' })
  })

  it('rejects a member-of-nothing user with 403 before any row is written', async () => {
    const app = await createMiniApp({ script: FULL_TURN_SCRIPT })
    await app.createWorkspace('ws1')
    const cookie = await app.signUp('lurker@example.com') // no membership granted
    const response = await app.routes.chat(jsonRequest('/api/chat', { workspaceId: 'ws1', message: 'hi' }, cookie))
    expect(response.status).toBe(403)
    const rows = await app.db.select().from(app.tables.threads)
    expect(rows).toHaveLength(0)
  })
})

// ── scenario 2: failed turn (the incident class) ─────────────────────────────

describe('vertical: failed turn', () => {
  const FAILING_SCRIPT: ProducerEvent[] = [
    { type: 'message.part.updated', part: { type: 'text', id: 'txt1', text: 'Starting the review… ' }, delta: 'Starting the review… ' },
    { type: 'error', message: 'sandbox exec crashed: boom' },
  ]

  it('shows the error to a client with no onErrorEvent wired (synthesized transcript row) and retains the user message', async () => {
    const app = await createMiniApp({ script: FAILING_SCRIPT })
    await app.createWorkspace('ws1')
    const cookie = await seedUser(app, 'ada@example.com', ['ws1'])

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const texts: string[] = []
    try {
      const response = await app.routes.chat(jsonRequest('/api/chat', { workspaceId: 'ws1', message: 'Review the contract' }, cookie))
      const threadId = response.headers.get('x-thread-id')!
      const result = await consumeChatStream(response.body!, { onText: (t) => texts.push(t) })

      // User-visible: the failure reached the transcript, not a silent empty answer.
      expect(result.receivedContent).toBe(true)
      expect(texts.join('')).toContain('sandbox exec crashed: boom')
      expect(errorSpy).toHaveBeenCalled()

      // Durability: the user's message survived the failed turn, and the
      // partial assistant output + a warning notice are readable on reload.
      const messages = await messagesOf(app, threadId)
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
      expect(messages[0]?.content).toBe('Review the contract')

      const assistant = messages[1]!
      expect(assistant.content).toBe('Starting the review… ')
      const notice = partsOf(assistant).find((p) => p.type === 'notice')
      expect(notice).toMatchObject({ type: 'notice', noticeKind: 'warning' })
      expect((notice as { text?: string }).text).toContain('sandbox exec crashed: boom')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('routes the error to onErrorEvent when the consumer wired one', async () => {
    const app = await createMiniApp({ script: FAILING_SCRIPT })
    await app.createWorkspace('ws1')
    const cookie = await seedUser(app, 'ada@example.com', ['ws1'])

    const { log, cb, text } = recorder()
    const response = await app.routes.chat(jsonRequest('/api/chat', { workspaceId: 'ws1', message: 'Review the contract' }, cookie))
    await consumeChatStream(response.body!, cb)
    expect(log).toContainEqual(['error', 'sandbox exec crashed: boom'])
    expect(text()).toBe('Starting the review… ') // no synthesized duplicate
  })
})

// ── scenario 3: interaction ask → answer → turn continues ────────────────────

describe('vertical: interaction round-trip', () => {
  const ASKING_SCRIPT: ProducerEvent[] = [
    { type: 'message.part.updated', part: { type: 'text', id: 'txt1', text: 'Before I draft: ' }, delta: 'Before I draft: ' },
    { type: 'interaction', request: question('ask-1') },
    { type: 'message.part.updated', part: { type: 'text', id: 'txt1', text: 'Before I draft: got it, proceeding.' }, delta: 'got it, proceeding.' },
    { type: 'message.part.updated', part: { type: 'step-finish', tokens: { input: 10, output: 4 }, cost: 0.002 } },
  ]

  it('blocks the turn on the ask, rejects an invalid answer fail-closed, unblocks on a valid one, and persists the answered card', async () => {
    const app = await createMiniApp({ script: ASKING_SCRIPT })
    await app.createWorkspace('ws1')
    const cookie = await seedUser(app, 'ada@example.com', ['ws1'])

    const response = await app.routes.chat(jsonRequest('/api/chat', { workspaceId: 'ws1', message: 'Draft the letter' }, cookie))
    const threadId = response.headers.get('x-thread-id')!

    const { cb, interactions, text } = recorder()
    const answerFlow: Promise<void>[] = []
    cb.onInteraction = (interaction) => {
      interactions.push(interaction)
      answerFlow.push((async () => {
        // Hostile first: free text on an option-only select must fail closed
        // with the card-actionable 400, and the run must stay blocked.
        const bad = await app.routes.interactions.answer(
          jsonRequest('/api/chat/interactions', { id: interaction.id, outcome: 'accepted', data: { tone: 'sarcastic' }, threadId }, cookie),
        )
        expect(bad.status).toBe(400)
        expect(await bad.json()).toMatchObject({ code: 'INVALID_INTERACTION_ANSWER' })
        expect(app.sidecar.outstandingIds()).toContain(interaction.id)

        const good = await app.routes.interactions.answer(
          jsonRequest('/api/chat/interactions', { id: interaction.id, outcome: 'accepted', data: { tone: ['Formal'] }, threadId }, cookie),
        )
        expect(good.status).toBe(200)
        expect(await good.json()).toEqual({ ok: true })
      })())
    }

    const result = await consumeChatStream(response.body!, cb)
    await Promise.all(answerFlow)

    // The turn genuinely continued past the ask.
    expect(result.receivedContent).toBe(true)
    expect(text()).toBe('Before I draft: got it, proceeding.')
    expect(interactions).toHaveLength(1)
    expect(interactions[0]).toMatchObject({ id: 'ask-1', kind: 'question', status: 'pending' })
    expect(app.sidecar.outstandingIds()).toEqual([])

    // Reload restore: the persisted part reads back as an answered card.
    const messages = await messagesOf(app, threadId)
    const assistant = messages[1]!
    const persisted = partsOf(assistant).find((p) => p.type === 'interaction') as ChatInteractionPart | undefined
    expect(persisted).toMatchObject({ id: 'ask-1', kind: 'question', status: 'answered' })
    const card = persistedPartToInteraction(persisted as unknown as Record<string, unknown>)
    expect(card).toMatchObject({ id: 'ask-1', title: 'Which tone should the summary use?', status: 'answered' })

    // The receipt still landed after the blocked stretch.
    expect(assistant.inputTokens).toBe(10)
    expect(assistant.outputTokens).toBe(4)

    // Answering an already-resolved ask reads back 410 (card flips to expired).
    const replay = await app.routes.interactions.answer(
      jsonRequest('/api/chat/interactions', { id: 'ask-1', outcome: 'accepted', data: { tone: ['Formal'] }, threadId }, cookie),
    )
    expect(replay.status).toBe(410)
    expect(await replay.json()).toMatchObject({ code: 'INTERACTION_EXPIRED' })
  })

  it('a re-emitted duplicate question renders one card and one answer resolves both asks', async () => {
    const script: ProducerEvent[] = [
      { type: 'interaction', request: question('ask-1'), block: false },
      { type: 'interaction', request: question('ask-2') }, // same content, new id
      { type: 'message.part.updated', part: { type: 'text', id: 'txt1', text: 'Proceeding.' }, delta: 'Proceeding.' },
    ]
    const app = await createMiniApp({ script })
    await app.createWorkspace('ws1')
    const cookie = await seedUser(app, 'ada@example.com', ['ws1'])

    const response = await app.routes.chat(jsonRequest('/api/chat', { workspaceId: 'ws1', message: 'Draft it' }, cookie))
    const threadId = response.headers.get('x-thread-id')!

    const { cb, interactions, text } = recorder()
    const answered: Promise<Response>[] = []
    cb.onInteraction = (interaction) => {
      interactions.push(interaction)
      if (interaction.id !== 'ask-1') return
      answered.push(app.routes.interactions.answer(
        jsonRequest('/api/chat/interactions', { id: 'ask-1', outcome: 'accepted', data: { tone: ['Casual'] }, threadId }, cookie),
      ))
    }
    await consumeChatStream(response.body!, cb)
    const [answerResponse] = await Promise.all(answered)

    // The user saw ONE card even though the agent asked twice.
    expect(interactions).toHaveLength(2)
    expect(dedupeQuestionInteractionsByContent(interactions)).toHaveLength(1)

    // One POST resolved both registry entries (content-signature duplicate handling).
    expect(answerResponse!.status).toBe(200)
    expect(app.sidecar.outstandingIds()).toEqual([])
    expect(app.sidecar.calls.some((call) => call.method === 'POST' && call.body?.id === 'ask-2')).toBe(true)
    expect(text()).toBe('Proceeding.')
  })

  it('denies answering another workspace\'s ask and listing its interactions', async () => {
    const app = await createMiniApp({ script: [{ type: 'interaction', request: question('ask-1') }] })
    await app.createWorkspace('ws1')
    await app.createWorkspace('ws2')
    const adaCookie = await seedUser(app, 'ada@example.com', ['ws1'])
    const bobCookie = await seedUser(app, 'bob@example.com', ['ws2'])

    const response = await app.routes.chat(jsonRequest('/api/chat', { workspaceId: 'ws1', message: 'Draft it' }, adaCookie))
    const threadId = response.headers.get('x-thread-id')!
    // The turn is parked on the ask; attack it from the other workspace.
    const denied = await app.routes.interactions.answer(
      jsonRequest('/api/chat/interactions', { id: 'ask-1', outcome: 'accepted', data: { tone: ['Formal'] }, threadId }, bobCookie),
    )
    expect(denied.status).toBe(403)
    expect(app.sidecar.outstandingIds()).toContain('ask-1')

    const deniedList = await app.routes.interactions.list(getRequest(`/api/chat/interactions?threadId=${threadId}`, bobCookie))
    expect(deniedList.status).toBe(403)

    const okList = await app.routes.interactions.list(getRequest(`/api/chat/interactions?threadId=${threadId}`, adaCookie))
    expect(okList.status).toBe(200)
    expect(await okList.json()).toMatchObject({ interactions: [{ id: 'ask-1' }] })

    // Release the parked turn so the stream (and the test) can finish.
    const ok = await app.routes.interactions.answer(
      jsonRequest('/api/chat/interactions', { id: 'ask-1', outcome: 'declined', threadId }, adaCookie),
    )
    expect(ok.status).toBe(200)
    await consumeChatStream(response.body!, {})
  })
})

// ── scenario 4: workspace isolation + cross-workspace reads ─────────────────

describe('vertical: workspace isolation', () => {
  async function twoWorkspaceApp() {
    const app = await createMiniApp({ script: FULL_TURN_SCRIPT })
    await app.createWorkspace('ws1')
    await app.createWorkspace('ws2')
    const adaCookie = await seedUser(app, 'ada@example.com', ['ws1'])
    const bobCookie = await seedUser(app, 'bob@example.com', ['ws2'])

    const adaTurn = await app.routes.chat(jsonRequest('/api/chat', { workspaceId: 'ws1', message: 'Ada thread' }, adaCookie))
    await consumeChatStream(adaTurn.body!, {})
    const bobTurn = await app.routes.chat(jsonRequest('/api/chat', { workspaceId: 'ws2', message: 'Bob thread' }, bobCookie))
    await consumeChatStream(bobTurn.body!, {})

    return { app, adaCookie, bobCookie, adaThreadId: adaTurn.headers.get('x-thread-id')!, bobThreadId: bobTurn.headers.get('x-thread-id')! }
  }

  it('a cross-workspace thread read is indistinguishable from a missing thread', async () => {
    const { app, adaCookie, bobCookie, adaThreadId } = await twoWorkspaceApp()

    const denied = await app.routes.getThread(getRequest(`/api/thread?threadId=${adaThreadId}`, bobCookie))
    expect(denied.status).toBe(404)
    const missing = await app.routes.getThread(getRequest('/api/thread?threadId=does-not-exist', bobCookie))
    expect(missing.status).toBe(404)
    expect(await denied.json()).toEqual(await missing.json())

    const unauthenticated = await app.routes.getThread(getRequest(`/api/thread?threadId=${adaThreadId}`))
    expect(unauthenticated.status).toBe(401)

    const owner = await app.routes.getThread(getRequest(`/api/thread?threadId=${adaThreadId}`, adaCookie))
    expect(owner.status).toBe(200)
    const payload = await owner.json() as { messages: Array<{ role: string }> }
    expect(payload.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('a second workspace never sees the first workspace\'s threads', async () => {
    const { app, adaCookie, bobCookie, adaThreadId, bobThreadId } = await twoWorkspaceApp()

    const bobList = await app.routes.listThreads(getRequest('/api/threads?workspaceId=ws2', bobCookie))
    const bobPayload = await bobList.json() as { threads: Array<{ id: string }>; total: number }
    expect(bobPayload.total).toBe(1)
    expect(bobPayload.threads.map((t) => t.id)).toEqual([bobThreadId])
    expect(bobPayload.threads.map((t) => t.id)).not.toContain(adaThreadId)

    // Listing a workspace you are not a member of is denied outright.
    const denied = await app.routes.listThreads(getRequest('/api/threads?workspaceId=ws1', bobCookie))
    expect(denied.status).toBe(403)

    const adaList = await app.routes.listThreads(getRequest('/api/threads?workspaceId=ws1', adaCookie))
    expect((await adaList.json() as { threads: Array<{ id: string }> }).threads.map((t) => t.id)).toEqual([adaThreadId])
  })

  it('bulk delete with one denied workspace deletes NOTHING (fail-closed)', async () => {
    const { app, adaCookie, adaThreadId, bobThreadId } = await twoWorkspaceApp()

    const denied = await app.routes.bulkDeleteThreads(
      jsonRequest('/api/threads/bulk-delete', { ids: [adaThreadId, bobThreadId] }, adaCookie),
    )
    expect(denied.status).toBe(403)

    // Zero deletion: both threads AND their messages survived the rejected request.
    expect(await app.store.getThread(adaThreadId)).not.toBeNull()
    expect(await app.store.getThread(bobThreadId)).not.toBeNull()
    expect(await messagesOf(app, adaThreadId)).toHaveLength(2)
    expect(await messagesOf(app, bobThreadId)).toHaveLength(2)

    // The same caller deleting only their own thread succeeds, messages first.
    const ok = await app.routes.bulkDeleteThreads(jsonRequest('/api/threads/bulk-delete', { ids: [adaThreadId] }, adaCookie))
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ deleted: 1 })
    expect(await app.store.getThread(adaThreadId)).toBeNull()
    expect(await messagesOf(app, adaThreadId)).toHaveLength(0)
    expect(await app.store.getThread(bobThreadId)).not.toBeNull()
  })

  it('maps malformed bulk-delete input to a 400, not a 500', async () => {
    const { app, adaCookie } = await twoWorkspaceApp()
    const empty = await app.routes.bulkDeleteThreads(jsonRequest('/api/threads/bulk-delete', { ids: [] }, adaCookie))
    expect(empty.status).toBe(400)
    expect(await empty.json()).toMatchObject({ error: 'Missing ids' })
  })
})

// ── scenario 5: the #190 gates at the turn boundary ──────────────────────────

describe('vertical: incident gates', () => {
  it('an oversized composed prompt is a client-visible 400 with the section breakdown, before any row is written', async () => {
    const knowledgeDump = 'k'.repeat(60_000)
    const app = await createMiniApp({
      script: FULL_TURN_SCRIPT,
      systemPromptFor: (message) => `# Directives\nAnswer: ${message}\n# Knowledge Dump\n${knowledgeDump}`,
    })
    await app.createWorkspace('ws1')
    const cookie = await seedUser(app, 'ada@example.com', ['ws1'])

    // User-visible path: streamChatTurn surfaces the server's gate message.
    await expect(
      streamChatTurn({
        start: () => app.routes.chat(jsonRequest('/api/chat', { workspaceId: 'ws1', message: 'hi' }, cookie)),
        callbacks: {},
      }),
    ).rejects.toThrow(/over the 40000-byte budget.*Knowledge Dump/s)

    // Fired pre-write: no orphan thread or user message.
    expect(await app.db.select().from(app.tables.threads)).toHaveLength(0)
    expect(await app.db.select().from(app.tables.messages)).toHaveLength(0)
  })

  it('an oversized env entry fires the E2BIG gate naming the variable', async () => {
    const app = await createMiniApp({
      script: FULL_TURN_SCRIPT,
      sandboxEnv: { WORKSPACE_CONTEXT: 'x'.repeat(130_000) },
    })
    await app.createWorkspace('ws1')
    const cookie = await seedUser(app, 'ada@example.com', ['ws1'])

    const response = await app.routes.chat(jsonRequest('/api/chat', { workspaceId: 'ws1', message: 'hi' }, cookie))
    expect(response.status).toBe(400)
    const { error } = await response.json() as { error: string }
    expect(error).toContain('WORKSPACE_CONTEXT')
    expect(error).toContain('131072')
    expect(await app.db.select().from(app.tables.messages)).toHaveLength(0)
  })

  it('an oversized provision payload fires the create-cap gate with the per-section breakdown', async () => {
    const app = await createMiniApp({
      script: FULL_TURN_SCRIPT,
      profileFileContent: 'f'.repeat(250_000),
    })
    await app.createWorkspace('ws1')
    const cookie = await seedUser(app, 'ada@example.com', ['ws1'])

    const response = await app.routes.chat(jsonRequest('/api/chat', { workspaceId: 'ws1', message: 'hi' }, cookie))
    expect(response.status).toBe(400)
    const { error } = await response.json() as { error: string }
    expect(error).toContain('over the 240000-byte gate')
    expect(error).toContain('Breakdown:')
    expect(error).toMatch(/files=\d+B/)
    expect(await app.db.select().from(app.tables.threads)).toHaveLength(0)
  })
})
