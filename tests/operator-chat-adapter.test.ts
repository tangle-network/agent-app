import { describe, expect, it, vi } from 'vitest'
import {
  createChatOperatorAdapter,
  createOperatorApi,
  createOperatorClient,
  type ChatOperatorAdapterOptions,
  type ChatOperatorAdmission,
  type ChatOperatorAdmissionStore,
  type ChatOperatorMessage,
  type ChatOperatorThread,
} from '../src/operator'
import type { RequestApiKey } from '../src/platform/api-key-auth'
import type { ChatMessageRow } from '../src/chat-store'

// Chat-store rows are accepted as they are, typed parts included.
const _chatStoreRowsFit: (rows: ChatMessageRow[]) => ChatOperatorMessage[] = (rows) => rows
void _chatStoreRowsFit

type Identity = { userId: string }
const ORIGIN = 'https://app.example'

function setup(options: {
  turnStatus?: ChatOperatorAdapterOptions<Identity>['turnStatus']
  admissions?: ChatOperatorAdmissionStore<Identity>
  threads?: Map<string, ChatOperatorThread>
  messages?: Map<string, ChatOperatorMessage[]>
  reply?: (content: string) => Record<string, unknown>
  running?: () => string[] | null
  failureOf?: ChatOperatorAdapterOptions<Identity>['failureOf']
} = {}) {
  const threads = options.threads ?? new Map<string, ChatOperatorThread>([
    ['thread-b', { id: 'thread-b', workspaceId: 'ws-b', title: 'Other' }],
    ['thread-colleague', { id: 'thread-colleague', workspaceId: 'ws-a', title: 'A colleague\'s conversation' }],
  ])
  // Conversations that belong to one user, as in an app whose threads are per user.
  const owners = new Map([['thread-colleague', 'colleague']])
  const messages = options.messages ?? new Map<string, ChatOperatorMessage[]>()
  let clock = 0
  const runTurn = vi.fn(async (_ctx: unknown, input: { threadId: string; turnId: string; content: string }) => {
    const list = messages.get(input.threadId) ?? []
    list.push({ id: `u-${input.turnId}`, role: 'user', content: input.content, parts: [{ type: 'text', text: input.content, turnId: input.turnId }], createdAt: ++clock })
    const reply = options.reply?.(input.content) ?? { content: `Done: ${input.content}`, parts: [{ type: 'session-artifact', path: 'notes/plan.md', action: 'created' }] }
    list.push({ id: `a-${input.turnId}`, role: 'assistant', content: String(reply.content ?? ''), parts: (reply.parts as Array<Record<string, unknown>>) ?? [], createdAt: ++clock, servedModel: 'gpt-6-luna', costUsd: 0.12,
      ...(reply.metadata ? { metadata: reply.metadata as Record<string, unknown> } : {}) })
    messages.set(input.threadId, list)
    return new Response('{"type":"text"}\n{"type":"done"}\n', { headers: { 'content-type': 'application/x-ndjson' } })
  })
  const adapter = createChatOperatorAdapter<Identity>({
    origin: ORIGIN,
    ...(options.admissions ? { admissions: options.admissions } : {}),
    ...(options.turnStatus ? { turnStatus: options.turnStatus } : {}),
    workspaces: {
      authorize: async (_ctx, workspaceId) => (workspaceId === 'ws-a' ? { id: 'ws-a', name: 'Firm', role: 'owner' } : null),
      list: async () => [{ id: 'ws-a', name: 'Firm', role: 'owner' }],
    },
    threads: {
      get: async (id, ctx) => {
        const owner = owners.get(id)
        return owner && owner !== ctx.identity.userId ? null : threads.get(id) ?? null
      },
      create: async (_ctx, input) => {
        if (threads.has(input.id)) throw new Error('UNIQUE constraint failed: thread.id')
        const thread = { ...input }
        threads.set(input.id, thread)
        return thread
      },
      listMessages: async (id, ctx) => (owners.get(id) ?? ctx.identity.userId) === ctx.identity.userId ? messages.get(id) ?? [] : [],
    },
    runTurn,
    runningTurns: async () => options.running?.() ?? [],
    ...(options.failureOf ? { failureOf: options.failureOf } : {}),
  })
  const api = createOperatorApi<RequestApiKey, Identity>({
    app: { id: 'legal', name: 'Legal' },
    keys: {
      verify: async (authorization) => authorization === 'Bearer lak_ok'
        ? { keyId: 'key-1', ownerId: 'owner', scopes: ['operator:read', 'operator:run'], expiresAt: Date.now() + 60_000 } : null,
      resolveIdentity: async (key) => ({ userId: key.ownerId }),
      claimRequest: async () => ({ allowed: true }),
    },
    adapter,
  })
  const client = createOperatorClient({ origin: ORIGIN, getApiKey: () => 'lak_ok', fetchImpl: (input, init) => api.handle(new Request(input, init)) })
  return { client, runTurn, threads, messages }
}

