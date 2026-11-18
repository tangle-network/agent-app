/** `toolRoundEffort` replayed through the real Router turn and each model adapter over loopback HTTP. */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { runRouterTurn } from '../src/runtime/router-turn'
import { createTurnTrace } from '../src/turn-trace/index'

const sse = (event: object) => `data: ${JSON.stringify(event)}\n\n`
type Lookup = { id: string; query: string }
type RequestBody = {
  tools?: unknown[]; tool_choice?: unknown; reasoning?: { effort?: string }; reasoning_effort?: string
  input?: Array<{ type?: string }>; messages?: Array<{ role?: string }>
}

/** How each adapter's request carries its effort and tool results, and how its stream writes a word or ends a call. */
const wires = {
  responses: {
    effort: (body: RequestBody) => body.reasoning?.effort,
    toolResults: (body: RequestBody) => (body.input ?? []).filter(item => item.type === 'function_call_output').length,
    text: (delta: string) => sse({ type: 'response.output_text.delta', item_id: 'msg', output_index: 0, content_index: 0, delta }),
    end: (text: string, calls: Lookup[]) => sse({ type: 'response.completed', response: { status: 'completed',
      output: [
        ...(text ? [{ id: 'msg', type: 'message', content: [{ type: 'output_text', text }] }] : []),
        ...calls.map(call => ({ id: `fc_${call.id}`, type: 'function_call', call_id: call.id, name: 'lookup',
          arguments: JSON.stringify({ query: call.query }) })),
      ],
      usage: { input_tokens: 100, output_tokens: 20, output_tokens_details: { reasoning_tokens: 10 } } } }),
  },
  chat: {
    effort: (body: RequestBody) => body.reasoning_effort,
    toolResults: (body: RequestBody) => (body.messages ?? []).filter(message => message.role === 'tool').length,
    text: (delta: string) => sse({ choices: [{ index: 0, delta: { content: delta } }] }),
    end: (_text: string, calls: Lookup[]) => sse({ choices: [{ index: 0,
      delta: { tool_calls: calls.map((call, index) => ({ index, id: call.id,
        function: { name: 'lookup', arguments: JSON.stringify({ query: call.query }) } })) },
      finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }),
  },
}

for (const api of ['responses', 'chat'] as const) {
  it(`over ${api}, chooses tools at the lower effort and writes the answer once, at the turn's effort with tools off`, async () => {
    const wire = wires[api]
    const requests: Array<{ effort: unknown; toolChoice: unknown; tools: number; toolResults: number; wrote: string; closedEarly: boolean }> = []
    const server = createServer(async (request, response) => {
      let raw = ''
      for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw) as RequestBody
      const row = { effort: wire.effort(body), toolChoice: body.tool_choice, tools: body.tools?.length ?? 0,
        toolResults: wire.toolResults(body), wrote: '', closedEarly: false }
      requests.push(row)
      const closed = new Promise<void>(resolve => response.on('close', () => { row.closedEarly = !response.writableFinished; resolve() }))
      const text = (delta: string) => { row.wrote += delta; response.write(wire.text(delta)) }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (row.toolResults === 0) {
        // The opening call: a sentence, then the first lookup.
        text('Checking one source first.')
        response.end(wire.end('Checking one source first.', [{ id: 'c1', query: 'first' }]))
      } else if (row.toolResults === 1) {
        response.end(wire.end('', [{ id: 'c2', query: 'second' }, { id: 'c3', query: 'third' }]))
      } else if (row.effort === 'low') {
        // A lower-effort call that starts the answer: its first word, then a pause a long answer would have; a call
        // dropped here closes the connection.
        text('low: ')
        await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 1_000))])
        if (response.destroyed) return
        text('the answer.')
        response.end(wire.end('low: the answer.', []))
      } else if (row.toolChoice !== 'none' && row.toolResults === 3) {
        // Offered tools, the call sent to write the answer checks one more source instead.
        response.end(wire.end('', [{ id: 'c4', query: 'check' }]))
      } else {
        text(`${row.effort}: the answer.`)
        response.end(wire.end(`${row.effort}: the answer.`, []))
      }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const trace = createTurnTrace({ executionId: 'tool-round-effort-fixture' })
      let streamed = ''
      const outcome = await runRouterTurn({ apiKey: 'local-integration-only', model: 'gpt-6-luna', api, trace,
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, systemPrompt: 's', userMessage: 'Compare two options',
        reasoningEffort: 'medium', toolRoundEffort: 'low',
        onEvent: event => { if (event.type === 'text') streamed += event.delta },
        tools: [{ name: 'lookup', description: 'Look something up', effect: 'lookup', run: async () => 'found',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }] })

      // Per request: its reasoning effort, its tool_choice, the tools it listed, the tool results it carried, the words
      // the model wrote, and whether the turn closed it before the model finished. The call sent in place of the
      // cancelled one lists the same tools and may not call them, so it writes the answer and the turn ends there.
      expect(requests).toEqual([
        { effort: 'medium', toolChoice: undefined, tools: 1, toolResults: 0, wrote: 'Checking one source first.', closedEarly: false },
        { effort: 'low', toolChoice: undefined, tools: 1, toolResults: 1, wrote: '', closedEarly: false },
        { effort: 'low', toolChoice: undefined, tools: 1, toolResults: 3, wrote: 'low: ', closedEarly: true },
        { effort: 'medium', toolChoice: 'none', tools: 1, toolResults: 3, wrote: 'medium: the answer.', closedEarly: false },
      ])
      expect(requests.filter(row => row.toolResults > 0 && row.wrote && !row.closedEarly)).toHaveLength(1)
      expect(outcome.failure).toBeUndefined()
      expect(outcome.answer).toBe('medium: the answer.')
      expect(streamed).toBe('Checking one source first.medium: the answer.')
      expect(trace.finish().spans.filter(span => span.name === 'model.call').map(span => span.attrs.cancelled ?? false))
        .toEqual([false, false, true, false])
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
}
