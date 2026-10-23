import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Sandbox } from '@tangle-network/sandbox'
import { text } from 'drizzle-orm/sqlite-core'
import { expect, it } from 'vitest'
import { createChatTurnRoutes, type ChatTurnMessageStore } from '../../src/chat-routes/index'
import { createChatStore, createChatTables, type ChatDatabase } from '../../src/chat-store/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import { openDatabase } from '../teams/db-helper'

const cases = [
  { mode: 'cancel', status: 200, stopped: true },
  { mode: 'terminal', status: 200, stopped: true },
  { mode: 'another-execution', status: 200, stopped: true },
  { mode: 'ambiguous', status: 502, stopped: false },
  { mode: 'still-active', status: 502, stopped: false },
  { mode: 'wrong-session', status: 502, stopped: false },
  { mode: 'null-status', status: 502, stopped: false },
  { mode: 'box-mismatch', status: 503, stopped: false },
  { mode: 'pending', status: 409, stopped: false },
  { mode: 'wrong-token', status: 409, stopped: false },
  { mode: 'stopped', status: 200, stopped: true },
  { mode: 'answered', status: 200, stopped: false },
  { mode: 'retry-race', status: 409, stopped: false },
  { mode: 'receipt-race', status: 409, stopped: false },
  { mode: 'viewer', status: 403, stopped: false },
  { mode: 'unauthenticated', status: 401, stopped: false },
]

