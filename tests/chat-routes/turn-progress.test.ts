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
  const reads: string[] = []
  const store: ChatTurnMessageStore = {
    async listMessages(threadId) {
      reads.push(threadId)
      return rows.filter((row) => row.threadId === threadId) as never
    },
    async appendMessage(input) {
      const row = { id: `m${next++}`, ...input }
      rows.push(row)
      return row
    },
  }
  return { store, rows, reads }
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
  const { store, rows, reads } = memoryStore()
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) }
  let produced = 0
  const routes = createChatTurnRoutes({
    projectId: 'test-app',
    authorize: async () => ({ ok: true, tenantId: 'ws-1', userId: 'user-1', context: undefined }),
    store,
    turnStore: createMemoryTurnEventStore(),
    produce: () => { produced += 1; return producer('hello there') },
    incrementalPersistence: false,
    log: () => {},
    ...overrides,
  })
  return { routes, rows, reads, ctx, pending, produced: () => produced }
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

const REFUSALS: Array<[number, Record<string, unknown>, Record<string, string>]> = [
  [401, { error: 'Sign in to continue' }, {}],
  [402, { error: 'A seat is required', code: 'seat_required', checkoutUrl: 'https://billing.test/seat' }, {}],
  [403, { error: 'Insufficient permissions to choose a chat model' }, {}],
  [404, { error: 'Workspace not found' }, {}],
  [429, { error: 'Rate limit exceeded. Try again in 42 seconds.' }, { 'Retry-After': '42' }],
]

