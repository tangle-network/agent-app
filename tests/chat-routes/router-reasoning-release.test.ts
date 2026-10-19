/**
 * The engine asks the Router to stream reasoning as it arrives, and the first
 * thought reaches the chat route before the answer exists.
 *
 * A Router on a real socket behaves as tangle-router does for a thinking model:
 * with `gateway.streamReasoningImmediately` it releases the stream at the first
 * reasoning frame (for Gemini, the thought summary the Router now asks Google
 * for); without it, it holds the stream until the first word, so nothing
 * reaches the client while the model thinks.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRouterTurnProducer } from '../../src/chat-routes/index'
import { runRouterTurn } from '../../src/runtime/router-turn'

const THINK_MS = 400
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const frame = (delta: Record<string, unknown>) => `data: ${JSON.stringify({ model: 'gemini-3.7-flash', choices: [{ index: 0, delta }] })}\n\n`

function startRouter(bodies: Array<Record<string, any>>): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      bodies.push(body)
      const release = body.gateway?.streamReasoningImmediately === true
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const thought = frame({ role: 'assistant', reasoning_content: '**Counting rooms**\n\nTwelve minus the unavailable ones.' })
      if (release) response.write(thought)
      await sleep(THINK_MS)
      if (!release) response.write(thought)
      response.write(frame({ content: 'Four rooms are ready.' }))
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 290 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })))
}

describe('Router reasoning release', () => {
  let router: { server: Server; url: string }
  const bodies: Array<Record<string, any>> = []
  beforeAll(async () => { router = await startRouter(bodies) })
  afterAll(() => { router.server.close() })

  it('the chat producer asks for it, and the first thought reaches the wire before the answer', async () => {
    bodies.length = 0
    const started = Date.now()
    const producer = createRouterTurnProducer({
      apiKey: 'k', model: 'gemini-3.7-flash', baseUrl: router.url,
      systemPrompt: 's', userMessage: 'How many rooms can take a guest?',
    })
    const arrivals: Array<{ type: string; atMs: number; text: string }> = []
    for await (const event of producer.stream) {
      arrivals.push({ type: event.type, atMs: Date.now() - started, text: 'text' in event && typeof event.text === 'string' ? event.text : '' })
    }

    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.gateway).toEqual({ streamReasoningImmediately: true })
    expect(bodies[0]!.stream).toBe(true)
    const firstReasoning = arrivals.find((event) => event.type === 'reasoning')!
    const firstText = arrivals.find((event) => event.type === 'text')!
    expect(firstReasoning.text).toContain('Counting rooms')
    // The thought is on the wire while the model is still "thinking": a whole think-time ahead of the answer.
    expect(firstText.atMs - firstReasoning.atMs).toBeGreaterThanOrEqual(THINK_MS - 50)
    // Reasoning is never answer text.
    expect(arrivals.filter((event) => event.type === 'text').map((event) => event.text).join('')).toBe('Four rooms are ready.')
    const parts = producer.assistantParts!()
    expect(parts.find((part) => part.type === 'reasoning')).toMatchObject({ text: expect.stringContaining('Counting rooms') })
  })

  it('a caller that takes no events sends no gateway option', async () => {
    bodies.length = 0
    const quiet = await runRouterTurn({ apiKey: 'k', model: 'gemini-3.7-flash', baseUrl: router.url, systemPrompt: 's', userMessage: 'q' })
    expect(quiet.text).toBe('Four rooms are ready.')
    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.gateway).toBeUndefined()
  })
})
