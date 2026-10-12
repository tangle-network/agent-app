import { describe, expect, it, vi } from 'vitest'
import { createChatTurnRoutes, type ChatTurnMessageStore } from '../../src/chat-routes/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'

type Message = Awaited<ReturnType<ChatTurnMessageStore['listMessages']>>[number]

function harness(changeWhileAcquiring?: (rows: Message[]) => void, options: { rereadFails?: boolean; refused?: boolean; unlocked?: boolean } = {}) {
  const rows: Message[] = [{ id: 'user-0', role: 'user', content: 'Earlier work', parts: [{ type: 'text', text: 'Earlier work' }] }]
  const listMessages = vi.fn(async () => {
    if (options.rereadFails && listMessages.mock.calls.length > 1) throw new Error('history unavailable')
    return rows
  })
  const appendMessage = vi.fn(async (input: Parameters<ChatTurnMessageStore['appendMessage']>[0]) => {
    const row = { ...input, id: `new-${rows.length}` }
    rows.push(row)
    return row
  })
  const release = vi.fn()
  const acquire = vi.fn(async () => {
    changeWhileAcquiring?.(rows)
    return options.refused
      ? { acquired: false as const, response: Response.json({ code: 'busy' }, { status: 409 }) }
      : { acquired: true as const, handle: 'our-lock' }
  })
  const beforeTurn = vi.fn()
  const produce = vi.fn(() => ({
    stream: (async function* () { yield { type: 'text', text: 'Actual answer' } })(),
    finalText: () => 'Actual answer',
  }))
  const routes = createChatTurnRoutes({
    projectId: 'history-fence',
    authorize: async () => ({ ok: true as const, tenantId: 'owner', userId: 'owner', context: undefined }),
    store: { listMessages, appendMessage },
    turnStore: createMemoryTurnEventStore(),
    ...(options.unlocked ? {} : { turnLock: { acquire, release } }),
    beforeTurn,
    produce,
    log: () => {},
  })
  const pending: Promise<unknown>[] = []
  const start = () => routes.turn(new Request('https://app.example/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ threadId: 'thread', turnId: 'new-turn', content: 'New work' }),
  }), { waitUntil: promise => { pending.push(promise) } })
  return { rows, listMessages, appendMessage, release, acquire, beforeTurn, produce, pending, start }
}

describe('turn lock history fence', () => {
  it.each([
    ['another turn was appended', (rows: Message[]) => { rows.push({ id: 'other-user', role: 'user', content: 'Concurrent work', parts: null }) }],
    ['an assistant settled', (rows: Message[]) => { rows.push({ id: 'answer-0', role: 'assistant', content: 'Prior result', parts: null }) }],
    ['retained content changed', (rows: Message[]) => { rows[0]!.content = 'Corrected earlier work' }],
    ['retained parts changed in place', (rows: Message[]) => { rows[0]!.parts![0] = { type: 'text', text: 'Corrected retained evidence' } }],
  ])('refuses stale derived identity after %s during acquisition', async (_label, change) => {
    const h = harness(change)
    const response = await h.start()
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'chat_history_changed' })
    expect(response.headers.has('x-turn-id')).toBe(false)
    expect(h.listMessages).toHaveBeenCalledTimes(2)
    expect(h.appendMessage).not.toHaveBeenCalled()
    expect(h.beforeTurn).not.toHaveBeenCalled()
    expect(h.produce).not.toHaveBeenCalled()
    expect(h.release).toHaveBeenCalledExactlyOnceWith('our-lock')
  })

  it('releases its lock and fails closed if the protected reread fails', async () => {
    const h = harness(undefined, { rereadFails: true })
    await expect(h.start()).rejects.toThrow('history unavailable')
    expect(h.appendMessage).not.toHaveBeenCalled()
    expect(h.produce).not.toHaveBeenCalled()
    expect(h.release).toHaveBeenCalledExactlyOnceWith('our-lock')
  })

  it('keeps the normal turn and settlement with an unchanged snapshot', async () => {
    const h = harness()
    const response = await h.start()
    expect(response.status).toBe(200)
    await response.text()
    await Promise.all(h.pending)
    expect(h.listMessages).toHaveBeenCalledTimes(2)
    expect(h.produce).toHaveBeenCalledTimes(1)
    expect(h.rows.map(row => row.role)).toEqual(['user', 'user', 'assistant'])
    expect(h.release).toHaveBeenCalledExactlyOnceWith('our-lock')
  })

  it('does not reread or release a lock that it never acquired', async () => {
    const h = harness(undefined, { refused: true })
    expect((await h.start()).status).toBe(409)
    expect(h.listMessages).toHaveBeenCalledTimes(1)
    expect(h.appendMessage).not.toHaveBeenCalled()
    expect(h.release).not.toHaveBeenCalled()
  })

  it('preserves the existing unlocked adapter read contract', async () => {
    const h = harness(undefined, { unlocked: true })
    await (await h.start()).text()
    await Promise.all(h.pending)
    expect(h.listMessages).toHaveBeenCalledTimes(1)
    expect(h.produce).toHaveBeenCalledTimes(1)
  })
})
