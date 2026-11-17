/** `toolRoundEffort` replayed through the real Router turn and Responses adapter over loopback HTTP. */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { runRouterTurn } from '../src/runtime/router-turn'
import { createTurnTrace } from '../src/turn-trace/index'

const sse = (event: object) => `data: ${JSON.stringify(event)}\n\n`
const message = (id: string, text: string) => ({ id, type: 'message', content: [{ type: 'output_text', text }] })
const lookup = (id: string, query: string) => ({ id: `fc_${id}`, type: 'function_call', call_id: id, name: 'lookup', arguments: JSON.stringify({ query }) })
const completed = (output: object[]) => sse({ type: 'response.completed', response: { status: 'completed', output,
  usage: { input_tokens: 100, output_tokens: 20, output_tokens_details: { reasoning_tokens: 10 } } } })

it('chooses tools at the lower effort after a tool round, and writes the answer once at the turn\'s effort', async () => {
  const requests: Array<{ effort: unknown; toolResults: number; wrote: string; closedEarly: boolean }> = []
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw) as { reasoning?: { effort?: string }; input: Array<{ type?: string }> }
    const effort = body.reasoning?.effort
    const row = { effort, toolResults: body.input.filter(item => item.type === 'function_call_output').length, wrote: '', closedEarly: false }
    requests.push(row)
    const closed = new Promise<void>(resolve => response.on('close', () => { row.closedEarly = !response.writableFinished; resolve() }))
    const text = (id: string, delta: string) => {
      row.wrote += delta
      response.write(sse({ type: 'response.output_text.delta', item_id: id, output_index: 0, content_index: 0, delta }))
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (row.toolResults === 0) {
      // The opening call: a sentence, then the first lookup.
      text('msg_open', 'Checking one source first.')
      response.end(completed([message('msg_open', 'Checking one source first.'), lookup('c1', 'first')]))
    } else if (row.toolResults === 1) {
      response.end(completed([lookup('c2', 'second'), lookup('c3', 'third')]))
    } else {
      // The answer: its first word, then a pause a long answer would have; a call dropped here closes the connection.
      text('msg_answer', `${effort}: `)
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 1_000))])
      if (response.destroyed) return
      text('msg_answer', 'the answer.')
      response.end(completed([message('msg_answer', `${effort}: the answer.`)]))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const trace = createTurnTrace({ executionId: 'tool-round-effort-fixture' })
    let streamed = ''
    const outcome = await runRouterTurn({ apiKey: 'local-integration-only', model: 'gpt-6-luna', trace,
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, systemPrompt: 's', userMessage: 'Compare two options',
      reasoningEffort: 'medium', toolRoundEffort: 'low',
      onEvent: event => { if (event.type === 'text') streamed += event.delta },
      tools: [{ name: 'lookup', description: 'Look something up', effect: 'lookup', run: async () => 'found',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }] })

    // Per request: its reasoning effort, the tool results it carried, the words the model wrote, and whether the turn
    // closed it before the model finished.
    expect(requests).toEqual([
      { effort: 'medium', toolResults: 0, wrote: 'Checking one source first.', closedEarly: false },
      { effort: 'low', toolResults: 1, wrote: '', closedEarly: false },
      { effort: 'low', toolResults: 3, wrote: 'low: ', closedEarly: true },
      { effort: 'medium', toolResults: 3, wrote: 'medium: the answer.', closedEarly: false },
    ])
    expect(requests.filter(row => row.toolResults === 3 && !row.closedEarly)).toHaveLength(1)
    expect(outcome.failure).toBeUndefined()
    expect(outcome.answer).toBe('medium: the answer.')
    expect(streamed).toBe('Checking one source first.medium: the answer.')
    expect(trace.finish().spans.filter(span => span.name === 'model.call').map(span => span.attrs.cancelled ?? false))
      .toEqual([false, false, true, false])
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
