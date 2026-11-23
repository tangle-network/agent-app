/** Real Node HTTP streams through the production fetch/SSE/LoopEvent adapters. */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { createOpenAICompatStreamTurn, createOpenAIResponsesTurn } from '../src/runtime/openai-stream'
import { runRouterTurn } from '../src/runtime/router-turn'
import { createTurnTrace } from '../src/turn-trace/index'

it('preserves fragmented UTF-8, tool arguments, usage and per-request reasoning summaries over HTTP', async () => {
  const requests: Array<{ path: string; body: Record<string, unknown>; authorization?: string }> = []
  const chat = [
    { choices: [{ delta: { content: 'Café ' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'lookup', arguments: '{"query":' } }] } }] },
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
    const parameters = { type: 'object', properties: { query: { type: 'string' }, locator: { type: 'string' } }, required: ['query'] }
    const tool = { type: 'function', function: { name: 'lookup', parameters } }
    const options = { tools: [tool], baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: 'local-integration-only', model: 'fixture-model' }
    const messages = [{ role: 'user' as const, content: 'Find the lease' }]
    const chatEvents = []
    for await (const event of createOpenAICompatStreamTurn(options)(messages)) chatEvents.push(event)
    expect(chatEvents).toEqual([
      { type: 'text', text: 'Café ' },
      { type: 'tool_call_start', toolCallId: 'call-1', toolName: 'lookup' },
      { type: 'usage', usage: { promptTokens: 7, completionTokens: 3 } },
      { type: 'tool_call', call: { toolCallId: 'call-1', toolName: 'lookup', args: { query: 'lease' } } },
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
    expect(requests[0]!.body.tools).toEqual([tool])
    expect(requests[1]!.body.input).toEqual(messages)
    expect(requests[1]!.body.tools).toEqual([{ type: 'function', name: 'lookup', parameters, strict: false }])
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

it('gives every Responses function call its final arguments and every reply its final text, however the stream carries them', async () => {
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
  const answer = ['Here is', ' the answer:', ' forty-two']
  const message = { id: 'msg_fixture1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer.join('') }] }
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
    // The reply's last token arrives only in the done events, never in a delta.
    g_last_text_only_in_done: [created, inProgress, { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
      ...answer.slice(0, -1).map(delta => ({ type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta })),
      { type: 'response.output_text.done', item_id: message.id, output_index: 0, content_index: 0, text: answer.join('') },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { ...completed, response: { ...completed.response, output: [message] } }],
  }
  // What each replay should assemble: its final output's text and function calls.
  const expected = (frames: Frame[]) => {
    const output: Frame[] = frames.at(-1)!.response.output
    return {
      text: output.filter(item => item.type === 'message').map(item => item.content[0].text).join(''),
      calls: output.filter(item => item.type === 'function_call')
        .map(item => ({ toolCallId: item.call_id, toolName: item.name, args: JSON.parse(item.arguments) })),
    }
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
    const table: Record<string, { text: string; calls: unknown[] }> = {}
    for (const name of Object.keys(replays)) {
      const turn = createOpenAIResponsesTurn({ baseUrl: `${origin}/${name}/v1`, apiKey: 'local-integration-only', model: 'fixture-model' })
      const row: { text: string; calls: unknown[] } = { text: '', calls: [] }
      for await (const event of turn([{ role: 'user', content: 'Search three things at once' }])) {
        if (event.type === 'text') row.text += event.text
        if (event.type === 'tool_call') row.calls.push({ toolCallId: event.call.toolCallId, toolName: event.call.toolName, args: event.call.args })
      }
      table[name] = row
    }
    expect(table).toEqual(Object.fromEntries(Object.entries(replays).map(([name, replay]) =>
      [name, expected(typeof replay === 'string' ? events : replay)])))
    // The recorded stream's three calls are the expectation for every function-call replay.
    expect(expected(events).calls).toHaveLength(3)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

it('records on each model call span why it ended, its answer characters, its function calls and its reasoning tokens', async () => {
  const answer = 'Here is the answer: forty-two'
  const sse = (events: object[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
  const reasoning = { id: 'rs_fixture1', type: 'reasoning', summary: [] }
  // A reasoning-only call (blank, so the turn repeats it once), the recorded round of three function calls, then the answer.
  const replies = [
    sse([{ type: 'response.output_item.added', output_index: 0, item: reasoning },
      { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
        output: [reasoning], usage: { input_tokens: 90, output_tokens: 4000, output_tokens_details: { reasoning_tokens: 4000 } } } }]),
    readFileSync(new URL('./fixtures/responses-parallel-function-calls.sse', import.meta.url), 'utf8'),
    sse([{ type: 'response.output_text.delta', item_id: 'msg_fixture1', output_index: 0, content_index: 0, delta: answer },
      { type: 'response.completed', response: { status: 'completed',
        output: [{ id: 'msg_fixture1', type: 'message', content: [{ type: 'output_text', text: answer }] }],
        usage: { input_tokens: 200, output_tokens: 12, output_tokens_details: { reasoning_tokens: 0 } } } }]),
  ]
  let served = 0
  const server = createServer((request, response) => {
    request.resume().on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(replies[served++] ?? '')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const trace = createTurnTrace({ executionId: 'model-call-outcome-fixture' })
    const outcome = await runRouterTurn({ apiKey: 'local-integration-only', model: 'gpt-6-luna', trace,
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, systemPrompt: 's', userMessage: 'Search three things at once',
      tools: [{ name: 'web_search', description: 'Search the web', run: async () => 'found',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }] })
    expect(outcome.text).toBe(answer)
    expect(trace.finish().spans.filter(span => span.name === 'model.call').map(({ attrs }) => ({
      finish: attrs['gen_ai.response.finish_reasons'], textChars: attrs['tangle.model.text_chars'],
      toolCalls: attrs['tangle.model.tool_calls'], reasoningTokens: attrs['gen_ai.usage.reasoning_tokens'] }))).toEqual([
      { finish: 'max_output_tokens', textChars: 0, toolCalls: 0, reasoningTokens: 4000 },
      { finish: 'completed', textChars: 0, toolCalls: 3, reasoningTokens: 0 },
      { finish: 'completed', textChars: answer.length, toolCalls: 0, reasoningTokens: 0 },
    ])
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
