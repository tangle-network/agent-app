import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { Sandbox } from '@tangle-network/sandbox'
import { expect, it } from 'vitest'
import { createHybridTurnProducer } from '../../src/chat-routes/hybrid-producer'
import { createChatTurnRoutes } from '../../src/chat-routes/turn-routes'
import { createChatTables } from '../../src/chat-store/schema'
import { createChatStore, type ChatDatabase } from '../../src/chat-store/store'
import { createD1TurnEventStore, TURN_EVENTS_MIGRATION_SQL } from '../../src/stream/index'
import { openDatabase } from '../teams/db-helper'
import { sqliteD1 } from '../launch-invariants/sqlite-d1'

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function close(server: Server) {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

/** Real Router and Sandbox HTTP protocols, SDK instances, engine, shared route,
 * SQLite transcript and event buffer. No model-quality or paid-service claim. */
it.each([
  { mode: 'plain', code: undefined },
  { mode: 'provision', code: 'sandbox_unavailable' },
  { mode: 'execution', code: 'sandbox_failed' },
  { mode: 'empty', code: 'sandbox_empty' },
  { mode: 'success', code: undefined },
] as const)('keeps Router answering and persists the typed computer warning: $mode', async ({ mode, code }) => {
  let modelCalls = 0
  let boxReads = 0
  let executions = 0
  const requests: Array<Record<string, unknown>> = []
  let baseUrl = ''
  const peer = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8').on('data', chunk => { body += chunk })
    request.on('end', () => {
      const path = new URL(request.url!, 'http://localhost').pathname
      const json = (value: unknown, status = 200) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
      if (path === '/v1/sandboxes/computer') {
        boxReads++
        if (mode === 'provision') return json({ code: 'COMPUTER_UNAVAILABLE', message: 'Fixture placement refused' }, 409)
        return json({ id: 'computer', status: 'running', filesystemIncarnationId: 'hybrid-fixture',
          filesystemIncarnationProvenance: 'fresh', filesystemIncarnationReadiness: 'ready',
          connection: { runtimeUrl: `${baseUrl}/v1/sandboxes/computer/runtime` } })
      }
      if (path.endsWith('/runtime/process/spawn')) {
        executions++
        if (mode === 'execution') return json({ code: 'EXECUTION_REFUSED', message: 'Fixture execution refused' }, 409)
        return json({ data: { exitCode: 0, stdout: mode === 'empty' ? '' : 'Computer answer', stderr: '' } })
      }
      requests.push(JSON.parse(body))
      const tool = ++modelCalls === 1 && mode !== 'plain'
      const delta = tool
        ? { tool_calls: [{ index: 0, id: 'computer-call', function: { name: 'sandbox_run', arguments: JSON.stringify({ task: 'Inspect the requested document.' }) } }] }
        : { content: 'Here is the available answer.' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ model: 'fixture/served', choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  baseUrl = await listen(peer)
  const client = new Sandbox({ apiKey: 'local-protocol-fixture', baseUrl })
  const tables = createChatTables()
  const chatDb = openDatabase([tables.threads, tables.messages])
  const store = createChatStore(chatDb as unknown as ChatDatabase, tables)
  const { sqlite, d1 } = sqliteD1(TURN_EVENTS_MIGRATION_SQL)
  await store.createThread({ id: 'thread', workspaceId: 'workspace' })
  const pending: Promise<unknown>[] = []
  const completions: string[] = []
  let draft: Array<Record<string, unknown>> = []
  const routes = createChatTurnRoutes({
    projectId: 'hybrid-fallback', store, turnStore: createD1TurnEventStore(d1), turnTrace: false,
    incrementalPersistence: false, log: () => {},
    authorize: async () => ({ ok: true as const, tenantId: 'workspace', userId: 'member', context: {} }),
    lifecycle: { onTurnComplete: () => { completions.push('complete') }, onTurnError: () => { completions.push('error') } },
    produce: async () => {
      const producer = createHybridTurnProducer({ apiKey: 'local-router-fixture', baseUrl, model: 'fixture/requested',
        systemPrompt: 'Answer with the tools available.', userMessage: 'Help me understand the document.',
        speculateOn: 'A question', box: {
          acquire: async () => {
            const box = await client.get('computer')
            if (!box) throw new Error('Computer absent')
            return box
          },
          runTask: async (box, task, { timeoutMs }) => (await box.exec(task, { timeoutMs })).stdout,
        },
      })
      return { ...producer, stream: (async function* () {
        for await (const event of producer.stream) {
          if (event.type === 'notice') draft = producer.draftParts!()
          yield event
        }
      })() }
    },
  })
  try {
    const response = await routes.turn(new Request('http://app.test/chat', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId: 'thread', content: 'Help me understand the document.' }) }),
    { waitUntil: promise => { pending.push(promise) } })
    const wire = await response.text()
    await Promise.all(pending)
    expect(wire).toContain('Here is the available answer.')
    expect(completions).toEqual(['complete'])
    const assistant = (await store.listMessages('thread')).find(message => message.role === 'assistant')!
    expect(assistant.content).toBe('Here is the available answer.')
    const parts = assistant.parts as Array<Record<string, unknown>>
    const warnings = parts.filter(part => part.type === 'notice')
    expect(warnings).toHaveLength(code ? 1 : 0)
    if (code) {
      expect(warnings[0]).toMatchObject({ noticeKind: 'warning', code })
      expect(wire).toContain(code)
      expect(draft.filter(part => part.type === 'notice')).toEqual(warnings)
      const messages = requests[1]!.messages as Array<{ role: string; content: string }>
      expect(messages.some(message => message.role === 'tool' && message.content.includes(code))).toBe(true)
    }
    expect(boxReads > 0).toBe(mode !== 'plain')
    expect(executions > 0).toBe(mode !== 'plain' && mode !== 'provision')
    expect(sqlite.prepare('SELECT status FROM turn_status').get()).toMatchObject({ status: 'complete' })
  } finally {
    chatDb.$client.close(); sqlite.close(); await close(peer)
  }
}, 20_000)

it('passes effective cancellation into real tool HTTP I/O and keeps cancellation terminal', async () => {
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let cancelled!: () => void
  const closed = new Promise<void>(resolve => { cancelled = resolve })
  let baseUrl = ''
  const peer = createServer((request, response) => {
    if (request.url === '/lookup') {
      response.on('close', () => { if (!response.writableEnded) cancelled() })
      entered()
      return
    }
    request.resume().on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'lookup-call', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  baseUrl = await listen(peer)
  const abort = new AbortController()
  const client = new Sandbox({ apiKey: 'local-protocol-fixture', baseUrl })
  const producer = createHybridTurnProducer({ apiKey: 'local-router-fixture', baseUrl, model: 'fixture/model', signal: abort.signal,
    systemPrompt: 'Look up the answer.', userMessage: 'A question',
    tools: [{ name: 'lookup', description: 'Read information', inputSchema: { type: 'object' },
      run: async (_args, context) => (await fetch(`${baseUrl}/lookup`, { signal: context.signal })).text() }],
    box: { acquire: async () => { const box = await client.get('computer'); if (!box) throw new Error('Missing'); return box },
      runTask: async (box, task, { timeoutMs }) => (await box.exec(task, { timeoutMs })).stdout },
  })
  const events: Array<{ type?: string; data?: unknown }> = []
  const drain = (async () => { for await (const event of producer.stream) events.push(event) })()
  try {
    await started
    abort.abort(new Error('Member cancelled'))
    await Promise.race([closed, delay(1_000).then(() => { throw new Error('Tool HTTP request did not observe cancellation') })])
    await drain
    expect(events.find(event => event.type === 'error')).toMatchObject({ data: { code: 'turn_aborted' } })
    expect(events.filter(event => event.type === 'notice')).toEqual([])
  } finally { await close(peer); await drain }
}, 5_000)
