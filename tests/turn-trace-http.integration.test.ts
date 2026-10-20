import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { createTurnTrace, createIntelligenceTurnTraceSink, otlpTraceId, tracedModelFetch } from '../src/turn-trace/index'

type Capture = { path: string; headers: IncomingHttpHeaders; body: string }

it('parents real HTTP sends to exported model spans while preserving Request overrides and cancellation', async () => {
  const seen: Capture[] = []
  let closed!: () => void
  const cancelled = new Promise<void>(resolve => { closed = resolve })
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      seen.push({ path: request.url!, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') })
      if (request.url === '/cancel') {
        response.on('close', closed)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n')
      } else response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const trace = createTurnTrace({ executionId: 'request-header-socket-integration' })
  const send = tracedModelFetch(trace, fetch)
  try {
    const requestHeaders = {
      authorization: 'Bearer socket-fixture-input', 'content-type': 'application/input',
      tracestate: 'fixture=input', 'x-input': 'retained', traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`,
    }
    const input = new Request(`${base}/input`, { method: 'POST', headers: requestHeaders, body: 'input-body' })
    expect(await (await send(input)).text()).toBe('{}')
    expect(input.headers.get('traceparent')).toBe(requestHeaders.traceparent)
    expect(seen[0]).toMatchObject({ path: '/input', body: 'input-body', headers: {
      authorization: requestHeaders.authorization, 'content-type': requestHeaders['content-type'],
      tracestate: 'fixture=input', 'x-input': 'retained',
    } })

    // A supplied init.headers replaces input headers, and init.signal overrides
    // the already-aborted Request signal, exactly as native fetch does.
    const overrides = new Headers({ authorization: 'Bearer socket-fixture-override',
      'content-type': 'application/override', tracestate: 'fixture=override', 'x-override': 'retained' })
    const aborted = new Request(`${base}/override`, {
      method: 'POST', headers: requestHeaders, body: 'replaced', signal: AbortSignal.abort(),
    })
    expect(await (await send(aborted, { headers: overrides, body: 'override-body', signal: new AbortController().signal })).text()).toBe('{}')
    expect(overrides.has('traceparent')).toBe(false)
    expect(seen[1]).toMatchObject({ path: '/override', body: 'override-body', headers: {
      authorization: 'Bearer socket-fixture-override', 'content-type': 'application/override',
      tracestate: 'fixture=override', 'x-override': 'retained',
    } })
    expect(seen[1]!.headers['x-input']).toBeUndefined()

    const controller = new AbortController()
    const response = await send(new Request(`${base}/cancel`, { method: 'POST', headers: requestHeaders, body: 'cancel-body', signal: controller.signal }))
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('first')
    controller.abort()
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
    await cancelled

    const done = trace.finish()
    await createIntelligenceTurnTraceSink({ project: 'socket-integration', apiKey: 'socket-fixture-ingest', baseUrl: base })(done, {})
    const exportRequest = seen.find(request => request.path === '/v1/otlp/v1/traces')!
    const exported = JSON.parse(exportRequest.body).resourceSpans[0].scopeSpans[0].spans as Array<{ name: string; traceId: string; spanId: string; parentSpanId?: string }>
    const models = exported.filter(span => span.name === 'model.call')
    expect(models).toHaveLength(3)
    expect(seen.filter(request => request.path !== '/v1/otlp/v1/traces').map(request => request.headers.traceparent)).toEqual(
      models.map(span => `00-${otlpTraceId(done.traceId)}-${span.spanId}-01`),
    )
    expect(models.every(span => span.traceId === otlpTraceId(done.traceId))).toBe(true)
    expect(done.spans.find(span => span.spanId === models[2]!.spanId)?.error).toBeTruthy()
    expect(exportRequest.headers.authorization).toBe('Bearer socket-fixture-ingest')
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}, 10_000)
