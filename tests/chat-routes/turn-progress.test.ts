import { describe, expect, it } from 'vitest'

import {
  createChatTurnRoutes,
  settleTurnResponse,
  TURN_PROGRESS_FIRST,
  TURN_PROGRESS_HEADER,
  TURN_STREAM_LOST_CODE,
  type ChatTurnMessageStore,
  type ChatTurnRouteProducer,
  type TurnPhaseData,
} from '../../src/chat-routes/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import { consumeChatStream } from '../../src/web-react/chat-stream'

function memoryStore() {
  const rows: Array<{ id: string; threadId: string; role: string; content: string }> = []
  let next = 1
  const store: ChatTurnMessageStore = {
    async listMessages(threadId) {
      return rows.filter((row) => row.threadId === threadId) as never
    },
    async appendMessage(input) {
      const row = { id: `m${next++}`, ...input }
      rows.push(row)
      return row
    },
  }
  return { store, rows }
}

function producer(text: string): ChatTurnRouteProducer {
  return {
    stream: (async function* () {
      yield { type: 'text', text } as { type: string; data?: Record<string, unknown> }
    })(),
    finalText: () => text,
  }
}

function makeRoutes(overrides: Partial<Parameters<typeof createChatTurnRoutes>[0]> = {}) {
  const { store, rows } = memoryStore()
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) }
  const routes = createChatTurnRoutes({
    projectId: 'test-app',
    authorize: async () => ({ ok: true, tenantId: 'ws-1', userId: 'user-1', context: undefined }),
    store,
    turnStore: createMemoryTurnEventStore(),
    produce: () => producer('hello there'),
    incrementalPersistence: false,
    log: () => {},
    ...overrides,
  })
  return { routes, rows, ctx, pending }
}

function turnRequest(body: Record<string, unknown>, progressFirst = true): Request {
  return new Request('http://app.test/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(progressFirst ? { [TURN_PROGRESS_HEADER]: TURN_PROGRESS_FIRST } : {}),
    },
    body: JSON.stringify(body),
  })
}

async function lines(response: Response): Promise<Array<Record<string, unknown>>> {
  return (await response.text()).split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
}