describe('progress-first turn stream: admission', () => {
  it.each(REFUSALS)('answers an authorization %i as a plain response: no stream, no stage, no work', async (status, body, headers) => {
    const { routes, ctx, pending, reads, rows, produced } = makeRoutes({
      authorize: async () => ({ ok: false, response: Response.json(body, { status, headers }) }),
      turnLock: { acquire: () => { throw new Error('lock must not be taken') }, release: () => {} },
    })
    const response = await routes.turn(turnRequest({ threadId: 't-secret', content: 'hi' }), ctx)
    expect(response.status).toBe(status)
    expect(response.headers.get(TURN_PROGRESS_HEADER)).toBeNull()
    expect(response.headers.get('content-type')).toContain('application/json')
    for (const [name, value] of Object.entries(headers)) expect(response.headers.get(name)).toBe(value)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual(body)
    expect(text).not.toContain('session.run.phase')
    expect(pending).toHaveLength(0)
    expect(reads).toHaveLength(0)
    expect(rows).toHaveLength(0)
    expect(produced()).toBe(0)
  })

  it('answers an invalid body with a plain 400 before authorization runs', async () => {
    let authorized = false
    const { routes, ctx, pending } = makeRoutes({
      authorize: async () => { authorized = true; return { ok: true, tenantId: 'ws-1', userId: 'user-1', context: undefined } },
    })
    const response = await routes.turn(turnRequest({ content: 'no thread' }), ctx)
    expect(response.status).toBe(400)
    expect(response.headers.get(TURN_PROGRESS_HEADER)).toBeNull()
    expect(authorized).toBe(false)
    expect(pending).toHaveLength(0)
  })

  it('holds no stream open for unauthenticated callers, however many arrive at once', async () => {
    const { routes, ctx, pending, reads, produced } = makeRoutes({
      authorize: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return { ok: false, response: Response.json({ error: 'Sign in to continue' }, { status: 401 }) }
      },
    })
    const responses = await Promise.all(
      Array.from({ length: 25 }, (_, i) => routes.turn(turnRequest({ threadId: `t-${i}`, content: 'hi' }), ctx)),
    )
    expect(responses.map((response) => response.status)).toEqual(Array(25).fill(401))
    expect(responses.every((response) => response.headers.get(TURN_PROGRESS_HEADER) === null)).toBe(true)
    // No progress-first pump, no turn drain: nothing outlives the 401.
    expect(pending).toHaveLength(0)
    expect(reads).toHaveLength(0)
    expect(produced()).toBe(0)
  })

  it('opens the stream only once authorization admits the caller, and touches nothing before', async () => {
    let releaseAuth!: () => void
    const authGate = new Promise<void>((resolve) => { releaseAuth = resolve })
    const { routes, ctx, reads } = makeRoutes({
      authorize: async () => {
        await authGate
        return { ok: true, tenantId: 'ws-1', userId: 'user-1', context: undefined }
      },
    })
    let opened = false
    const responsePromise = routes.turn(turnRequest({ threadId: 't-1', content: 'hi' }), ctx).then((response) => {
      opened = true
      return response
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(opened).toBe(false)
    expect(reads).toHaveLength(0)
    releaseAuth()
    const response = await responsePromise
    expect(response.headers.get(TURN_PROGRESS_HEADER)).toBe(TURN_PROGRESS_FIRST)
    const reader = response.body!.getReader()
    const first = JSON.parse(new TextDecoder().decode((await reader.read()).value).split('\n')[0]!)
    expect(first).toMatchObject({ type: 'session.run.phase', data: { phase: 'accepted' } })
    await reader.cancel()
  })

  it('a thrown authorization fails the request exactly as without the header', async () => {
    const { routes, ctx, pending } = makeRoutes({ authorize: async () => { throw new Error('database unavailable') } })
    await expect(routes.turn(turnRequest({ threadId: 't-1', content: 'hi' }), ctx)).rejects.toThrow('database unavailable')
    expect(pending).toHaveLength(0)
  })
})

describe('progress-first turn stream: an admitted turn', () => {
  it('names each route stage with static text only, then streams the turn unchanged', async () => {
    const { routes, ctx, pending, rows } = makeRoutes({
      authorize: async () => ({ ok: true, tenantId: 'ws-secret', userId: 'user-secret', context: undefined }),
      progressMessages: { preparing: 'Getting the agent ready…' },
      turnLock: { acquire: () => ({ acquired: true as const, handle: 'lock' }), release: () => {} },
    })
    const all = await lines(await routes.turn(turnRequest({ threadId: 't-secret', content: 'hi' }), ctx))
    await Promise.all(pending)
    const markerAt = all.findIndex((event) => event.type === 'turn')
    const before = all.slice(0, markerAt)
    expect(before.map((event) => (event.data as { phase: string }).phase)).toEqual(['accepted', 'preparing'])
    expect(before[1]).toMatchObject({ data: { message: 'Getting the agent ready…' } })
    for (const event of before) {
      expect(Object.keys(event)).toEqual(['type', 'data'])
      expect(Object.keys(event.data as object).sort()).toEqual(['message', 'phase', 'sinceRequestMs'])
    }
    expect(JSON.stringify(before)).not.toMatch(/secret/)
    expect(all.some((event) => event.type === 'text' && event.text === 'hello there')).toBe(true)
    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant'])
  })

  it('carries a held lock as its 409 and runs nothing', async () => {
    const { routes, ctx, rows, produced } = makeRoutes({
      turnLock: {
        acquire: () => ({ acquired: false as const, response: Response.json({ code: 'in_flight' }, { status: 409 }) }),
        release: () => {},
      },
    })
    const settled = await settleTurnResponse(await routes.turn(turnRequest({ threadId: 't-1', content: 'hi' }), ctx), () => {})
    expect(settled.status).toBe(409)
    expect(await settled.json()).toEqual({ code: 'in_flight' })
    expect(produced()).toBe(0)
    expect(rows).toHaveLength(0)
  })

  it("carries a gate's answer with its status and headers, never its cookies", async () => {
    const { routes, ctx } = makeRoutes({
      contextGate: () => ({
        proceed: false,
        response: Response.json({ error: 'Slow down' }, { status: 429, headers: { 'Retry-After': '7', 'Set-Cookie': 'a=b' } }),
      }),
    })
    const phases: TurnPhaseData[] = []
    const settled = await settleTurnResponse(
      await routes.turn(turnRequest({ threadId: 't-1', content: 'hi' }), ctx),
      (phase) => phases.push(phase),
    )
    expect(phases.map((phase) => phase.phase)).toEqual(['accepted', 'preparing'])
    expect(settled.status).toBe(429)
    expect(settled.headers.get('retry-after')).toBe('7')
    expect(settled.headers.get('set-cookie')).toBeNull()
    expect(await settled.json()).toEqual({ error: 'Slow down' })
  })

  it('reports a failure after admission as a 500 instead of a broken stream', async () => {
    const { routes, ctx } = makeRoutes({
      store: {
        listMessages: async () => { throw new Error('database unavailable') },
        appendMessage: async () => { throw new Error('unreachable') },
      },
    })
    const settled = await settleTurnResponse(await routes.turn(turnRequest({ threadId: 't-1', content: 'hi' }), ctx), () => {})
    expect(settled.status).toBe(500)
    expect(await settled.json()).toMatchObject({ error: expect.any(String) })
  })

  it('reads the whole request body before the response opens', async () => {
    // A Worker cannot read the request stream after its response is sent.
    let bodyRead = false
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        controller.enqueue(encoder.encode(JSON.stringify({ threadId: 't-1', content: 'hi' })))
        controller.close()
        bodyRead = true
      },
    })
    const { routes, ctx, pending } = makeRoutes()
    const request = new Request('http://app.test/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TURN_PROGRESS_HEADER]: TURN_PROGRESS_FIRST },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    const response = await routes.turn(request, ctx)
    expect(bodyRead).toBe(true)
    const all = await lines(response)
    await Promise.all(pending)
    expect(all.some((event) => event.type === 'text' && event.text === 'hello there')).toBe(true)
  })

  it('keeps the old responses for a client that does not ask', async () => {
    const { routes, ctx } = makeRoutes()
    const response = await routes.turn(turnRequest({ threadId: 't-1', content: 'hi' }, false), ctx)
    expect(response.headers.get(TURN_PROGRESS_HEADER)).toBeNull()
    const all = await lines(response)
    expect(all[0]).toMatchObject({ type: 'turn' })
    expect(all.some((event) => event.type === 'session.run.phase')).toBe(false)
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