describe('chat operator adapter', () => {
  it('runs a turn through the app chat route and returns its settled reply', async () => {
    const { client, runTurn, threads } = setup()
    const started = await client.startTurn('ws-a', { content: 'Review the lease', turnId: '1f0c5a3e-9b7d-4c21-8e6f-0a1b2c3d4e5f' })

    expect(started).toMatchObject({ succeeded: true, value: {
      state: 'succeeded', reply: { content: 'Done: Review the lease' }, model: 'gpt-6-luna', costUsd: 0.12,
      files: [{ path: 'notes/plan.md', action: 'created' }],
    } })
    if (!started.succeeded) return
    expect(threads.get(started.value.threadId)).toMatchObject({ workspaceId: 'ws-a', title: 'Review the lease' })
    expect(started.value.url).toBe(`${ORIGIN}/app/ws-a/chat/${started.value.threadId}`)

    // A retried start with the same turn id reads the recorded turn and never runs it again.
    const retried = await client.startTurn('ws-a', { content: 'Review the lease', turnId: '1f0c5a3e-9b7d-4c21-8e6f-0a1b2c3d4e5f' })
    expect(retried).toMatchObject({ succeeded: true, value: { threadId: started.value.threadId, state: 'succeeded' } })
    expect(runTurn).toHaveBeenCalledTimes(1)

    const thread = await client.getThread('ws-a', started.value.threadId)
    expect(thread).toMatchObject({ succeeded: true, value: { latestTurn: { turnId: '1f0c5a3e-9b7d-4c21-8e6f-0a1b2c3d4e5f', state: 'succeeded' } } })
  })

  it('reports a failure notice as a failed turn', async () => {
    const { client } = setup({ reply: () => ({ content: '', parts: [{ type: 'notice', noticeKind: 'turn-failure', code: 'sandbox_unavailable', text: 'The sandbox did not start' }] }) })
    const started = await client.startTurn('ws-a', { content: 'Draft the memo' })
    expect(started).toMatchObject({ succeeded: true, value: { state: 'failed', reply: null, failure: { code: 'sandbox_unavailable', message: 'The sandbox did not start' } } })
  })

  it('reports an error notice from the sandbox producer as a failed turn with its typed reason', async () => {
    const { client } = setup({ reply: () => ({ content: 'Partial answer', parts: [
      { type: 'text', text: 'Partial answer' },
      { type: 'notice', id: 'error-1', noticeKind: 'error', code: 'SECRET_PROFILE_PREPARATION_FAILED',
        text: 'The sandbox model stream stopped before a clean completion.\n\nError: Secret profile preparation failed' },
    ] }) })
    const started = await client.startTurn('ws-a', { content: 'Draft the memo' })
    expect(started).toMatchObject({ succeeded: true, value: { state: 'failed', reply: null, failure: {
      code: 'SECRET_PROFILE_PREPARATION_FAILED', message: expect.stringContaining('Secret profile preparation failed'),
    } } })
  })

  it('names a reason for an error notice that carries no code', async () => {
    const { client } = setup({ reply: () => ({ content: '', parts: [{ type: 'notice', id: 'error-1', noticeKind: 'error', text: 'The turn failed upstream' }] }) })
    const started = await client.startTurn('ws-a', { content: 'Draft the memo' })
    expect(started).toMatchObject({ succeeded: true, value: { state: 'failed', failure: { code: 'turn.error', message: 'The turn failed upstream' } } })
  })

  it('lets an app report a failure it stamps on the row through failureOf', async () => {
    const { client } = setup({
      reply: () => ({ content: 'The sandbox agent returned an error before producing a visible answer.', parts: [],
        metadata: { responseStatus: 'failed', failureCode: 'sandbox.stream_failed', failureMessage: 'socket hung up' } }),
      failureOf: (message) => message.metadata?.responseStatus === 'failed'
        ? { code: String(message.metadata.failureCode), message: String(message.metadata.failureMessage) }
        : null,
    })
    const started = await client.startTurn('ws-a', { content: 'Draft the memo' })
    expect(started).toMatchObject({ succeeded: true, value: { state: 'failed', failure: { code: 'sandbox.stream_failed', message: 'socket hung up' } } })
  })

  it('keeps a warning notice beside an answer as a succeeded turn', async () => {
    const { client } = setup({ reply: () => ({ content: 'Here is the memo', parts: [
      { type: 'text', text: 'Here is the memo' }, { type: 'notice', id: 'w-1', noticeKind: 'warning', text: 'Model downgraded' },
    ] }) })
    const started = await client.startTurn('ws-a', { content: 'Draft the memo' })
    expect(started).toMatchObject({ succeeded: true, value: { state: 'succeeded', reply: { content: 'Here is the memo' } } })
  })

  it('reads a running turn as working even when a draft reply is persisted', async () => {
    let running: string[] = []
    const { client } = setup({ running: () => running })
    const started = await client.startTurn('ws-a', { content: 'Long task' })
    if (!started.succeeded) throw new Error('start failed')
    running = [started.value.turnId]
    const read = await client.getTurn('ws-a', started.value.threadId, started.value.turnId)
    expect(read).toMatchObject({ succeeded: true, value: { state: 'working', reply: null } })
  })

  it('refuses a conversation from another workspace and an app refusal keeps its code', async () => {
    const { client, runTurn } = setup()
    expect(await client.startTurn('ws-a', { content: 'x', threadId: 'thread-b' })).toMatchObject({ succeeded: false, status: 404, code: 'operator.thread_not_found' })
    expect(await client.getTurn('ws-a', 'thread-b', '1f0c5a3e-9b7d-4c21-8e6f-0a1b2c3d4e5f')).toMatchObject({ succeeded: false, status: 404 })
    runTurn.mockResolvedValueOnce(Response.json({ error: 'Seat required', code: 'billing.seat_required' }, { status: 402 }))
    expect(await client.startTurn('ws-a', { content: 'x' })).toMatchObject({ succeeded: false, status: 402, code: 'billing.seat_required' })
    runTurn.mockResolvedValueOnce(Response.json({ error: { code: 'platform_key_required', message: 'Link your Tangle account' } }, { status: 403 }))
    expect(await client.startTurn('ws-a', { content: 'y' })).toMatchObject({ succeeded: false, status: 403, code: 'platform_key_required', error: 'Link your Tangle account' })
  })

  it('reads and continues only the conversations the app lets this caller see', async () => {
    const { client, runTurn } = setup()
    expect(await client.getThread('ws-a', 'thread-colleague')).toMatchObject({ succeeded: false, status: 404 })
    expect(await client.startTurn('ws-a', { content: 'x', threadId: 'thread-colleague' })).toMatchObject({ succeeded: false, status: 404, code: 'operator.thread_not_found' })
    expect(runTurn).not.toHaveBeenCalled()
  })
})

