import { describe, expect, it, vi } from 'vitest'
import {
  createChatOperatorAdapter,
  createOperatorApi,
  createOperatorClient,
  type ChatOperatorMessage,
  type ChatOperatorThread,
} from '../src/operator'
import type { RequestApiKey } from '../src/platform/api-key-auth'

type Identity = { userId: string }
const ORIGIN = 'https://app.example'

function setup(options: { reply?: (content: string) => Record<string, unknown>; running?: () => string[] | null } = {}) {
  const threads = new Map<string, ChatOperatorThread>([['thread-b', { id: 'thread-b', workspaceId: 'ws-b', title: 'Other' }]])
  const messages = new Map<string, ChatOperatorMessage[]>()
  let clock = 0
  const runTurn = vi.fn(async (_ctx: unknown, input: { threadId: string; turnId: string; content: string }) => {
    const list = messages.get(input.threadId) ?? []
    list.push({ id: `u-${input.turnId}`, role: 'user', content: input.content, parts: [{ type: 'text', text: input.content, turnId: input.turnId }], createdAt: ++clock })
    const reply = options.reply?.(input.content) ?? { content: `Done: ${input.content}`, parts: [{ type: 'session-artifact', path: 'notes/plan.md', action: 'created' }] }
    list.push({ id: `a-${input.turnId}`, role: 'assistant', content: String(reply.content ?? ''), parts: (reply.parts as Array<Record<string, unknown>>) ?? [], createdAt: ++clock, servedModel: 'gpt-6-luna', costUsd: 0.12 })
    messages.set(input.threadId, list)
    return new Response('{"type":"text"}\n{"type":"done"}\n', { headers: { 'content-type': 'application/x-ndjson' } })
  })
  const adapter = createChatOperatorAdapter<Identity>({
    origin: ORIGIN,
    workspaces: {
      authorize: async (_ctx, workspaceId) => (workspaceId === 'ws-a' ? { id: 'ws-a', name: 'Firm', role: 'owner' } : null),
      list: async () => [{ id: 'ws-a', name: 'Firm', role: 'owner' }],
    },
    threads: {
      get: async (id) => threads.get(id) ?? null,
      create: async (input) => {
        if (threads.has(input.id)) throw new Error('UNIQUE constraint failed: thread.id')
        const thread = { ...input }
        threads.set(input.id, thread)
        return thread
      },
      listMessages: async (id) => messages.get(id) ?? [],
    },
    runTurn,
    runningTurns: async () => options.running?.() ?? [],
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
  })
})
