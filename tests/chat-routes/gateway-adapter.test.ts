import { describe, expect, it, vi } from 'vitest'

import { streamChatRouteAsSandboxEvents } from '../../src/chat-routes/gateway-adapter'
import type { ChatTurnRoutes } from '../../src/chat-routes/turn-routes'

function responseFromChunks(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { status, headers: { 'Content-Type': 'application/x-ndjson' } })
}

describe('streamChatRouteAsSandboxEvents', () => {
  it('drives the existing turn route and parses arbitrarily split NDJSON', async () => {
    let received: Request | undefined
    let turnContext: { cancelOnDisconnect?: boolean } | undefined
    const routes = {
      turn: vi.fn(async (request: Request, context?: { cancelOnDisconnect?: boolean }) => {
        received = request
        turnContext = context
        return responseFromChunks([
          '{"type":"turn","turnId":"turn-1"}\n{"type":"message.part.',
          'updated","data":{"part":{"type":"text"},"delta":"hello"}}\n',
          '{"type":"result","data":{"finalText":"hello"}}',
        ])
      }),
    } as unknown as ChatTurnRoutes
    const source = new Request('https://app.test/v1/agents/ws/chat/completions', {
      headers: { Authorization: 'Bearer private-key', 'X-Correlation-Id': 'request-1' },
    })

    const events = []
    for await (const event of streamChatRouteAsSandboxEvents({
      routes,
      request: source,
      payload: { workspaceId: 'ws-1', threadId: 'thread-1', content: 'do work' },
    })) events.push(event)

    expect(events).toEqual([
      { type: 'turn' },
      { type: 'message.part.updated', data: { part: { type: 'text' }, delta: 'hello' } },
      { type: 'result', data: { finalText: 'hello' } },
    ])
    expect(received?.method).toBe('POST')
    expect(received?.headers.get('Authorization')).toBe('Bearer private-key')
    expect(turnContext?.cancelOnDisconnect).toBe(true)
    expect(await received?.json()).toEqual({
      workspaceId: 'ws-1',
      threadId: 'thread-1',
      content: 'do work',
    })
  })

  it('fails loudly when the chat route refuses the turn', async () => {
    const routes = {
      turn: vi.fn(async () => Response.json({ error: 'Workspace not found' }, { status: 404 })),
    } as unknown as ChatTurnRoutes

    const stream = streamChatRouteAsSandboxEvents({
      routes,
      request: new Request('https://app.test/v1/agents/ws/chat/completions'),
      payload: { workspaceId: 'ws-1', threadId: 'thread-1', content: 'do work' },
    })

    await expect(stream.next()).rejects.toThrow('chat route rejected the gateway turn (404)')
  })

  it('translates flattened text and omits app-only usage receipts', async () => {
    const routes = {
      turn: vi.fn(async () => responseFromChunks([
        '{"type":"text","text":"hello"}\n',
        '{"type":"usage","usage":{"promptTokens":2,"completionTokens":1}}\n',
        '{"type":"done"}\n',
      ])),
    } as unknown as ChatTurnRoutes

    const events = []
    for await (const event of streamChatRouteAsSandboxEvents({
      routes,
      request: new Request('https://app.test/v1/agents/ws/chat/completions'),
      payload: { workspaceId: 'ws-1', threadId: 'thread-1', content: 'do work' },
    })) events.push(event)

    expect(events).toEqual([
      { type: 'message.part.updated', data: { part: { type: 'text' }, delta: 'hello' } },
      { type: 'done' },
    ])
  })

  it('aborts the app turn when the gateway stops the adapter early', async () => {
    let routeSignal: AbortSignal | undefined
    let bodyCancelled = false
    const encoder = new TextEncoder()
    const routes = {
      turn: vi.fn(async (request: Request) => {
        routeSignal = request.signal
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('{"type":"text","text":"partial"}\n'))
          },
          cancel() {
            bodyCancelled = true
          },
        }), { headers: { 'Content-Type': 'application/x-ndjson' } })
      }),
    } as unknown as ChatTurnRoutes

    const stream = streamChatRouteAsSandboxEvents({
      routes,
      request: new Request('https://app.test/v1/agents/ws/chat/completions'),
      payload: { workspaceId: 'ws-1', threadId: 'thread-1', content: 'do work' },
    })

    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { type: 'message.part.updated', data: { part: { type: 'text' }, delta: 'partial' } },
    })
    await stream.return(undefined)

    expect(routeSignal?.aborted).toBe(true)
    expect(bodyCancelled).toBe(true)
  })
})
