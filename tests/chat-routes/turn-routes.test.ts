import { describe, expect, it, vi } from 'vitest'

import {
  createChatTurnRoutes,
  type ChatTurnMessageStore,
  type ChatTurnProduceArgs,
  type ChatTurnRouteProducer,
} from '../../src/chat-routes/index'
import type { ChatMessagePart } from '../../src/chat-store/parts'
import type { InteractionRequestWire } from '../../src/interactions/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'

// ── fakes ────────────────────────────────────────────────────────────────────

interface StoredMessage {
  id: string
  threadId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  parts?: ChatMessagePart[]
  model?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  costUsd?: number | null
}

function memoryMessageStore() {
  const rows: StoredMessage[] = []
  let nextId = 1
  const store: ChatTurnMessageStore = {
    async listMessages(threadId) {
      return rows.filter((row) => row.threadId === threadId)
    },
    async appendMessage(input) {
      const row: StoredMessage = { id: `m${nextId++}`, ...input }
      rows.push(row)
      return row
    },
  }
  return { store, rows }
}

/** Producer that streams the given events then reports the final text. */
function fakeProducer(
  events: Array<Record<string, unknown>>,
  finalText: string,
  extras: Partial<ChatTurnRouteProducer> = {},
): ChatTurnRouteProducer {
  return {
    stream: (async function* () {
      for (const event of events) yield event as { type: string; data?: Record<string, unknown> }
    })(),
    finalText: () => finalText,
    ...extras,
  }
}

function turnRequest(body: Record<string, unknown>): Request {
  return new Request('http://app.test/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function readLines(body: ReadableStream<Uint8Array>): Promise<Array<Record<string, unknown>>> {
  const text = await new Response(body).text()
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function makeRoutes(overrides: Partial<Parameters<typeof createChatTurnRoutes>[0]> = {}) {
  const { store, rows } = memoryMessageStore()
  const turnStore = createMemoryTurnEventStore()
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) }
  const routes = createChatTurnRoutes({
    projectId: 'test-app',
    authorize: async () => ({ ok: true, tenantId: 'ws-1', userId: 'user-1', context: undefined }),
    store,
    turnStore,
    produce: () => fakeProducer([{ type: 'text', text: 'hi ' }, { type: 'text', text: 'there' }], 'hi there'),
    log: () => {},
    ...overrides,
  })
  return { routes, rows, turnStore, ctx, pending }
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('createChatTurnRoutes — turn', () => {
  it('streams the turn: turn marker first, then engine-framed producer events', async () => {
    const { routes, ctx, pending } = makeRoutes()
    const res = await routes.turn(turnRequest({ threadId: 't-1', content: 'hello' }), ctx)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')
    const lines = await readLines(res.body!)

    expect(lines[0]).toMatchObject({ type: 'turn' })
    expect(typeof lines[0]!.turnId).toBe('string')
    const textLines = lines.filter((l) => l.type === 'text')
    expect(textLines.map((l) => l.text)).toEqual(['hi ', 'there'])
    // The engine owns the lifecycle envelope.
    expect(lines.some((l) => String(l.type).startsWith('session.run.'))).toBe(true)
    await Promise.all(pending)
  })

  it('persists the user message on send and the assistant message on completion', async () => {
    const { routes, rows, ctx, pending } = makeRoutes({
      produce: () =>
        fakeProducer([{ type: 'text', text: 'answer' }], 'answer', {
          assistantParts: () => [{ type: 'text', text: 'answer' }],
          usage: () => ({ inputTokens: 11, outputTokens: 7, costUsd: 0.01 }),
          model: 'anthropic/claude',
        }),
    })
    const res = await routes.turn(turnRequest({ threadId: 't-1', content: 'question?' }), ctx)
    await readLines(res.body!)
    await Promise.all(pending)

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ role: 'user', content: 'question?', threadId: 't-1' })
    expect(rows[1]).toMatchObject({
      role: 'assistant',
      content: 'answer',
      model: 'anthropic/claude',
      inputTokens: 11,
      outputTokens: 7,
      costUsd: 0.01,
    })
    expect(rows[1]!.parts).toEqual([{ type: 'text', text: 'answer' }])
  })

  it('does not double-insert the user row on a retried turnId', async () => {
    const { routes, rows, ctx, pending } = makeRoutes()
    const body = { threadId: 't-1', content: 'same question', turnId: 'turn-abc' }
    await readLines((await routes.turn(turnRequest(body), ctx)).body!)
    await Promise.all(pending.splice(0))
    await readLines((await routes.turn(turnRequest(body), ctx)).body!)
    await Promise.all(pending.splice(0))

    expect(rows.filter((r) => r.role === 'user')).toHaveLength(1)
  })

  it('persists echoed file parts onto the user message and hands parts to the producer', async () => {
    const produce = vi.fn((_args: ChatTurnProduceArgs<unknown>) => fakeProducer([{ type: 'text', text: 'ok' }], 'ok'))
    const { routes, rows, ctx, pending } = makeRoutes({ produce })
    const filePart = { type: 'image', filename: 'a.png', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' }
    const res = await routes.turn(
      turnRequest({ threadId: 't-1', content: 'look at this', parts: [filePart] }),
      ctx,
    )
    await readLines(res.body!)
    await Promise.all(pending)

    const userRow = rows.find((r) => r.role === 'user')!
    expect(userRow.parts).toEqual([{ type: 'text', text: 'look at this' }, filePart])

    const args = produce.mock.calls[0]![0]
    expect(args.prompt).toEqual([{ type: 'text', text: 'look at this' }, filePart])
    expect(args.identity).toMatchObject({ tenantId: 'ws-1', sessionId: 't-1', userId: 'user-1', turnIndex: 0 })
    expect(args.executionId).toContain('test-app')
  })

  it('rejects a body with neither content nor parts, and a missing threadId', async () => {
    const { routes, ctx } = makeRoutes()
    expect((await routes.turn(turnRequest({ threadId: 't-1' }), ctx)).status).toBe(400)
    expect((await routes.turn(turnRequest({ content: 'x' }), ctx)).status).toBe(400)
  })

  it('rejects inline parts over the byte budget with 413 (gateway-cap gate)', async () => {
    const { routes, ctx } = makeRoutes()
    const res = await routes.turn(
      turnRequest({
        threadId: 't-1',
        content: 'big',
        parts: [{ type: 'file', filename: 'big.bin', url: `data:application/octet-stream;base64,${'A'.repeat(1_000_001)}` }],
      }),
      ctx,
    )
    expect(res.status).toBe(413)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('PROMPT_PARTS_TOO_LARGE')
  })

  it('short-circuits with the authorize seam response', async () => {
    const { routes, rows, ctx } = makeRoutes({
      authorize: async () => ({ ok: false, response: Response.json({ error: 'nope' }, { status: 401 }) }),
    })
    const res = await routes.turn(turnRequest({ threadId: 't-1', content: 'hi' }), ctx)
    expect(res.status).toBe(401)
    expect(rows).toHaveLength(0)
  })
})

