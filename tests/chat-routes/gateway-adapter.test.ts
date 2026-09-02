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
    let turnContext: {
      cancelOnDisconnect?: boolean
      executionLimits?: { maxOutputTokens?: number }
    } | undefined
    const routes = {
      turn: vi.fn(async (request: Request, context?: typeof turnContext) => {
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
      executionLimits: { maxOutputTokens: 512 },
    })) events.push(event)

    expect(events).toEqual([
      { type: 'turn' },
      { type: 'message.part.updated', data: { part: { type: 'text' }, delta: 'hello' } },
      { type: 'result', data: { finalText: 'hello' } },
    ])
    expect(received?.method).toBe('POST')
    expect(received?.headers.get('Authorization')).toBe('Bearer private-key')
    expect(turnContext?.cancelOnDisconnect).toBeUndefined()
    expect(turnContext?.executionLimits).toEqual({ maxOutputTokens: 512 })
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

  it('translates flattened text and preserves partial measured usage', async () => {
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
      { type: 'usage', data: { usage: { inputTokens: 2, outputTokens: 1 } } },
      { type: 'done' },
    ])
  })

  it('forwards every field from a complete provider-enforced usage receipt', async () => {
    const receipt = {
      promptTokens: 40,
      completionTokens: 20,
      reasoningTokens: 5,
      toolTokens: 13,
      toolCallCount: 2,
      providerCostUsd: 0.0123,
      budgetEnforced: true,
    }
    const routes = {
      turn: vi.fn(async () => responseFromChunks([
        `{"type":"usage","usage":${JSON.stringify(receipt)}}\n`,
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
      {
        type: 'usage',
        data: {
          usage: {
            inputTokens: 40,
            outputTokens: 20,
            reasoningTokens: 5,
            toolTokens: 13,
            toolCallCount: 2,
            providerCostUsd: 0.0123,
            budgetEnforced: true,
          },
        },
      },
      { type: 'done' },
    ])
  })

  it('preserves rich partial usage without claiming budget enforcement', async () => {
    const routes = {
      turn: vi.fn(async () => responseFromChunks([
        '{"type":"usage","usage":{"promptTokens":40,"completionTokens":20,"reasoningTokens":5,"toolTokens":13,"toolCallCount":2,"providerCostUsd":0.0123}}\n',
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
      {
        type: 'usage',
        data: {
          usage: {
            inputTokens: 40,
            outputTokens: 20,
            reasoningTokens: 5,
            toolTokens: 13,
            toolCallCount: 2,
            providerCostUsd: 0.0123,
          },
        },
      },
      { type: 'done' },
    ])
  })

  it('counts one completed tool and rejects malformed usage', async () => {
    const routes = {
      turn: vi.fn(async () => responseFromChunks([
        '{"type":"tool_call","call":{"toolCallId":"call-1","toolName":"search","args":{}}}\n',
        '{"type":"tool_call","call":{"toolCallId":"call-1","toolName":"search","args":{"q":"x"}}}\n',
        '{"type":"tool_result","toolCallId":"call-1","toolName":"search","outcome":{"ok":true}}\n',
        '{"type":"usage","usage":{"promptTokens":1.5}}\n',
      ])),
    } as unknown as ChatTurnRoutes

    const stream = streamChatRouteAsSandboxEvents({
      routes,
      request: new Request('https://app.test/v1/agents/ws/chat/completions'),
      payload: { workspaceId: 'ws-1', threadId: 'thread-1', content: 'do work' },
    })

    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { type: 'tool_call' },
    })
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { type: 'tool_call' },
    })
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { type: 'tool_result', data: { tool: { name: 'search' } } },
    })
    await expect(stream.next()).rejects.toThrow('invalid usage.inputTokens')
  })

  it('stops forwarding without aborting the durable app turn', async () => {
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

    expect(routeSignal?.aborted).toBe(false)
    expect(bodyCancelled).toBe(true)
  })

  it('stops its response branch on an API abort without aborting the app turn', async () => {
    let routeSignal: AbortSignal | undefined
    let bodyCancelled = false
    const encoder = new TextEncoder()
    const routes = {
      turn: vi.fn(async (request: Request) => {
        routeSignal = request.signal
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('{"type":"text","text":"hello"}\n'))
          },
          cancel() {
            bodyCancelled = true
          },
        }))
      }),
    } as unknown as ChatTurnRoutes
    const abort = new AbortController()
    const stream = streamChatRouteAsSandboxEvents({
      routes,
      request: new Request('https://app.test/v1/agents/ws/chat/completions'),
      payload: { workspaceId: 'ws-1', threadId: 'thread-1', content: 'do work' },
      signal: abort.signal,
    })

    await expect(stream.next()).resolves.toMatchObject({ done: false })
    abort.abort()
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })

    expect(routeSignal?.aborted).toBe(false)
    expect(bodyCancelled).toBe(true)
  })

  it('rejects malformed nested usage instead of silently dropping it', async () => {
    const routes = {
      turn: vi.fn(async () => responseFromChunks([
        '{"type":"usage","data":{"usage":"not-an-object"}}\n',
      ])),
    } as unknown as ChatTurnRoutes

    const stream = streamChatRouteAsSandboxEvents({
      routes,
      request: new Request('https://app.test/v1/agents/ws/chat/completions'),
      payload: { workspaceId: 'ws-1', threadId: 'thread-1', content: 'do work' },
    })

    await expect(stream.next()).rejects.toThrow('invalid data.usage')
  })
})
