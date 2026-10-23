/**
 * The engine asks the Router to stream reasoning as it arrives, the first
 * thought reaches the chat route before the answer exists, and a Router error
 * frame after released reasoning ends the call by name and takes the repeat.
 *
 * A Router on a real socket behaves as tangle-router does for a thinking model:
 * with `gateway.streamReasoningImmediately` it releases the stream at the first
 * reasoning frame (for Gemini, the thought summary the Router now asks Google
 * for); without it, it holds the stream until the first word. The model
 * `released-then-empty` reasons and then finishes empty, which the Router
 * reports as an `empty_completion` error frame once reasoning was released.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createChatTurnRoutes, createRouterTurnProducer } from '../../src/chat-routes/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import { buildTurnTraceOtelSpans, type TurnTraceSnapshot } from '../../src/turn-trace/index'
import { runRouterTurn } from '../../src/runtime/router-turn'

const THINK_MS = 400
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const frame = (model: string, delta: Record<string, unknown>) => `data: ${JSON.stringify({ model, choices: [{ index: 0, delta }] })}\n\n`

function startRouter(bodies: Array<Record<string, any>>): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      bodies.push(body)
      const model = String(body.model)
      const release = body.gateway?.streamReasoningImmediately === true
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (model === 'released-then-empty') {
        response.write(frame(model, { role: 'assistant', reasoning_content: 'First model thinking.' }))
        await sleep(50)
        response.write(`data: ${JSON.stringify({ error: { message: 'The model finished without output.', type: 'server_error', code: 'empty_completion' } })}\n\n`)
        response.end('data: [DONE]\n\n')
        return
      }
      const thought = frame(model, { role: 'assistant', reasoning_content: `**Counting rooms** (${model})\n\nTwelve minus the unavailable ones.` })
      if (release) response.write(thought)
      await sleep(THINK_MS)
      if (!release) response.write(thought)
      response.write(frame(model, { content: 'Four rooms are ready.' }))
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 290 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })))
}

async function drain(producer: ReturnType<typeof createRouterTurnProducer>, started: number) {
  const arrivals: Array<{ type: string; atMs: number; text: string }> = []
  for await (const event of producer.stream) {
    arrivals.push({ type: event.type, atMs: Date.now() - started, text: 'text' in event && typeof event.text === 'string' ? event.text : '' })
  }
  return arrivals
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
    const arrivals = await drain(producer, started)

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

  it('records reasoning-first latency separately in the lifecycle and exported root span', async () => {
    let snapshot: TurnTraceSnapshot | undefined
    let timing: { admissionMs?: number; firstVisibleMs?: number; firstTextMs?: number } | undefined
    const pending: Promise<unknown>[] = []
    const routes = createChatTurnRoutes<Record<string, never>>({
      projectId: 'reasoning-timing',
      authorize: async () => { await sleep(60); return { ok: true, tenantId: 'ws-1', userId: 'u-1', context: {} } },
      store: { async listMessages() { return [] }, async appendMessage() { return { id: 'm-1' } } },
      turnStore: createMemoryTurnEventStore(), log: () => {},
      turnTrace: { sink: done => { snapshot = done } },
      lifecycle: { onTurnComplete: info => { timing = info } },
      produce: ({ trace }) => createRouterTurnProducer({
        apiKey: 'k', model: 'gemini-3.7-flash', baseUrl: router.url,
        systemPrompt: 's', userMessage: 'How many rooms?', trace,
      }),
    })
    const response = await routes.turn(new Request('http://app.test/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'timing', content: 'How many rooms?' }),
    }), { waitUntil: promise => { pending.push(promise) } })
    expect(await response.text()).toContain('Counting rooms')
    await Promise.all(pending)
    expect(timing?.firstVisibleMs).toBeGreaterThanOrEqual(0)
    expect(timing!.firstTextMs! - timing!.firstVisibleMs!).toBeGreaterThanOrEqual(THINK_MS - 50)
    const summary = snapshot!.summary
    expect(timing!.admissionMs!).toBeGreaterThanOrEqual(60)
    expect(timing!.admissionMs! + timing!.firstVisibleMs!).toBeCloseTo(summary.firstVisibleMs!, 0)
    expect(summary.firstTextMs! - summary.firstVisibleMs!).toBeGreaterThanOrEqual(THINK_MS - 50)
    const root = buildTurnTraceOtelSpans(snapshot!)[0]!
    expect(root.attributes.find(attr => attr.key === 'tangle.turn.first_visible_ms')?.value).toEqual({ doubleValue: summary.firstVisibleMs })
    expect(root.attributes.find(attr => attr.key === 'tangle.turn.first_text_ms')?.value).toEqual({ doubleValue: summary.firstTextMs })
  })

  it('sends no gateway option without onEvent, without showReasoning, or with the repeat off', async () => {
    bodies.length = 0
    const base = { apiKey: 'k', model: 'gemini-3.7-flash', baseUrl: router.url, systemPrompt: 's', userMessage: 'q' }
    const quiet = await runRouterTurn({ ...base, showReasoning: true })
    const dropsReasoning = await runRouterTurn({ ...base, onEvent: () => {} })
    const noRepeat = await runRouterTurn({ ...base, onEvent: () => {}, showReasoning: true, repeat: false })
    const producerOptOut = createRouterTurnProducer({ ...base, showReasoning: false })
    await drain(producerOptOut, Date.now())
    for (const outcome of [quiet, dropsReasoning, noRepeat]) expect(outcome.text).toBe('Four rooms are ready.')
    expect(bodies).toHaveLength(4)
    for (const body of bodies) expect(body.gateway).toBeUndefined()
  })

  it('an empty finish after released reasoning repeats on the fallback, with its reasoning in a new part', async () => {
    bodies.length = 0
    const producer = createRouterTurnProducer({
      apiKey: 'k', model: 'released-then-empty', fallbackModels: ['gemini-3.7-flash'], baseUrl: router.url,
      systemPrompt: 's', userMessage: 'How many rooms can take a guest?',
    })
    const arrivals = await drain(producer, Date.now())

    expect(bodies.map((body) => body.model)).toEqual(['released-then-empty', 'gemini-3.7-flash'])
    expect(arrivals.filter((event) => event.type === 'text').map((event) => event.text).join('')).toBe('Four rooms are ready.')
    expect(arrivals.some((event) => event.type === 'error')).toBe(false)
    const reasoningParts = producer.assistantParts!().filter((part) => part.type === 'reasoning')
    expect(reasoningParts.map((part) => part.text)).toEqual([
      'First model thinking.',
      expect.stringContaining('(gemini-3.7-flash)'),
    ])
  })

  it('with no repeat left, the error frame surfaces by name', async () => {
    bodies.length = 0
    const outcome = await runRouterTurn({
      apiKey: 'k', model: 'released-then-empty', baseUrl: router.url, systemPrompt: 's', userMessage: 'q', repeat: false,
    })
    expect(bodies).toHaveLength(1)
    expect(outcome.failure).toMatchObject({ code: 'model_stream_empty_completion', detail: expect.stringContaining('empty_completion') })
  })
})