describe('createChatTurnRoutes — buffered replay', () => {
  it('replays the full turn after a simulated client drop', async () => {
    const { routes, ctx, pending } = makeRoutes({
      produce: () =>
        fakeProducer(
          Array.from({ length: 20 }, (_, i) => ({ type: 'text', text: `chunk${i} ` })),
          Array.from({ length: 20 }, (_, i) => `chunk${i} `).join(''),
        ),
    })
    const res = await routes.turn(turnRequest({ threadId: 't-9', content: 'go' }), ctx)

    // Read only the first chunk (the turn marker), then drop the connection.
    const reader = res.body!.getReader()
    const first = await reader.read()
    const firstLine = JSON.parse(new TextDecoder().decode(first.value).split('\n')[0]!) as { turnId: string }
    await reader.cancel()

    // The teed drain finishes the turn server-side.
    await Promise.all(pending)

    const replayRes = await routes.replay(
      new Request(`http://app.test/api/chat/replay/${firstLine.turnId}?fromSeq=0`),
      { turnId: firstLine.turnId },
    )
    expect(replayRes.status).toBe(200)
    const lines = await readLines(replayRes.body!)

    expect(lines[0]).toMatchObject({ type: 'turn', turnId: firstLine.turnId })
    const textLines = lines.filter((l) => l.type === 'text')
    const replayedText = textLines.map((l) => String(l.text)).join('')
    expect(replayedText).toBe(Array.from({ length: 20 }, (_, i) => `chunk${i} `).join(''))
    // Coalesced persistence: contiguous deltas merge per flush window instead
    // of landing as one row per token.
    expect(textLines.length).toBeLessThan(20)
    // Terminates with the status marker so clients know why the stream ended.
    expect(lines.at(-1)).toMatchObject({ type: 'turn_status', status: 'complete' })
  })

  it('authorizes replay through the same seam', async () => {
    const { routes } = makeRoutes({
      authorize: async (args) =>
        args.intent === 'replay'
          ? { ok: false, response: Response.json({ error: 'no' }, { status: 403 }) }
          : { ok: true, tenantId: 'ws-1', userId: 'user-1', context: undefined },
    })
    const res = await routes.replay(new Request('http://app.test/replay/x'), { turnId: 'x' })
    expect(res.status).toBe(403)
  })
})

describe('createChatTurnRoutes — interactions composition', () => {
  function wireQuestion(id: string): InteractionRequestWire {
    return {
      id,
      kind: 'question',
      title: 'Proceed?',
      answerSpec: {
        fields: [{
          type: 'select',
          name: 'q0',
          label: 'Proceed?',
          required: true,
          multi: false,
          options: [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }],
        }],
      },
    } as InteractionRequestWire
  }

  it('answers a sidecar ask round-trip through the composed /interactions route', async () => {
    const outstanding = new Map([['ask-1', wireQuestion('ask-1')]])
    const posts: Array<Record<string, unknown>> = []
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return Response.json({ data: { interactions: [...outstanding.values()] } })
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      posts.push(body)
      outstanding.delete(String(body.id))
      return Response.json({ data: { ok: true } })
    }) as typeof fetch

    const { routes } = makeRoutes({
      interactions: {
        resolveConnection: async () => ({
          ok: true,
          connection: { runtimeUrl: 'http://sidecar.test', sessionId: 't-1', fetchImpl },
        }),
        logger: { warn: () => {}, error: () => {} },
      },
    })

    expect(routes.interactions).not.toBeNull()
    const res = await routes.interactions!.answer(
      new Request('http://app.test/api/chat/interactions', {
        method: 'POST',
        body: JSON.stringify({ id: 'ask-1', outcome: 'accepted', data: { q0: 'Yes' } }),
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(posts).toEqual([{ id: 'ask-1', outcome: 'accepted', data: { q0: 'Yes' } }])
  })

  it('is null when the product wires no interactions channel', () => {
    const { routes } = makeRoutes()
    expect(routes.interactions).toBeNull()
  })
})
