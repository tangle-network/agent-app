/** `answerByMs` through the real Router turn and each model adapter over loopback HTTP: research ends at the time. */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { runRouterTurn } from '../src/runtime/router-turn'
import { createTurnTrace } from '../src/turn-trace/index'

const sse = (event: object) => `data: ${JSON.stringify(event)}\n\n`
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
type RequestBody = { tool_choice?: unknown; input?: Array<{ type?: string }>; messages?: Array<{ role?: string }> }

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

/**
 * A model that never stops researching: every call that may choose a tool looks one more thing up, and only a call sent
 * with `tool_choice: "none"` writes the answer. `stallAt` names the call (by the tool results it carries) that thinks
 * for 3 s before choosing its tool; `slowTool` names the lookup that runs 600 ms.
 */
async function researchForever(api: keyof typeof wires, scenario: { stallAt?: number; slowTool?: string }) {
  const wire = wires[api]
  const requests: Array<{ toolChoice: unknown; toolResults: number; wrote: string; closedEarly: boolean; at: number }> = []
  const started = Date.now()
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw) as RequestBody
    const row = { toolChoice: body.tool_choice, toolResults: wire.toolResults(body), wrote: '', closedEarly: false, at: Date.now() - started }
    requests.push(row)
    const closed = new Promise<void>(resolve => response.on('close', () => { row.closedEarly = !response.writableFinished; resolve() }))
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.flushHeaders()
    if (row.toolChoice === 'none') {
      row.wrote = 'the answer.'
      response.write(wire.text(row.wrote))
      response.end(wire.end(row.wrote))
      return
    }
    if (row.toolResults === 0) {
      row.wrote = 'Checking one source first.'
      response.write(wire.text(row.wrote))
    }
    if (row.toolResults === scenario.stallAt) {
      await Promise.race([closed, sleep(3_000)])
      if (response.destroyed) return
    }
    response.end(wire.end(row.wrote, `q${row.toolResults + 1}`))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const trace = createTurnTrace({ executionId: 'answer-by-fixture' })
    const outcome = await runRouterTurn({ apiKey: 'local-integration-only', model: 'gpt-6-luna', api, trace,
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, systemPrompt: 's', userMessage: 'Design it',
      reasoningEffort: 'low', answerByMs: 300, budgetMs: 1_500,
      tools: [{ name: 'lookup', description: 'Look something up', effect: 'lookup',
        run: async args => { if (args.query === scenario.slowTool) await sleep(600); return `found ${String(args.query)}` },
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }] })
    return { outcome, requests, elapsed: Date.now() - started, spans: trace.finish().spans }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

for (const api of ['responses', 'chat'] as const) {
  it(`over ${api}, a tool that runs past answerByMs is the last: the next call writes the answer from the results so far`, async () => {
    const { outcome, requests, spans } = await researchForever(api, { slowTool: 'q2' })

    // Two rounds before the time; the lookup q2 ends after it, so the next call may not choose a tool and the turn ends.
    expect(requests.map(({ toolChoice, toolResults, wrote, closedEarly }) => ({ toolChoice, toolResults, wrote, closedEarly }))).toEqual([
      { toolChoice: undefined, toolResults: 0, wrote: 'Checking one source first.', closedEarly: false },
      { toolChoice: undefined, toolResults: 1, wrote: '', closedEarly: false },
      { toolChoice: 'none', toolResults: 2, wrote: 'the answer.', closedEarly: false },
    ])
    expect(outcome.failure).toBeUndefined()
    expect(outcome.continuation).toBeUndefined()
    expect(outcome.answer).toBe('the answer.')
    expect(outcome.toolCalls.map(call => call.ok)).toEqual([true, true])
    const fired = spans.filter(span => span.name === 'turn.answer_by')
    expect(fired.map(span => span.attrs['tangle.turn.answer_by'])).toEqual(['round'])
    expect(Number(fired[0]!.attrs['tangle.turn.answer_by_ms'])).toBeGreaterThanOrEqual(300)
  })

  it(`over ${api}, a call still choosing tools at answerByMs is cut then, and the answer is written in its place`, async () => {
    const { outcome, requests, elapsed, spans } = await researchForever(api, { stallAt: 1 })

    // The second call thinks for 3 s; at 300 ms the turn closes it and sends the answer call with the one result it has.
    expect(requests.map(({ toolChoice, toolResults, wrote, closedEarly }) => ({ toolChoice, toolResults, wrote, closedEarly }))).toEqual([
      { toolChoice: undefined, toolResults: 0, wrote: 'Checking one source first.', closedEarly: false },
      { toolChoice: undefined, toolResults: 1, wrote: '', closedEarly: true },
      { toolChoice: 'none', toolResults: 1, wrote: 'the answer.', closedEarly: false },
    ])
    expect(requests[2]!.at).toBeGreaterThanOrEqual(300)
    expect(elapsed).toBeLessThan(1_500)
    expect(outcome.failure).toBeUndefined()
    expect(outcome.answer).toBe('the answer.')
    expect(outcome.toolCalls).toHaveLength(1)
    expect(spans.filter(span => span.name === 'model.call').map(span => span.attrs.cancelled ?? false)).toEqual([false, true, false])
    expect(spans.filter(span => span.name === 'turn.answer_by').map(span => span.attrs['tangle.turn.answer_by'])).toEqual(['cut'])
  })
}