function durableAdmissionFixture(): ChatOperatorAdmissionStore<Identity> {
  const rows = new Map<string, ChatOperatorAdmission>()
  const key = (owner: string, workspace: string, turn: string) => `${owner}:${workspace}:${turn}`
  return {
    async get(ctx, workspace, turn) { return rows.get(key(ctx.identity.userId, workspace, turn)) ?? null },
    async claim(ctx, input) {
      const id = key(ctx.identity.userId, input.workspaceId, input.turnId)
      if (rows.has(id)) return false
      rows.set(id, { threadId: input.threadId })
      return true
    },
    async recordRefusal(ctx, input, refusal) { rows.set(key(ctx.identity.userId, input.workspaceId, input.turnId), { threadId: input.threadId, refusal }) },
  }
}

describe('durable operator admission seam', () => {
  it('suppresses concurrent starts without making the claim the completion owner', async () => {
    const h = setup({ admissions: durableAdmissionFixture() })
    const input = { content: 'Only once', turnId: crypto.randomUUID() }
    const results = await Promise.all([h.client.startTurn('ws-a', input), h.client.startTurn('ws-a', input)])
    expect(results.every(result => result.succeeded)).toBe(true)
    expect(h.runTurn).toHaveBeenCalledTimes(1)
    const again = await h.client.startTurn('ws-a', input)
    expect(again).toMatchObject({ succeeded: true, value: { state: 'succeeded', reply: { content: 'Done: Only once' } } })
    expect(await h.client.startTurn('ws-a', { ...input, content: 'Changed payload' })).toMatchObject({ succeeded: true, value: { reply: { content: 'Done: Only once' } } })
    expect(await h.client.startTurn('ws-a', { ...input, threadId: 'thread-colleague' })).toMatchObject({ succeeded: false, status: 409 })
    expect(h.runTurn).toHaveBeenCalledTimes(1)
  })

  it('returns unknown after a claim-before-transcript crash and reconciles from retained chat rows', async () => {
    const admissions = durableAdmissionFixture()
    const first = setup({ admissions })
    first.runTurn.mockRejectedValueOnce(new Error('simulated process loss after claim'))
    const input = { content: 'Recover the existing work', turnId: crypto.randomUUID() }
    expect(await first.client.startTurn('ws-a', input)).toMatchObject({ succeeded: false, status: 500 })
    const restarted = setup({ admissions, threads: first.threads, messages: first.messages })
    const recovered = await restarted.client.startTurn('ws-a', input)
    expect(recovered).toMatchObject({ succeeded: true, value: { state: 'unknown', reply: null } })
    expect(restarted.runTurn).not.toHaveBeenCalled()
    if (!recovered.succeeded) throw new Error('Missing recovered identity')
    const id = recovered.value.threadId
    expect(await restarted.client.getTurn('ws-a', id, input.turnId)).toMatchObject({ succeeded: true, value: { state: 'unknown' } })
    first.messages.set(id, [
      { id: 'u', role: 'user', content: input.content, parts: [{ type: 'text', text: input.content, turnId: input.turnId }] },
      { id: 'a', role: 'assistant', content: 'Recovered actual output', parts: [] },
    ])
    expect(await restarted.client.getTurn('ws-a', id, input.turnId)).toMatchObject({ succeeded: true, value: { state: 'succeeded', reply: { content: 'Recovered actual output' } } })
    expect(restarted.runTurn).not.toHaveBeenCalled()
  })

  it('persists an explicit pre-start refusal as failed; only a new authorized UUID tries again', async () => {
    const h = setup({ admissions: durableAdmissionFixture() })
    h.runTurn.mockResolvedValueOnce(Response.json({ error: 'Model not configured', code: 'model.not_configured' }, { status: 503 }))
    const input = { content: 'Do the work', turnId: crypto.randomUUID() }
    for (let i = 0; i < 2; i++) expect(await h.client.startTurn('ws-a', input)).toMatchObject({ succeeded: true, value: { state: 'failed', failure: { code: 'model.not_configured' } } })
    expect(h.runTurn).toHaveBeenCalledTimes(1)
    expect(await h.client.startTurn('ws-a', { ...input, turnId: crypto.randomUUID() })).toMatchObject({ succeeded: true, value: { state: 'succeeded' } })
  })
})


describe('authoritative turn completion', () => {
  it('never promotes an abandoned partial reply after its running lease disappears', async () => {
    let status: 'running' | 'complete' | 'error' | null = 'running'
    let running: string[] = ['stream-id']
    const h = setup({ turnStatus: async () => status, running: () => running })
    const input = { turnId: crypto.randomUUID(), content: 'Partial report' }
    const started = await h.client.startTurn('ws-a', input)
    expect(started).toMatchObject({ succeeded: true, value: { state: 'working', reply: null } })
    if (!started.succeeded) throw new Error('Missing turn')
    const read = () => h.client.getTurn('ws-a', started.value.threadId, input.turnId)
    running = []
    expect(await read()).toMatchObject({ succeeded: true, value: { state: 'unknown', reply: null } })
    status = null
    expect(await read()).toMatchObject({ succeeded: true, value: { state: 'unknown', reply: null } })
    status = 'error'
    expect(await read()).toMatchObject({ succeeded: true, value: { state: 'failed', reply: null, failure: { code: 'turn.error' } } })
    status = 'complete'
    expect(await read()).toMatchObject({ succeeded: true, value: { state: 'succeeded', reply: { content: 'Done: Partial report' } } })
  })
})
