import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { createChatTurnRoutes, type ChatTurnMessageStore } from '../../src/chat-routes/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import { createD1TurnTimingStore, ROLLOUT_TURN_TIMING_SCHEMA_SQL } from '../../src/rollout/d1'
import { sqliteD1 } from '../launch-invariants/sqlite-d1'

/** Actual Router HTTP, route settlement and canonical SQLite timing autofill. */
it.each(['echo', 'no-echo', 'failure'] as const)('records only a served model observation: %s', async mode => {
  const { sqlite, d1 } = sqliteD1(`${ROLLOUT_TURN_TIMING_SCHEMA_SQL}
    CREATE TABLE messages(id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, content TEXT);`)
  const timing = createD1TurnTimingStore({ db: d1 })
  const requested: string[] = []
  const peer = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8').on('data', chunk => { body += chunk }).on('end', () => {
      requested.push((JSON.parse(body) as { model: string }).model)
      if (mode === 'failure') {
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'Local provider unavailable' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ ...(mode === 'echo' ? { model: 'provider/actual' } : {}),
        choices: [{ index: 0, delta: { content: 'The answer.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve))
  const store: ChatTurnMessageStore = {
    async listMessages(threadId) {
      return sqlite.prepare('SELECT id, role, content FROM messages WHERE thread_id = ? ORDER BY rowid')
        .all(threadId) as Array<{ id: string; role: 'user' | 'assistant'; content: string }>
    },
    async appendMessage(input) {
      const id = input.id ?? crypto.randomUUID()
      sqlite.prepare('INSERT INTO messages VALUES (?, ?, ?, ?)').run(id, input.threadId, input.role, input.content)
      return { id }
    },
  }
  const pending: Promise<unknown>[] = []
  const record = async (turnId: string, failed: boolean, duration: number) => {
    // Intentionally omit model: the shared store must fill only observed facts.
    await timing.record({ rollout: 'model-attribution', workspaceId: 'workspace', lane: 'loop',
      turnId, failed, settledMs: duration }, { throwOnError: true })
  }
  const routes = createChatTurnRoutes({ projectId: 'router-model-timing', store,
    turnStore: createMemoryTurnEventStore(), turnTrace: false,
    authorize: async () => ({ ok: true as const, tenantId: 'workspace', userId: 'member', context: {} }),
    produce: { router: () => ({ apiKey: 'local-no-spend', model: 'requested/alias', repeat: false,
      baseUrl: `http://127.0.0.1:${(peer.address() as AddressInfo).port}`, systemPrompt: 'Answer the member.' }) },
    lifecycle: {
      onTurnComplete: info => record(info.turnStreamId, false, info.durationMs),
      onTurnError: info => record(info.turnStreamId, true, info.durationMs),
    },
  })
  try {
    const response = await routes.turn(new Request('https://app.test/chat', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId: 'thread', content: 'Answer.' }) }),
    { waitUntil: work => { pending.push(work) } })
    expect(response.status).toBe(200)
    const wire = await response.text()
    await Promise.all(pending)
    expect(requested).toEqual(['requested/alias'])
    const rows = sqlite.prepare('SELECT model, failed FROM rollout_turn_timing').all()
    expect(rows).toEqual([{ model: mode === 'echo' ? 'provider/actual' : null, failed: mode === 'failure' ? 1 : 0 }])
    expect(wire).toContain(mode === 'failure' ? 'error' : 'The answer.')
  } finally {
    peer.closeAllConnections()
    await new Promise<void>((resolve, reject) => peer.close(error => error ? reject(error) : resolve()))
    sqlite.close()
  }
})