describe('progress-first turn stream', () => {
  it('opens the stream with the accepted stage before authorization finishes', async () => {
    let releaseAuth!: () => void
    const authGate = new Promise<void>((resolve) => { releaseAuth = resolve })
    const { routes, ctx } = makeRoutes({
      authorize: async () => {
        await authGate
        return { ok: true, tenantId: 'ws-1', userId: 'user-1', context: undefined }
      },
    })
    const response = await routes.turn(turnRequest({ threadId: 't-1', content: 'hi' }), ctx)
    expect(response.status).toBe(200)
    expect(response.headers.get(TURN_PROGRESS_HEADER)).toBe(TURN_PROGRESS_FIRST)
    const reader = response.body!.getReader()
    const first = JSON.parse(new TextDecoder().decode((await reader.read()).value).trim())
    expect(first).toMatchObject({ type: 'session.run.phase', data: { phase: 'accepted' } })
    expect(typeof first.data.message).toBe('string')
    releaseAuth()
    await reader.cancel()
  })

  it('names each route stage, then streams the turn unchanged', async () => {
    const { routes, ctx, pending, rows } = makeRoutes({
      progressMessages: { preparing: 'Getting the agent ready…' },
      turnLock: { acquire: () => ({ acquired: true as const, handle: 'lock' }), release: () => {} },
    })
    const all = await lines(await routes.turn(turnRequest({ threadId: 't-1', content: 'hi' }), ctx))
    await Promise.all(pending)
    expect(all.map((event) => event.type).slice(0, 3)).toEqual(['session.run.phase', 'session.run.phase', 'turn'])
    expect(all[0]).toMatchObject({ data: { phase: 'accepted' } })
    expect(all[1]).toMatchObject({ data: { phase: 'preparing', message: 'Getting the agent ready…' } })
    expect(all.some((event) => event.type === 'text' && event.text === 'hello there')).toBe(true)
    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant'])
  })

  it('carries a refusal in-stream; settling restores its status, headers and body', async () => {
    const { routes, ctx } = makeRoutes({
      authorize: async () => ({
        ok: false,
        response: Response.json({ error: 'Slow down' }, { status: 429, headers: { 'Retry-After': '7', 'Set-Cookie': 'a=b' } }),
      }),
    })
    const phases: TurnPhaseData[] = []
    const settled = await settleTurnResponse(
      await routes.turn(turnRequest({ threadId: 't-1', content: 'hi' }), ctx),
      (phase) => phases.push(phase),
    )
    expect(phases.map((phase) => phase.phase)).toEqual(['accepted'])
    expect(settled.status).toBe(429)
    expect(settled.headers.get('retry-after')).toBe('7')
    expect(settled.headers.get('set-cookie')).toBeNull()
    expect(await settled.json()).toEqual({ error: 'Slow down' })
  })

  it('carries a held lock as its 409 and runs nothing', async () => {
    let produced = false
    const { routes, ctx, rows } = makeRoutes({
      produce: () => { produced = true; return producer('x') },
      turnLock: {
        acquire: () => ({ acquired: false as const, response: Response.json({ code: 'in_flight' }, { status: 409 }) }),
        release: () => {},
      },
    })
    const settled = await settleTurnResponse(await routes.turn(turnRequest({ threadId: 't-1', content: 'hi' }), ctx), () => {})
    expect(settled.status).toBe(409)
    expect(await settled.json()).toEqual({ code: 'in_flight' })
    expect(produced).toBe(false)
    expect(rows).toHaveLength(0)
  })

  it('reports a throw before the stream as a 500 instead of a broken stream', async () => {
    const { routes, ctx } = makeRoutes({ authorize: async () => { throw new Error('database unavailable') } })
    const settled = await settleTurnResponse(await routes.turn(turnRequest({ threadId: 't-1', content: 'hi' }), ctx), () => {})
    expect(settled.status).toBe(500)
    expect(await settled.json()).toMatchObject({ error: expect.any(String) })
  })

  it('keeps the old responses for a client that does not ask', async () => {
    const { routes, ctx } = makeRoutes({
      authorize: async () => ({ ok: false, response: Response.json({ error: 'Sign in' }, { status: 401 }) }),
    })
    const response = await routes.turn(turnRequest({ threadId: 't-1', content: 'hi' }, false), ctx)
    expect(response.status).toBe(401)
    expect(response.headers.get(TURN_PROGRESS_HEADER)).toBeNull()
  })

  it('a settled success stream reads exactly like the plain stream', async () => {
    const { routes, ctx } = makeRoutes()
    const phases: string[] = []
    const settled = await settleTurnResponse(
      await routes.turn(turnRequest({ threadId: 't-1', content: 'hi' }), ctx),
      (phase) => phases.push(phase.phase),
    )
    expect(settled.status).toBe(200)
    let text = ''
    const result = await consumeChatStream(settled.body!, { onText: (delta) => { text += delta } })
    expect(phases).toEqual(['accepted', 'preparing'])
    expect(result.turnId).toEqual(expect.any(String))
    expect(text).toBe('hello there')
  })

  it('a disconnect before the answer does not stop the turn', async () => {
    let releaseProducer!: () => void
    const gate = new Promise<void>((resolve) => { releaseProducer = resolve })
    const { routes, ctx, pending, rows } = makeRoutes({
      produce: () => ({
        stream: (async function* () {
          await gate
          yield { type: 'text', text: 'late answer' } as { type: string; data?: Record<string, unknown> }
        })(),
        finalText: () => 'late answer',
      }),
    })
    const response = await routes.turn(turnRequest({ threadId: 't-1', content: 'hi' }), ctx)
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()
    releaseProducer()
    for (let settledCount = 0; settledCount < pending.length; settledCount = pending.length) {
      await Promise.all(pending)
    }
    expect(rows.map((row) => [row.role, row.content])).toEqual([['user', 'hi'], ['assistant', 'late answer']])
  })
})

describe('settleTurnResponse', () => {
  it('returns a response that is not progress-first as it is', async () => {
    const plain = new Response('{"type":"turn","turnId":"t"}\n', { headers: { 'Content-Type': 'application/x-ndjson' } })
    expect(await settleTurnResponse(plain, () => {})).toBe(plain)
  })

  it('reports a stream that closed before the turn started', async () => {
    const closed = new Response(
      '{"type":"session.run.phase","data":{"phase":"accepted","message":"Loading"}}\n',
      { headers: { [TURN_PROGRESS_HEADER]: TURN_PROGRESS_FIRST } },
    )
    const phases: string[] = []
    const settled = await settleTurnResponse(closed, (phase) => phases.push(phase.message))
    expect(phases).toEqual(['Loading'])
    expect(settled.status).toBe(502)
    expect(await settled.json()).toMatchObject({ code: TURN_STREAM_LOST_CODE })
  })

  it('keeps an event split across chunks intact', async () => {
    const encoder = new TextEncoder()
    const parts = [
      '{"type":"session.run.phase","data":{"phase":"accepted","mess',
      'age":"Loading"}}\n{"type":"tu',
      'rn","turnId":"t-9"}\n{"type":"text","text":"ok"}\n',
    ]
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part))
        controller.close()
      },
    })
    const settled = await settleTurnResponse(
      new Response(body, { headers: { [TURN_PROGRESS_HEADER]: TURN_PROGRESS_FIRST } }),
      () => {},
    )
    let text = ''
    const result = await consumeChatStream(settled.body!, { onText: (delta) => { text += delta } })
    expect(result.turnId).toBe('t-9')
    expect(text).toBe('ok')
  })
})
