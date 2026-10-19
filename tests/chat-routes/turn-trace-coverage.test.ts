import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createChatTurnRoutes, createRouterTurnProducer, type ChatTurnMessageStore } from '../../src/chat-routes/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import { createIntelligenceTurnTraceSink, otlpTraceId, turnTraceId, type TurnTraceSnapshot } from '../../src/turn-trace/index'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * A Router on a real socket: it waits like the real one (a pre-upstream step, a provider wait), answers with a
 * `Server-Timing` header, then streams the completion in chunks with gaps. Two completions: a tool call, then text.
 */
function startRouter(seen: IncomingHttpHeaders[], otlp: Array<{ authorization?: string; body: any }>): Promise<{ server: Server; url: string }> {
  let calls = 0
  const server = createServer((request, response) => {
    if (request.url === '/v1/otlp/v1/traces') {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        otlp.push({ authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      })
      return
    }
    seen.push(request.headers)
    request.resume()
    request.on('end', async () => {
      const call = ++calls
      await sleep(60)
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'server-timing': 'auth;dur=12.0, upstream_start;dur=40.0, upstream_headers;dur=80.0, t_admitted;dur=35.0',
      })
      await sleep(80)
      const chunks = call === 1
        ? [{ model: 'served/model', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'rooms_ready', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
          { choices: [], usage: { prompt_tokens: 900, completion_tokens: 12 } }]
        : [{ model: 'served/model', choices: [{ delta: { content: 'Four rooms ' } }] },
          { model: 'served/model', choices: [{ delta: { content: 'are ready.' } }] },
          { choices: [], usage: { prompt_tokens: 950, completion_tokens: 6 } }]
      for (const chunk of chunks) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`)
        await sleep(40)
      }
      response.end('data: [DONE]\n\n')
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })))
}

describe('turn trace: a real turn through createChatTurnRoutes', () => {
  let router: { server: Server; url: string }
  const routerHeaders: IncomingHttpHeaders[] = []
  const otlpPosts: Array<{ authorization?: string; body: any }> = []
  beforeAll(async () => { router = await startRouter(routerHeaders, otlpPosts) })
  afterAll(() => { router.server.close() })

  it('puts at least 90% of the turn inside named spans and sends the trace id to the Router', async () => {
    const rows: Array<{ role: string }> = []
    const store: ChatTurnMessageStore = {
      async listMessages() { return [] },
      async appendMessage(input) { rows.push(input as never); return { id: `m-${rows.length}` } },
    }
    let snapshot: TurnTraceSnapshot | undefined
    const pending: Promise<unknown>[] = []
    const routes = createChatTurnRoutes<Record<string, never>>({
      projectId: 'trace-app',
      authorize: async () => { await sleep(30); return { ok: true, tenantId: 'ws-1', userId: 'user-1', context: {} } },
      store,
      turnStore: createMemoryTurnEventStore(),
      incrementalPersistence: false,
      turnTrace: {
        // The Intelligence sink posts OTLP to the same socket; the capture keeps the snapshot for the span assertions.
        sink: async (done, labels) => {
          snapshot = done
          await createIntelligenceTurnTraceSink({ project: 'trace-app', apiKey: 'tenant-key', baseUrl: router.url })(done, labels)
        },
        labels: ({ context }) => ({ 'tangle.test': context !== undefined }),
      },
      produce: ({ prompt, trace }) => createRouterTurnProducer({
        apiKey: 'k', model: 'requested/model', systemPrompt: 's', userMessage: typeof prompt === 'string' ? prompt : '',
        baseUrl: router.url, trace,
        tools: [{
          name: 'rooms.ready', description: 'Count ready rooms.', inputSchema: { type: 'object', properties: {} },
          run: async () => { await sleep(120); return { ready: 4 } },
        }],
      }),
      log: () => {},
    })
    const response = await routes.turn(new Request('http://app.test/api/chat', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: 't-1', content: 'How many rooms?' }) }),
    { waitUntil: (p: Promise<unknown>) => { pending.push(p) } })
    expect(await response.text()).toContain('Four rooms')
    await Promise.all(pending)

    expect(snapshot).toBeDefined()
    const { summary, spans } = snapshot!
    // One id: the execution id in the Router's header charset, on every model request and on the trace.
    expect(snapshot!.traceId).toBe(turnTraceId(snapshot!.executionId))
    expect(snapshot!.executionId).toMatch(/^trace-app:t-1:\d+$/)
    expect(routerHeaders.length).toBe(2)
    for (const headers of routerHeaders) expect(headers['x-tangle-trace-id']).toBe(snapshot!.traceId)
    expect(snapshot!.traceId).toMatch(/^[\w-]{8,200}$/)

    // The hill: named child spans cover at least 90% of the turn's wall time.
    expect(summary.coveragePct).toBeGreaterThanOrEqual(90)
    expect(summary.byKind.admission).toBeGreaterThan(0)
    expect(summary.byKind.tool).toBeGreaterThanOrEqual(100)
    // The Router's Server-Timing splits the wait before the first byte into server and network time.
    expect(summary.byKind.router).toBeGreaterThanOrEqual(30)
    expect(summary.byKind.network).toBeGreaterThan(0)
    expect(Object.values(summary.byKind).reduce((sum, ms) => sum + ms, 0)).toBeCloseTo(summary.coveredMs, 0)

    const names = spans.map((span) => span.name)
    expect(names.filter((name) => name === 'model.call')).toHaveLength(2)
    expect(names.filter((name) => name === 'tool.call')).toHaveLength(1)
    expect(names).toEqual(expect.arrayContaining(['admission.authorize', 'admission.history', 'admission.produce', 'persist.assistant', 'router.pre_upstream', 'model.stream']))
    const model = spans.find((span) => span.name === 'model.call')!
    expect(model.attrs).toMatchObject({ 'http.status_code': 200, 'server_timing.upstream_start_ms': 40, 'gen_ai.request.model': 'requested/model',
      'gen_ai.usage.input_tokens': 900, 'gen_ai.usage.output_tokens': 12 })
    expect(model.attrs.ttft_ms).toBeGreaterThan(0)

    // One OTLP POST per turn: the root span with the turn's numbers, every child under it, in the trace id the Sandbox SDK maps.
    expect(otlpPosts).toHaveLength(1)
    expect(otlpPosts[0]!.authorization).toBe('Bearer tenant-key')
    const exported = otlpPosts[0]!.body.resourceSpans[0].scopeSpans[0].spans as Array<{ traceId: string; spanId: string; parentSpanId?: string; name: string; attributes: Array<{ key: string; value: Record<string, unknown> }> }>
    expect(exported).toHaveLength(spans.length + 1)
    const root = exported.find((span) => span.name === 'agent_app.turn')!
    expect(root.parentSpanId).toBeUndefined()
    expect(root.attributes.find((attribute) => attribute.key === 'tangle.turn.coverage_pct')?.value.doubleValue).toBe(summary.coveragePct)
    // A measurement keeps one OTLP type whatever its value: a whole number (0 ms of sandbox here) is still a double.
    for (const key of ['tangle.turn.wall_ms', 'tangle.turn.coverage_pct', 'tangle.turn.sandbox_ms', 'tangle.turn.admission_ms']) {
      const value = root.attributes.find((attribute) => attribute.key === key)?.value
      expect(value, key).toEqual({ doubleValue: expect.any(Number) })
    }
    expect(root.attributes.find((attribute) => attribute.key === 'tangle.trace_id')?.value.stringValue).toBe(snapshot!.traceId)
    expect(new Set(exported.map((span) => span.traceId))).toEqual(new Set([otlpTraceId(snapshot!.traceId)]))
    for (const span of exported.filter((candidate) => candidate !== root)) expect(exported.some((candidate) => candidate.spanId === span.parentSpanId)).toBe(true)
  })
})
