/** Real Node HTTP streams through the production fetch/SSE/LoopEvent adapters. */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { isDeepStrictEqual } from 'node:util'
import { expect, it } from 'vitest'
import type { LoopToolCall } from '../src/runtime/loop'
import { createOpenAICompatStreamTurn, createOpenAIResponsesTurn } from '../src/runtime/openai-stream'

it('preserves fragmented UTF-8, tool arguments, usage and per-request reasoning summaries over HTTP', async () => {
  const requests: Array<{ path: string; body: Record<string, unknown>; authorization?: string }> = []
  const chat = [
    { choices: [{ delta: { content: 'Café ' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'lookup', arguments: '{"q":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"lease"}' } }] } }] },
    { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } },
  ]
  const responses = [
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'First' },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 1, delta: 'Second' },
    { type: 'response.output_text.delta', delta: 'Café ' },
    { type: 'response.completed', response: { usage: { input_tokens: 7, output_tokens: 3 } } },
  ]
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ path: request.url!, body: JSON.parse(body), authorization: request.headers.authorization })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    // Deliberately divide writes inside JSON and the UTF-8 encoding of é.
    const events = request.url === '/v1/responses' ? responses : chat
    const bytes = Buffer.from(': keepalive\r\n\r\n' + events.map(event => 'data: ' + JSON.stringify(event) + '\r\n\r\n').join('') + 'data: [DONE]\r\n\r\n')
    for (const byte of bytes) response.write(Buffer.from([byte]))
    response.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const options = { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: 'local-integration-only', model: 'fixture-model' }
    const messages = [{ role: 'user' as const, content: 'Find the lease' }]
    const chatEvents = []
    for await (const event of createOpenAICompatStreamTurn(options)(messages)) chatEvents.push(event)
    expect(chatEvents).toEqual([
      { type: 'text', text: 'Café ' },
      { type: 'tool_call_start', toolCallId: 'call-1', toolName: 'lookup' },
      { type: 'usage', usage: { promptTokens: 7, completionTokens: 3 } },
      { type: 'tool_call', call: { toolCallId: 'call-1', toolName: 'lookup', args: { q: 'lease' } } },
    ])
    const stream = createOpenAIResponsesTurn(options)
    // Reusing the adapter must not carry the last summary index into another request.
    for (let attempt = 0; attempt < 2; attempt++) {
      const events = []
      for await (const event of stream(messages)) events.push(event)
      expect(events).toEqual([
        { type: 'reasoning', text: 'First' }, { type: 'reasoning', text: '\n\nSecond' },
        { type: 'text', text: 'Café ' }, { type: 'usage', usage: { promptTokens: 7, completionTokens: 3 } },
      ])
    }
    expect(requests.map(request => request.path)).toEqual(['/v1/chat/completions', '/v1/responses', '/v1/responses'])
    expect(requests.every(request => request.authorization === 'Bearer local-integration-only' && request.body.stream === true)).toBe(true)
    expect(requests[0]!.body.messages).toEqual(messages)
    expect(requests[1]!.body.input).toEqual(messages)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

it('gives every parallel Responses function call its final arguments, however the stream carries them', async () => {
  // A recorded stream of three parallel function calls, with neutral ids and queries.
  const capture = readFileSync(new URL('./fixtures/responses-parallel-function-calls.sse', import.meta.url), 'utf8')
  type Frame = Record<string, any>
  const events: Frame[] = capture.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
  const [created, inProgress] = [events[0]!, events[1]!]
  const completed = events.at(-1)!
  const final: Array<{ call_id: string; name: string; arguments: string }> = completed.response.output
  const of = (type: string) => events.filter(event => event.type === type)
  const isDelta = (event: Frame) => event.type === 'response.function_call_arguments.delta'
  const halves = of('response.function_call_arguments.delta').flatMap(event => [0, 1].map(half =>
    ({ ...event, delta: half ? event.delta.slice(event.delta.length >> 1) : event.delta.slice(0, event.delta.length >> 1) })))
  const reasoning = { id: 'rs_fixture1', type: 'reasoning', summary: [] }
  const shift = (event: Frame) => event.output_index === undefined ? event : { ...event, output_index: event.output_index + 1 }
  const replays: Record<string, string | Frame[]> = {
    a_capture: capture,
    b_done_events_only: events.filter(event => !isDelta(event)),
    c_deltas_without_output_index: events.map(({ output_index, ...event }) => isDelta(event) ? event : { ...event, output_index }),
    d_interleaved: [created, inProgress, ...of('response.output_item.added'), ...[0, 2, 4, 1, 3, 5].map(i => halves[i]!),
      ...events.filter(event => event.type === 'response.function_call_arguments.done' || event.type === 'response.output_item.done'), completed],
    e_reasoning_item_first: [created, inProgress, { type: 'response.output_item.added', output_index: 0, item: reasoning },
      { type: 'response.output_item.done', output_index: 0, item: reasoning }, ...events.slice(2, -1).map(shift),
      { ...completed, response: { ...completed.response, output: [reasoning, ...final] } }],
    // A proxy replaying a finished response: whole items, no argument events, `response.done`.
    f_replayed_final_response: [created, ...final.flatMap((item, output_index) => [
      { type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress' } },
      { type: 'response.output_item.done', output_index, item }]), { type: 'response.done', response: completed.response }],
  }
  const server = createServer((request, response) => {
    request.resume().on('end', () => {
      const replay = replays[request.url!.split('/')[1]!]!
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(typeof replay === 'string' ? replay : replay.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const table: Record<string, { calls: number; wrong: number; args: unknown[] }> = {}
    for (const name of Object.keys(replays)) {
      const turn = createOpenAIResponsesTurn({ baseUrl: `${origin}/${name}/v1`, apiKey: 'local-integration-only', model: 'fixture-model' })
      const calls: LoopToolCall[] = []
      for await (const event of turn([{ role: 'user', content: 'Search three things at once' }])) if (event.type === 'tool_call') calls.push(event.call)
      const wrong = final.filter(want => !calls.some(call => call.toolCallId === want.call_id && call.toolName === want.name &&
        isDeepStrictEqual(call.args, JSON.parse(want.arguments)))).length
      table[name] = { calls: calls.length, wrong, args: calls.map(call => call.args) }
    }
    const exact = { calls: 3, wrong: 0, args: final.map(call => JSON.parse(call.arguments)) }
    expect(table).toEqual(Object.fromEntries(Object.keys(replays).map(name => [name, exact])))
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
