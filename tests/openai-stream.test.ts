import { describe, it, expect } from 'vitest'
import { toLoopEvents, createOpenAICompatStreamTurn, type OpenAIStreamChunk, type OpenAICompatServedModel } from '../src/runtime/openai-stream'
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

  it('emits reasoning deltas (reasoning_content or thinking) as reasoning events', async () => {
    const evs = await collect(
      toLoopEvents(
        chunks(
          { choices: [{ delta: { reasoning_content: 'hmm ' } }] },
          { choices: [{ delta: { thinking: 'ok' } }] },
          { choices: [{ delta: { content: 'answer' } }] },
        ),
      ),
    )
    expect(evs).toEqual([
      { type: 'reasoning', text: 'hmm ' },
      { type: 'reasoning', text: 'ok' },
      { type: 'text', text: 'answer' },
    ])
  })

  it('emits the final-chunk usage (empty choices) as a usage event', async () => {
    const evs = await collect(
      toLoopEvents(
        chunks(
          { choices: [{ delta: { content: 'hi' } }] },
          { choices: [], usage: { prompt_tokens: 12, completion_tokens: 34 } },
        ),
      ),
    )
    expect(evs).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'usage', usage: { promptTokens: 12, completionTokens: 34 } },
    ])
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

  it('forwards assistant.tool_calls + role:tool messages verbatim into the request body', async () => {
    const seen: { init: RequestInit } = { init: {} }
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.init = init ?? {}
      return sseResponse(JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }))
    }) as unknown as typeof fetch
    const streamTurn = createOpenAICompatStreamTurn({ baseUrl: 'https://r', apiKey: 'k', model: 'm', fetchImpl })
    await collect(streamTurn([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'submit_proposal', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'submit_proposal → ok: {}' },
    ]))
    const body = JSON.parse(String(seen.init.body))
    expect(body.messages[1]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'submit_proposal', arguments: '{}' } }] })
    expect(body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'submit_proposal → ok: {}' })
  })

  it('throws loud on a non-2xx model response', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    const streamTurn = createOpenAICompatStreamTurn({ baseUrl: 'https://r', apiKey: 'k', model: 'm', fetchImpl })
    await expect(collect(streamTurn([{ role: 'user', content: 'x' }]))).rejects.toThrow(/HTTP 500/)
  })
})

/**
 * The router substitutes models deliberately — a quota-walled primary comes
 * back 200 answered by something else — and announces it in response headers.
 * This lane dropped the whole `Response` after taking `.body`, so the caller
 * recorded the model it ASKED for. Measured against production 2026-07-27:
 * `claude-sonnet-4-6` requested, `openai/gpt-5` served.
 */
describe('createOpenAICompatStreamTurn — served-model attribution', () => {
  function sseResponse(headers: Record<string, string>, ...frames: string[]): Response {
    const body = frames.map((f) => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close() } }), {
      status: 200, headers: { 'Content-Type': 'text/event-stream', ...headers },
    })
  }
  /** One turn: fake fetch returning `res`, collect the served-model reports. */
  async function run(model: string, res: () => Response) {
    const seen: OpenAICompatServedModel[] = []
    const streamTurn = createOpenAICompatStreamTurn({
      baseUrl: 'https://router.tangle.tools/v1', apiKey: 'k', model,
      fetchImpl: (async () => res()) as unknown as typeof fetch,
      onServedModel: (s) => { seen.push(s) },
    })
    await collect(streamTurn([{ role: 'user', content: 'hi' }]))
    return seen
  }
  const textFrame = JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })

  it('reports the substitute named by x-tangle-served-model, with the failover reason', async () => {
    const seen = await run('claude-sonnet-4-6', () => sseResponse({
      'x-tangle-served-model': 'openai/gpt-5',
      'x-tangle-failover': 'from=claude-sonnet-4-6; to=openai/gpt-5; trigger=provider_quota_exhausted; degraded=false',
    }, textFrame))
    expect(seen).toEqual([{
      requestedModel: 'claude-sonnet-4-6',
      servedModel: 'openai/gpt-5',
      source: 'router_header',
      substituted: true,
      trigger: 'provider_quota_exhausted',
      degraded: false,
    }])
  })

  it('omits trigger/degraded when the router did not inject the substitute (no failover header)', async () => {
    // A caller-supplied fallback chain sets served-model WITHOUT x-tangle-failover.
    const seen = await run('claude-sonnet-4-6', () => sseResponse({ 'x-tangle-served-model': 'openai/gpt-5' }, textFrame))
    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toHaveProperty('trigger')
    expect(seen[0]).not.toHaveProperty('degraded')
    expect(seen[0]?.substituted).toBe(true)
  })

  it('survives a garbled failover header rather than failing the turn', async () => {
    const seen = await run('claude-sonnet-4-6', () => sseResponse({
      'x-tangle-served-model': 'openai/gpt-5', 'x-tangle-failover': 'nonsense-without-any-equals',
    }, textFrame))
    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toHaveProperty('trigger')
  })

  it('falls back to the body model when the header is absent (the CORS-stripped browser case)', async () => {
    const seen = await run('claude-sonnet-4-6', () => sseResponse({}, JSON.stringify({ model: 'gpt-5-2025-08-07', choices: [{ delta: { content: 'hi' } }] })))
    expect(seen).toEqual([{
      requestedModel: 'claude-sonnet-4-6',
      servedModel: 'gpt-5-2025-08-07',
      source: 'response_body',
      substituted: true,
    }])
  })

  it('does NOT call a dated body model a substitution — ids are folded, not compared raw', async () => {
    // The router answers `openai/gpt-5` with `model: gpt-5-2025-08-07` on every
    // turn, substituted or not. A raw `!==` here reports a swap every time.
    const seen = await run('openai/gpt-5', () => sseResponse({}, JSON.stringify({ model: 'gpt-5-2025-08-07', choices: [{ delta: { content: 'hi' } }] })))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.substituted).toBe(false)
    expect(seen[0]?.servedModel).toBe('gpt-5-2025-08-07')
  })

  it('prefers the header over the body and reports exactly once', async () => {
    const seen = await run('claude-sonnet-4-6', () => sseResponse(
      { 'x-tangle-served-model': 'openai/gpt-5' },
      JSON.stringify({ model: 'gpt-5-2025-08-07', choices: [{ delta: { content: 'a' } }] }),
      JSON.stringify({ model: 'gpt-5-2025-08-07', choices: [{ delta: { content: 'b' } }] }),
    ))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.source).toBe('router_header')
    expect(seen[0]?.servedModel).toBe('openai/gpt-5')
  })

  it('stays silent when neither header nor body names a model — silence is "learned nothing"', async () => {
    const seen = await run('claude-sonnet-4-6', () => sseResponse({}, textFrame))
    expect(seen).toEqual([])
  })

  it('reports once per TURN, so a multi-turn tool loop gets one report per turn', async () => {
    const seen: OpenAICompatServedModel[] = []
    const streamTurn = createOpenAICompatStreamTurn({
      baseUrl: 'https://r', apiKey: 'k', model: 'claude-sonnet-4-6',
      fetchImpl: (async () => sseResponse({ 'x-tangle-served-model': 'openai/gpt-5' }, textFrame)) as unknown as typeof fetch,
      onServedModel: (s) => { seen.push(s) },
    })
    await collect(streamTurn([{ role: 'user', content: 'one' }]))
    await collect(streamTurn([{ role: 'user', content: 'two' }]))
    expect(seen).toHaveLength(2)
  })
})
