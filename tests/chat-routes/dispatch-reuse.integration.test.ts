import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { createChatTurnRoutes, type ChatTurnMessageStore } from '../../src/chat-routes/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'

it('dispatches a fresh turn before its lock and refuses an answered retry without another model request', async () => {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE message(id TEXT PRIMARY KEY, role TEXT, content TEXT, parts TEXT, answered INTEGER DEFAULT 0)')
  const store: ChatTurnMessageStore = {
    async listMessages() {
      return database.prepare('SELECT id,role,content,parts FROM message ORDER BY rowid').all().map(row => ({
        id: String(row.id), role: row.role as 'user' | 'assistant', content: String(row.content),
        parts: row.parts ? JSON.parse(String(row.parts)) : null,
      }))
    },
    async appendMessage(input) {
      const id = crypto.randomUUID()
      database.prepare('INSERT INTO message(id,role,content,parts) VALUES (?,?,?,?)')
        .run(id, input.role, input.content, JSON.stringify(input.parts ?? null))
      return { id }
    },
  }
  let requests = 0
  let acquisitions = 0
  const requestStarts: Array<() => void> = []
  const modelStarted = (number: number) => requests >= number ? Promise.resolve()
    : new Promise<void>(resolve => { requestStarts[number - 1] = resolve })
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => { requests++; requestStarts[requests - 1]?.(); response.end('A persisted answer.') })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const policyRows: Array<{ id: string | undefined | null; inserted: boolean | undefined }> = []
  const pending: Promise<unknown>[] = []
  const routes = createChatTurnRoutes({
    projectId: 'dispatch-reuse', store, turnStore: createMemoryTurnEventStore(), incrementalPersistence: false,
    authorize: async () => ({ ok: true as const, tenantId: 'workspace', userId: 'member', context: {} }),
    dispatchFirst: { billing: 'model-service', when: args => {
      policyRows.push({ id: args.userMessageId, inserted: args.userMessageInserted })
      return !args.userMessageId
    } },
    turnLock: {
      acquire: async args => {
        const attempt = ++acquisitions
        if (!args.userMessageId) await modelStarted(attempt)
        return { acquired: true as const, handle: args.identity.sessionId }
      },
      release: () => {},
    },
    contextGate: args => {
      const row = database.prepare('SELECT answered FROM message WHERE id=?').get(args.userMessageId ?? '')
      return row?.answered === 1
        ? { proceed: false as const, response: Response.json({ error: 'already answered' }, { status: 409 }) }
        : { proceed: true as const }
    },
    produce: async () => {
      const text = await fetch(origin).then(response => response.text())
      return { stream: (async function* () { yield { type: 'text' as const, text } })(), finalText: () => text }
    },
    log: () => {},
  })
  const send = () => routes.turn(new Request('http://app.test/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ threadId: 'thread', turnId: 'same-client-turn', content: 'Answer once.' }),
  }), { waitUntil: promise => { pending.push(promise) } })
  try {
    const first = await send()
    expect(first.status).toBe(200)
    expect(await first.text()).toContain('A persisted answer.')
    await Promise.all(pending)
    database.prepare("UPDATE message SET answered=1 WHERE role='user'").run()
    const user = database.prepare("SELECT id FROM message WHERE role='user'").get()!
    const retry = await send()
    expect(retry.status).toBe(409)
    expect(await retry.json()).toEqual({ error: 'already answered' })
    await Promise.all(pending)
    expect(requests, 'HTTP model requests').toBe(1)
    expect(policyRows).toEqual([{ id: undefined, inserted: undefined }, { id: user.id, inserted: false }])
    expect(database.prepare('SELECT role,content FROM message ORDER BY rowid').all()).toEqual([
      { role: 'user', content: 'Answer once.' }, { role: 'assistant', content: 'A persisted answer.' },
    ])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    database.close()
  }
})
