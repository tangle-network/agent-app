/** `answerByMs` through the real Router turn and each model adapter over loopback HTTP: research ends at the time. */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { createRouterTurnProducer } from '../src/chat-routes/router-producer'
import { runRouterTurn, type RouterTurnOutcome } from '../src/runtime/router-turn'
import { createTurnTrace } from '../src/turn-trace/index'

const sse = (event: object) => `data: ${JSON.stringify(event)}\n\n`
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
type RequestBody = { tool_choice?: unknown; tools?: unknown[]; input?: Array<{ type?: string }>; messages?: Array<{ role?: string }> }

/** How each adapter's request carries its tool results, and how its stream writes a word or ends a call. */
const wires = {
  responses: {
    toolResults: (body: RequestBody) => (body.input ?? []).filter(item => item.type === 'function_call_output').length,
    text: (delta: string) => sse({ type: 'response.output_text.delta', item_id: 'msg', output_index: 0, content_index: 0, delta }),
    end: (text: string, call?: string) => sse({ type: 'response.completed', response: { status: 'completed',
      output: [
        ...(text ? [{ id: 'msg', type: 'message', content: [{ type: 'output_text', text }] }] : []),
        ...(call ? [{ id: `fc_${call}`, type: 'function_call', call_id: call, name: 'lookup', arguments: JSON.stringify({ query: call }) }] : []),
      ],
      usage: { input_tokens: 100, output_tokens: 20 } } }),
  },
  chat: {
    toolResults: (body: RequestBody) => (body.messages ?? []).filter(message => message.role === 'tool').length,
    text: (delta: string) => sse({ choices: [{ index: 0, delta: { content: delta } }] }),
    end: (_text: string, call?: string) => sse({ choices: [{ index: 0,
      delta: call ? { tool_calls: [{ index: 0, id: call, function: { name: 'lookup', arguments: JSON.stringify({ query: call }) } }] } : {},
      finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }),
  },
}

type Scenario = {
  /** The lookup that runs 600 ms. */
  slowTool?: string
  /** The second call thinks for 3 s: after its response headers (`body`) or before them (`headers`). */
  stall?: 'body' | 'headers'
  /** The second call writes a sentence, then chooses its tool 500 ms later. */
  narrate?: boolean
  /** Run the turn through the chat producer, which keeps the message parts a member's transcript stores. */
  producer?: boolean
  /** Like Z.AI's GLM: a call sent with `tool_choice: "none"` still chooses a tool; only a call with no tools listed writes. */
  ignoresToolChoice?: boolean
  /** The answer call writes a word every 50 ms and never ends (a tool-less GLM call wrote for 12 minutes, 2026-11-22). */
  endlessAnswer?: boolean
}

/**
 * A model that never stops researching: every call that may choose a tool looks one more thing up, and only a call sent
 * with `tool_choice: "none"` writes the answer. The turn's answerByMs is 300 ms and its budget 1.5 s.
 */
async function researchForever(api: keyof typeof wires, scenario: Scenario) {
  const wire = wires[api]
  const requests: Array<{ toolChoice: unknown; listsTools: boolean; toolResults: number; wrote: string; closedEarly: boolean; at: number }> = []
  const ran: string[] = []
  const started = Date.now()
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw) as RequestBody
    const row = { toolChoice: body.tool_choice, listsTools: (body.tools ?? []).length > 0, toolResults: wire.toolResults(body), wrote: '',
      closedEarly: false, at: Date.now() - started }
    requests.push(row)
    const closed = new Promise<void>(resolve => response.on('close', () => { row.closedEarly = !response.writableFinished; resolve() }))
    const text = (delta: string) => { row.wrote += delta; response.write(wire.text(delta)) }
    const second = row.toolChoice !== 'none' && row.toolResults === 1
    if (second && scenario.stall === 'headers') {
      await Promise.race([closed, sleep(3_000)])
      if (response.destroyed) return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.flushHeaders()
    if (row.toolChoice === 'none' || !row.listsTools) {
      if (scenario.ignoresToolChoice && row.listsTools) {
        response.end(wire.end('', `late${row.toolResults}`))
        return
      }
      if (scenario.endlessAnswer) {
        while (!response.destroyed && !response.writableEnded) { text('Reading. '); await Promise.race([closed, sleep(50)]) }
        return
      }
      text('the answer.')
      response.end(wire.end(row.wrote))
      return
    }
    if (row.toolResults === 0) text('Checking one source first.')
    if (second && scenario.narrate) {
      text('Let me check one more source.')
      await sleep(500)
    }
    if (second && scenario.stall === 'body') {
      await Promise.race([closed, sleep(3_000)])
      if (response.destroyed) return
    }
    response.end(wire.end(row.wrote, `q${row.toolResults + 1}`))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const trace = createTurnTrace({ executionId: 'answer-by-fixture' })
    const options = { apiKey: 'local-integration-only', model: 'gpt-6-luna', api, trace,
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, systemPrompt: 's', userMessage: 'Design it',
      reasoningEffort: 'low', answerByMs: 300, budgetMs: 1_500,
      tools: [{ name: 'lookup', description: 'Look something up', effect: 'lookup' as const,
        run: async (args: Record<string, unknown>) => {
          ran.push(String(args.query))
          if (args.query === scenario.slowTool) await sleep(600)
          return `found ${String(args.query)}`
        },
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }] }
    let outcome: RouterTurnOutcome | undefined
    let parts: Array<Record<string, unknown>> = []
    if (scenario.producer) {
      const producer = createRouterTurnProducer({ ...options, onOutcome: result => { outcome = result } })
      for await (const _event of producer.stream) { /* drained: the member's stream */ }
      parts = producer.assistantParts?.() ?? []
    } else outcome = await runRouterTurn(options)
    return { outcome: outcome!, parts, requests, ran, elapsed: Date.now() - started, spans: trace.finish().spans }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

const rows = (requests: Awaited<ReturnType<typeof researchForever>>['requests']) =>
  requests.map(({ toolChoice, toolResults, wrote, closedEarly }) => ({ toolChoice, toolResults, wrote, closedEarly }))
const firedAs = (spans: Awaited<ReturnType<typeof researchForever>>['spans']) =>
  spans.filter(span => span.name === 'turn.answer_by').map(span => span.attrs['tangle.turn.answer_by'])

for (const api of ['responses', 'chat'] as const) {
  it(`over ${api}, a tool that runs past answerByMs is the last: the next call writes the answer from the results so far`, async () => {
    const { outcome, requests, spans } = await researchForever(api, { slowTool: 'q2' })

    // Two rounds before the time; the lookup q2 ends after it, so the next call may not choose a tool and the turn ends.
    expect(rows(requests)).toEqual([
      { toolChoice: undefined, toolResults: 0, wrote: 'Checking one source first.', closedEarly: false },
      { toolChoice: undefined, toolResults: 1, wrote: '', closedEarly: false },
      { toolChoice: 'none', toolResults: 2, wrote: 'the answer.', closedEarly: false },
    ])
    expect(outcome.failure).toBeUndefined()
    expect(outcome.continuation).toBeUndefined()
    expect(outcome.answer).toBe('the answer.')
    expect(outcome.toolCalls.map(call => call.ok)).toEqual([true, true])
    expect(firedAs(spans)).toEqual(['round'])
    expect(Number(spans.find(span => span.name === 'turn.answer_by')!.attrs['tangle.turn.answer_by_ms'])).toBeGreaterThanOrEqual(300)
  })

  for (const stall of ['body', 'headers'] as const) {
    const when = stall === 'headers' ? 'before its response arrives' : 'mid-stream'
    it(`over ${api}, a call still choosing tools at answerByMs is aborted then, ${when}, and the answer replaces it`, async () => {
      const { outcome, requests, elapsed, spans } = await researchForever(api, { stall })

      // The second call thinks for 3 s; at 300 ms the turn aborts it and sends the answer call with the one result it has.
      expect(rows(requests)).toEqual([
        { toolChoice: undefined, toolResults: 0, wrote: 'Checking one source first.', closedEarly: false },
        { toolChoice: undefined, toolResults: 1, wrote: '', closedEarly: true },
        { toolChoice: 'none', toolResults: 1, wrote: 'the answer.', closedEarly: false },
      ])
      expect(requests[2]!.at).toBeGreaterThanOrEqual(300)
      expect(elapsed).toBeLessThan(1_500)
      expect(outcome.failure).toBeUndefined()
      expect(outcome.answer).toBe('the answer.')
      expect(outcome.toolCalls).toHaveLength(1)
      // The aborted call is cancelled, not failed.
      const calls = spans.filter(span => span.name === 'model.call')
      expect(calls.map(span => [span.attrs.cancelled ?? false, span.error ?? null])).toEqual([[false, null], [true, null], [false, null]])
      expect(firedAs(spans)).toEqual(['cut'])
    })
  }

  it(`over ${api}, a sentence written before tool calls that arrive after answerByMs is narration: the transcript keeps one answer`, async () => {
    const { outcome, parts, requests, spans } = await researchForever(api, { narrate: true, producer: true })

    // The second call writes a sentence before the time and chooses its tool after it: the tool never runs, and the
    // answer call is sent with the one result so far.
    expect(rows(requests)).toEqual([
      { toolChoice: undefined, toolResults: 0, wrote: 'Checking one source first.', closedEarly: false },
      { toolChoice: undefined, toolResults: 1, wrote: 'Let me check one more source.', closedEarly: false },
      { toolChoice: 'none', toolResults: 1, wrote: 'the answer.', closedEarly: false },
    ])
    expect(outcome.failure).toBeUndefined()
    expect(outcome.toolCalls).toHaveLength(1)
    expect(outcome.answer).toBe('the answer.')
    expect(outcome.text).toBe('Checking one source first.\n\nLet me check one more source.\n\nthe answer.')
    // What a member's transcript stores: both sentences as reasoning, one lookup, and the answer once.
    expect(parts.map(part => [part.type, part.type === 'tool' ? part.tool : part.text])).toEqual([
      ['reasoning', 'Checking one source first.'],
      ['tool', 'lookup'],
      ['reasoning', 'Let me check one more source.'],
      ['text', 'the answer.'],
    ])
    expect(firedAs(spans)).toEqual(['calls'])
  })

  it(`over ${api}, tool calls a model sends on the answer call never run: the call is sent again with no tools listed`, async () => {
    const { outcome, requests, ran, spans } = await researchForever(api, { slowTool: 'q2', ignoresToolChoice: true })

    // The answer call chooses a tool anyway, as Z.AI's GLM does; the tool never runs, and the bare resend writes.
    expect(requests.map(({ toolChoice, listsTools, toolResults, wrote }) => ({ toolChoice, listsTools, toolResults, wrote }))).toEqual([
      { toolChoice: undefined, listsTools: true, toolResults: 0, wrote: 'Checking one source first.' },
      { toolChoice: undefined, listsTools: true, toolResults: 1, wrote: '' },
      { toolChoice: 'none', listsTools: true, toolResults: 2, wrote: '' },
      { toolChoice: undefined, listsTools: false, toolResults: 2, wrote: 'the answer.' },
    ])
    expect(ran).toEqual(['q1', 'q2'])
    expect(outcome.failure).toBeUndefined()
    expect(outcome.answer).toBe('the answer.')
    expect(outcome.toolCalls).toHaveLength(2)
    expect(spans.filter(span => span.name === 'turn.answer_call').map(span => span.attrs['tangle.turn.answer_call'])).toEqual(['tools_dropped'])
  })

  it(`over ${api}, an answer call that never stops writing ends at budgetMs and the turn keeps what it wrote`, async () => {
    const { outcome, requests, elapsed, spans } = await researchForever(api, { slowTool: 'q2', endlessAnswer: true })

    expect(requests.at(-1)).toMatchObject({ toolChoice: 'none', toolResults: 2, closedEarly: true })
    expect(elapsed).toBeLessThan(1_500 + 1_000)
    expect(outcome.failure).toBeUndefined()
    expect(outcome.answer).toMatch(/^(Reading\. ?)+$/)
    expect(spans.filter(span => span.name === 'turn.answer_call').map(span => span.attrs['tangle.turn.answer_call'])).toEqual(['budget'])
  })
}
