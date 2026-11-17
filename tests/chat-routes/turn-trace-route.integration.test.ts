/**
 * A turn's owner reads its trace through `routes.trace`, the URL the turn receipt names; another member gets 404.
 * Real SQLite thread rows decide ownership, and the real sink and reader cross HTTP to an Intelligence stand-in that
 * stores what the OTLP ingest stores (resource, scope and span attributes merged, per tenant) and serves
 * `GET /v1/traces/:traceId/spans` in Intelligence's row shape.
 */
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { decodeOtlpTraceExport } from '@tangle-network/agent-trace-contract/otlp'
import { detectCredential } from '@tangle-network/agent-eval/traces'
import { expect, it } from 'vitest'
import { createChatTurnRoutes, type ChatTurnMessageStore } from '../../src/chat-routes/index'
import { createChatTables, createChatStore, type ChatDatabase } from '../../src/chat-store/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import { createIntelligenceTurnTraceReader, createIntelligenceTurnTraceSink } from '../../src/turn-trace/index'
import { openDatabase } from '../teams/db-helper'

type Row = Record<string, unknown> & { id: string; tenantId: string; traceId: string }

async function startIntelligence(tenants: Record<string, string>) {
  const rows: Row[] = []
  const reads: Array<{ path: string; authorization?: string }> = []
  const body = async (request: IncomingMessage) => {
    let text = ''
    for await (const chunk of request) text += chunk
    return text
  }
  const server = createServer(async (request, response) => {
    const tenantId = tenants[(request.headers.authorization ?? '').replace(/^Bearer /, '')]
    const send = (status: number, value: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
    if (!tenantId) return send(401, { error: 'unauthorized' })
    if (request.method === 'POST' && request.url === '/v1/otlp/v1/traces') {
      for (const span of decodeOtlpTraceExport(JSON.parse(await body(request)))) {
        rows.push({
          id: `${span.trace_id}:${span.span_id}`, tenantId, traceId: span.trace_id, parentSpanId: span.parent_span_id || null,
          name: span.name, startUnixNano: span.start_time_unix_nano, endUnixNano: span.end_time_unix_nano,
          attributes: { ...span.resource_attributes, 'otel.scope.name': span.scope_name, 'otel.scope.version': span.scope_version, ...span.span_attributes },
          statusCode: span.status_code === 1 ? 'OK' : span.status_code === 2 ? 'ERROR' : 'UNSET', statusMessage: span.status_message ?? null,
          projectKey: span.resource_attributes['service.name'], userId: span.span_attributes['tangle.userId'] ?? null, ingestEnvelopeId: 'envelope-1',
        })
      }
      return send(200, {})
    }
    const traceId = request.url?.match(/^\/v1\/traces\/([^/?]+)\/spans/)?.[1]
    if (request.method === 'GET' && traceId) {
      reads.push({ path: request.url!, authorization: request.headers.authorization })
      const items = rows.filter((row) => row.tenantId === tenantId && row.traceId === traceId)
      return send(200, { items, truncated: false, total: items.length, nextCursor: null })
    }
    send(404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { rows, reads, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

it('serves a turn its receipt names to the thread owner as OTLP, 404 to another member, with no credential or content', async () => {
  const appKey = `sk-tan-${crypto.randomUUID().replaceAll('-', '')}`
  const intelligence = await startIntelligence({ [appKey]: 'tenant-app' })
  const tables = createChatTables()
  const database = openDatabase([tables.threads, tables.messages])
  const store = createChatStore(database as unknown as ChatDatabase, tables)
  const workspaceOf: Record<string, string> = { ada: 'workspace-ada', bo: 'workspace-bo' }
  const thread = await store.createThread({ workspaceId: workspaceOf.ada!, title: 'Estimated taxes' })
  const project = 'trace-route-app'
  const pending: Promise<unknown>[] = []
  const exportErrors: string[] = []
  const routes = createChatTurnRoutes({
    projectId: project, store: store as unknown as ChatTurnMessageStore, turnStore: createMemoryTurnEventStore(),
    // The product's own check: the caller's workspace owns the thread row. A refusal here is the product's 403.
    authorize: async ({ request, threadId, body, trace, span }) => {
      // A product step that fails quoting what the member typed: its error text never reaches the trace route.
      const typed = String((body as Record<string, unknown> | undefined)?.content)
      await trace?.measure('admission.auth.lookup', 'admission', () => { throw new Error(`no record for ${typed}`) }, undefined, span).catch(() => {})
      const userId = request.headers.get('x-user') ?? ''
      const row = await store.getThread(String(threadId ?? body?.threadId ?? ''))
      if (!workspaceOf[userId] || row?.workspaceId !== workspaceOf[userId]) return { ok: false, response: Response.json({ error: 'Forbidden' }, { status: 403 }) }
      return { ok: true, tenantId: row.workspaceId, userId, context: undefined }
    },
    turnTrace: {
      sink: createIntelligenceTurnTraceSink({ project, apiKey: appKey, baseUrl: intelligence.baseUrl, onError: (reason) => { exportErrors.push(reason) } }),
      read: createIntelligenceTurnTraceReader({ project, apiKey: appKey, baseUrl: intelligence.baseUrl }),
    },
    produce: () => ({ stream: (async function* () { yield { type: 'text' as const, text: 'Pay by the 15th.' } })(), finalText: () => 'Pay by the 15th.' }),
  })
  try {
    const response = await routes.turn(new Request('https://app.test/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-user': 'ada' },
      body: JSON.stringify({ threadId: thread.id, content: 'When is my estimated payment due?' }),
    }), { waitUntil: (work) => { pending.push(work) } })
    const receipt = JSON.parse((await response.text()).split('\n')[0]!) as { type: string; traceId: string; traceUrl: string }
    await Promise.all(pending)
    expect(exportErrors).toEqual([])
    expect(receipt).toMatchObject({ type: 'turn', traceId: expect.stringMatching(/^[0-9a-f]{32}$/) })

    // Another exporter's span in the same trace and tenant, joined to the turn's tree the way a traceparent joins it:
    // a box agent recording the prompt and a leaked key.
    const leak = `Bearer ${appKey}`
    expect(detectCredential(leak)).toBeDefined()
    const rootRow = intelligence.rows.find((row) => row.name === 'agent_app.turn')!
    intelligence.rows.push({ ...rootRow, id: `${receipt.traceId}:00000000000000aa`, parentSpanId: rootRow.id.split(':')[1], name: 'agent.box.llm',
      attributes: { 'otel.scope.name': 'box-agent', 'input.value': 'When is my estimated payment due?', 'http.request.header.authorization': leak } })
    // Another turn's spans under the same trace id (an id collision, or a tenant two apps share): never this turn's.
    intelligence.rows.push(
      { ...rootRow, id: `${receipt.traceId}:00000000000000bb`,
        attributes: { ...rootRow.attributes as object, 'tangle.execution_id': `${project}:other-thread:0` } },
      { ...rootRow, id: `${receipt.traceId}:00000000000000cc`, parentSpanId: '00000000000000bb', name: 'admission.other' })

    // The template's router hands the path segment over still URL-encoded; React Router decodes it.
    const segment = receipt.traceUrl.match(/\/turns\/([^/]+)\/trace$/)![1]!
    const read = (user: string, turnId = segment) =>
      routes.trace(new Request(`https://app.test${receipt.traceUrl}`, { headers: { 'x-user': user } }), { turnId })
    expect(receipt.traceUrl).toMatch(/^\/api\/chat\/turns\/[^/]+\/trace$/)

    const owner = await read('ada')
    expect(owner.status).toBe(200)
    const text = await owner.text()
    const spans = decodeOtlpTraceExport(JSON.parse(text))
    const root = spans.find((span) => span.name === 'agent_app.turn')!
    expect(root.trace_id).toBe(receipt.traceId)
    expect(root.span_attributes['tangle.execution_id']).toBe(decodeURIComponent(receipt.traceUrl.split('/')[4]!))
    expect(spans.every((span) => span.trace_id === receipt.traceId)).toBe(true)
    expect(spans.some((span) => span.name.startsWith('admission.') && span.parent_span_id === root.span_id)).toBe(true)
    expect(spans.map((span) => span.name)).not.toContain('agent.box.llm')
    expect(spans.map((span) => span.span_id)).not.toContain('00000000000000bb')
    expect(spans.map((span) => span.name)).not.toContain('admission.other')
    expect(spans.find((span) => span.name === 'admission.auth.lookup')?.status_code).toBe(2)
    for (const span of spans) {
      for (const value of Object.values(span.attributes)) {
        expect(detectCredential(String(value)), String(value)).toBeUndefined()
      }
    }
    expect(text).not.toContain(appKey)
    expect(text).not.toContain('estimated payment')
    expect(text).not.toContain('tenant-app')

    expect((await read('ada', decodeURIComponent(segment))).status).toBe(200)
    expect((await read('bo')).status).toBe(404)
    // Only that trace was read, only with the app's key, and never for the member who was refused.
    expect(intelligence.reads).toEqual(Array(2).fill({ path: `/v1/traces/${receipt.traceId}/spans`, authorization: `Bearer ${appKey}` }))
  } finally {
    database.$client.close()
    await intelligence.close()
  }
})
