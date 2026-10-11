import { describe, expect, it, vi } from 'vitest'
import { createChatTurnRoutes, createRouterTurnProducer, type ChatTurnMessageStore } from '../../src/chat-routes/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'

/** One Router chat completion streamed as OpenAI server-sent events. */
function sse(chunks: unknown[]) {
  const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
const text = (value: string) => ({ model: 'served/model', choices: [{ delta: { content: value } }] })
const toolCall = (id: string, name: string, args: string) => ({ model: 'served/model',
  choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] }, finish_reason: 'tool_calls' }] })
const usage = (prompt: number, completion: number) => ({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion } })

function router(...responses: Response[]) {
  return vi.fn(async () => {
    const next = responses.shift()
    if (!next) throw new Error('unexpected model call')
    return next
  }) as unknown as typeof fetch
}

const lookup = {
  name: 'rooms.ready', description: 'Count ready rooms.',
  inputSchema: { type: 'object', properties: {} },
  run: async () => ({ ready: 4 }),
}

describe('createRouterTurnProducer', () => {
  it('streams wire events in order and projects the persisted parts and usage', async () => {
    const producer = createRouterTurnProducer({ apiKey: 'k', model: 'requested/model', systemPrompt: 's', userMessage: 'How many rooms?',
      tools: [lookup], fetchImpl: router(sse([toolCall('call-1', 'rooms_ready', '{}'), usage(900, 12)]),
        sse([text('Four rooms '), text('are ready.'), usage(950, 6)])) })
    const events: Array<{ type: string }> = []
    for await (const event of producer.stream) events.push(event as { type: string })
    expect(events.map(event => event.type)).toEqual(['usage', 'tool_call', 'tool_result', 'text', 'text', 'usage'])
    expect(producer.finalText()).toBe('Four rooms are ready.')
    expect(producer.assistantParts!()).toEqual([
      { type: 'tool', id: 'call-1', callID: 'call-1', tool: 'rooms.ready',
        state: { status: 'completed', input: {}, output: { ready: 4 }, time: { start: expect.any(Number), end: expect.any(Number) } } },
      { type: 'text', text: 'Four rooms are ready.' },
    ])
    expect(producer.usage!()).toEqual({ inputTokens: 1850, outputTokens: 18 })
    expect(producer.model).toBe('served/model')
    expect(producer.modelAttribution!()).toEqual({ requestedModel: 'requested/model', servedModel: 'served/model', echoReceived: true })
  })

  it('ends a failed turn with a typed error event instead of throwing', async () => {
    const down = () => new Response('upstream down', { status: 502 })
    const producer = createRouterTurnProducer({ apiKey: 'k', model: 'm', systemPrompt: 's', userMessage: 'u',
      fetchImpl: router(down(), down()) })
    const events: unknown[] = []
    for await (const event of producer.stream) events.push(event)
    expect(events).toEqual([{ type: 'error', data: { message: 'The model service did not answer.', code: 'model_http_502' } }])
    expect(producer.finalText()).toBe('')
  })

  it('runs behind the shared chat route: streams to the caller and persists the assistant row with its tool part', async () => {
    const rows: Array<{ role: string; content: string; parts?: unknown }> = []
    const store: ChatTurnMessageStore = {
      async listMessages() { return [] },
      async appendMessage(input) { rows.push(input as never); return { id: `m-${rows.length}` } },
    }
    const pending: Promise<unknown>[] = []
    const routes = createChatTurnRoutes<Record<string, never>>({
      projectId: 'router-producer',
      authorize: async () => ({ ok: true, tenantId: 'ws-1', userId: 'user-1', context: {} }),
      store,
      turnStore: createMemoryTurnEventStore(),
      incrementalPersistence: false,
      produce: ({ prompt }) => createRouterTurnProducer({ apiKey: 'k', model: 'm', systemPrompt: 's', userMessage: typeof prompt === 'string' ? prompt : '',
        tools: [lookup], fetchImpl: router(sse([toolCall('call-1', 'rooms_ready', '{}')]), sse([text('Four.')])) }),
      log: () => {},
    })
    const response = await routes.turn(new Request('http://app.test/api/chat', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: 't-1', content: 'How many rooms?' }) }),
    { waitUntil: (p: Promise<unknown>) => { pending.push(p) } })
    const body = await response.text()
    await Promise.all(pending)
    expect(response.status).toBe(200)
    expect(body).toContain('Four.')
    const assistant = rows.find(row => row.role === 'assistant')
    expect(assistant?.content).toBe('Four.')
    expect(JSON.stringify(assistant?.parts)).toContain('rooms.ready')
  })
})
