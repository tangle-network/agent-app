/** Real Node HTTP streams through the production fetch/SSE/LoopEvent adapters. */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
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
