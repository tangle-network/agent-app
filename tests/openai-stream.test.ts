import { describe, it, expect } from 'vitest'
import { toLoopEvents, createOpenAICompatStreamTurn, type OpenAIStreamChunk } from '../src/runtime/openai-stream'
import type { LoopEvent } from '../src/runtime/index'

async function* chunks(...cs: OpenAIStreamChunk[]): AsyncIterable<OpenAIStreamChunk> {
  for (const c of cs) yield c
}
async function collect(it: AsyncIterable<LoopEvent>): Promise<LoopEvent[]> {
  const out: LoopEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

describe('toLoopEvents', () => {
  it('emits content deltas as text events in order', async () => {
    const evs = await collect(
      toLoopEvents(chunks({ choices: [{ delta: { content: 'Hel' } }] }, { choices: [{ delta: { content: 'lo' } }] })),
    )
    expect(evs).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
    ])
  })

  it('assembles a tool call fragmented across chunks (name first, args streamed) into one event', async () => {
    const evs = await collect(
      toLoopEvents(
        chunks(
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'submit_proposal' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"type":"reco' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'mmend","title":"X"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ),
      ),
    )
    expect(evs).toEqual([
      { type: 'tool_call', call: { toolCallId: 'call_1', toolName: 'submit_proposal', args: { type: 'recommend', title: 'X' } } },
    ])
  })

  it('interleaves text then tool calls; multiple calls by index; garbled args → {} (never throws)', async () => {
    const evs = await collect(
      toLoopEvents(
        chunks(
          { choices: [{ delta: { content: 'ok ' } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'schedule_followup', arguments: 'not json' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'render_ui', arguments: '{"title":"v"}' } }] } }] },
        ),
      ),
    )
    expect(evs[0]).toEqual({ type: 'text', text: 'ok ' })
    expect(evs[1]).toEqual({ type: 'tool_call', call: { toolCallId: 'a', toolName: 'schedule_followup', args: {} } })
    expect(evs[2]).toEqual({ type: 'tool_call', call: { toolCallId: 'b', toolName: 'render_ui', args: { title: 'v' } } })
  })
})

describe('createOpenAICompatStreamTurn', () => {
  function sseResponse(...frames: string[]): Response {
    const body = frames.map((f) => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close() } }), {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  it('POSTs to <baseUrl>/chat/completions with bearer + tools and yields parsed LoopEvents', async () => {
    const seen: { url: string; init: RequestInit } = { url: '', init: {} }
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.url = String(url); seen.init = init ?? {}
      return sseResponse(
        JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'submit_proposal', arguments: '{"type":"research","title":"t"}' } }] } }] }),
      )
    }) as unknown as typeof fetch
    const streamTurn = createOpenAICompatStreamTurn({ baseUrl: 'https://router.tangle.tools/v1/', apiKey: 'sk-tan-x', model: 'deepseek/deepseek-chat', tools: [{ type: 'function', function: { name: 'submit_proposal' } }], fetchImpl })

    const evs = await collect(streamTurn([{ role: 'user', content: 'hi' }]))
    expect(seen.url).toBe('https://router.tangle.tools/v1/chat/completions')
    expect((seen.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-tan-x')
    const body = JSON.parse(String(seen.init.body))
    expect(body).toMatchObject({ model: 'deepseek/deepseek-chat', stream: true })
    expect(body.tools).toHaveLength(1)
    expect(evs).toEqual([
      { type: 'text', text: 'Hi' },
      { type: 'tool_call', call: { toolCallId: 'c1', toolName: 'submit_proposal', args: { type: 'research', title: 't' } } },
    ])
  })

  it('throws loud on a non-2xx model response', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    const streamTurn = createOpenAICompatStreamTurn({ baseUrl: 'https://r', apiKey: 'k', model: 'm', fetchImpl })
    await expect(collect(streamTurn([{ role: 'user', content: 'x' }]))).rejects.toThrow(/HTTP 500/)
  })
})