/** Real SQLite authorization/CAS + real public Sandbox SDK over loopback HTTP. No mocked SDK methods. */
it.each(cases)('cancels the exact dispatch and fails closed for $mode', async ({ mode, status, stopped }) => {
  const tables = createChatTables({ messageExtraColumns: {
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
  } })
  const database = openDatabase([tables.threads, tables.messages])
  const store = createChatStore(database as unknown as ChatDatabase, tables)
  database.$client.exec("CREATE TABLE member(token TEXT PRIMARY KEY, user_id TEXT, role TEXT); INSERT INTO member VALUES ('editor-token','editor','editor'),('viewer-token','viewer','viewer')")
  await store.createThread({ id: 'thread', workspaceId: 'workspace' })
  const metadata = { responseStatus: mode === 'stopped' ? 'stopped' : mode === 'answered' ? 'answered' : 'streaming',
    dispatchToken: 'dispatch-original', executionId: 'execution-original', product: { retained: true },
    run: { state: mode === 'pending' ? 'pending' : 'running', sandboxId: 'fixture-box', sessionId: 'session-original', executionId: 'execution-original' } }
  await store.appendMessage({ id: 'user-row', threadId: 'thread', role: 'user', content: 'Answer once.',
    parts: [{ type: 'text', text: 'Answer once.', turnId: 'client-turn' }], extras: { metadata } })
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = []
  let targetReads = 0
  const server = createServer((request, response) => {
    const path = new URL(request.url!, 'http://source.test').pathname
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => { void (async () => {
      calls.push({ path, ...(body ? { body: JSON.parse(body) } : {}) })
      const json = (value: unknown, code = 200) => response.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(value))
      if (path === '/v1/sandboxes/fixture-box') return json({ id: mode === 'box-mismatch' ? 'other-box' : 'fixture-box',
        status: 'running', filesystemIncarnationId: 'fixture-incarnation', filesystemIncarnationProvenance: 'fresh',
        filesystemIncarnationReadiness: 'ready', connection: { runtimeUrl: `${baseUrl}/v1/sandboxes/fixture-box/runtime` } })
      if (path.endsWith('/runtime/agents/run/cancel')) {
        expect(JSON.parse(body)).toEqual({ executionId: 'execution-original', sessionId: 'session-original' })
        if (mode === 'retry-race') await store.patchMessageMetadata('user-row', {
          dispatchToken: 'dispatch-replacement', executionId: 'execution-replacement', run: { executionId: 'execution-replacement' } })
        if (mode === 'receipt-race') await store.patchMessageMetadata('user-row', { receipt: 'arrived' })
        return json({ success: ['cancel', 'retry-race', 'receipt-race'].includes(mode) }, ['cancel', 'retry-race', 'receipt-race'].includes(mode) ? 200 : 404)
      }
      if (path.endsWith('/runtime/agents/sessions/session-original')) {
        if (mode === 'null-status') return json({ error: 'not found' }, 404)
        return json({ id: mode === 'wrong-session' ? 'another-session' : 'session-original',
          status: mode === 'terminal' || mode === 'wrong-session' ? 'completed' : 'running',
          ...(mode === 'still-active' ? { activeExecutionId: 'execution-original' } : {}),
          ...(mode === 'another-execution' ? { activeExecutionId: 'another-execution' } : {}) })
      }
      return json({ error: 'unexpected request' }, 500)
    })().catch(error => { response.writeHead(500); response.end(String(error)) }) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const client = new Sandbox({ apiKey: 'local-fixture', baseUrl })
  const routes = createChatTurnRoutes({ projectId: 'cancel-boundary', store: store as unknown as ChatTurnMessageStore,
    turnStore: createMemoryTurnEventStore(), turnTrace: false,
    async authorize({ request, intent }) {
      expect(intent).toBe('cancel')
      const member = database.$client.prepare('SELECT user_id,role FROM member WHERE token=?')
        .get(request.headers.get('authorization')?.replace('Bearer ', '') ?? '') as { user_id: string; role: string } | undefined
      if (!member) return { ok: false as const, response: new Response(null, { status: 401 }) }
      if (member.role !== 'editor') return { ok: false as const, response: new Response(null, { status: 403 }) }
      return { ok: true as const, tenantId: 'workspace', userId: member.user_id, context: undefined }
    },
    produce: () => { throw new Error('Stop must never create a model producer') },
    cancel: { target: async () => {
      targetReads++
      const captured = (await store.getMessage('user-row'))!.metadata!
      const run = captured.run as typeof metadata.run
      return { capturedMetadata: captured, status: captured.responseStatus as string, dispatchToken: captured.dispatchToken as string,
        requiresDispatchToken: true, native: { ...run, source: () => client.get(run.sandboxId) },
        markStopped: async (snapshot, stoppedAt) => Boolean(await store.patchMessageMetadata('user-row',
          { responseStatus: 'stopped', stoppedAt }, { snapshot })) }
    } }, log: () => {},
  })
  const cancel = () => routes.cancel(new Request('https://app.test/chat/cancel', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mode === 'viewer' ? 'viewer-token' : mode === 'unauthenticated' ? 'unknown' : 'editor-token'}` },
    body: JSON.stringify({ threadId: 'thread', turnId: 'client-turn', cancellationToken: mode === 'wrong-token' ? 'old-dispatch' : 'dispatch-original' }),
  }))
  try {
    const response = await cancel()
    expect(response.status).toBe(status)
    const current = (await store.getMessage('user-row'))!.metadata!
    expect(current.responseStatus === 'stopped').toBe(stopped)
    expect(current.product).toEqual({ retained: true })
    if (['viewer', 'unauthenticated'].includes(mode)) expect(targetReads).toBe(0)
    if (['viewer', 'unauthenticated', 'wrong-token', 'pending', 'stopped', 'answered'].includes(mode)) expect(calls).toEqual([])
    if (mode === 'wrong-token') expect(await response.json()).toMatchObject({ code: 'CANCEL_TARGET_CHANGED' })
    if (mode === 'retry-race' || mode === 'receipt-race') {
      expect(await response.json()).toMatchObject({ code: 'CANCEL_STATE_CHANGED' })
      expect(current.responseStatus).toBe('streaming')
      if (mode === 'retry-race') expect(current.dispatchToken).toBe('dispatch-replacement')
      else expect(current.receipt).toBe('arrived')
    }
    if (mode === 'cancel') {
      expect(await response.json()).toEqual({ succeeded: true, sandboxInterrupted: true })
      const count = calls.length
      expect((await cancel()).status).toBe(200)
      expect(calls).toHaveLength(count)
      expect(calls.filter(call => call.path.endsWith('/agents/run/cancel'))).toHaveLength(1)
    }
    expect(calls.some(call => call.path.endsWith('/abort'))).toBe(false)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    database.$client.close()
  }
})
