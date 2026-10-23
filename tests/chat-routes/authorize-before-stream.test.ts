/** Incident gate: real HTTP identity/model boundaries and SQLite effects, for both stream modes. */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { createChatTurnRoutes, TURN_PROGRESS_FIRST, TURN_PROGRESS_HEADER, type ChatTurnMessageStore } from '../../src/chat-routes/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'

for (const progress of [false, true]) {
  for (const refusal of ['identity', 'model-policy']) {
    it(`refuses ${refusal} before opening ${progress ? 'progress-first' : 'ordinary'} output or effects`, async () => {
      const sqlite = new DatabaseSync(':memory:')
      sqlite.exec('CREATE TABLE messages(id TEXT PRIMARY KEY, role TEXT, content TEXT); CREATE TABLE effects(kind TEXT)')
      const requests: string[] = []
      const service = createServer((request, response) => {
        requests.push(request.url!)
        request.resume()
        request.on('end', () => {
          if (request.url === '/identity') {
            response.writeHead(refusal === 'identity' ? 401 : 200, { 'content-type': 'application/json' })
              .end(JSON.stringify({ userId: 'member', tenantId: 'workspace' }))
          } else response.end('A model answer must never be requested for a refused turn.')
        })
      })
      await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve))
      const origin = `http://127.0.0.1:${(service.address() as AddressInfo).port}`
      const store: ChatTurnMessageStore = {
        async listMessages() { return sqlite.prepare('SELECT id,role,content FROM messages').all() as Awaited<ReturnType<ChatTurnMessageStore['listMessages']>> },
        async appendMessage(input) {
          const id = crypto.randomUUID()
          sqlite.prepare('INSERT INTO messages VALUES (?,?,?)').run(id, input.role, input.content)
          return { id }
        },
      }
      const pending: Promise<unknown>[] = []
      const routes = createChatTurnRoutes({
        projectId: 'authorize-gate', store, turnStore: createMemoryTurnEventStore(),
        authorize: async () => {
          const identity = await fetch(`${origin}/identity`)
          if (!identity.ok) return { ok: false as const, response: Response.json({ error: 'unauthorized' }, { status: 401 }) }
          return { ok: true as const, ...await identity.json() as { userId: string; tenantId: string }, context: {} }
        },
        modelPolicy: { catalog: [], filter: () => true },
        afterAuthorize: () => { sqlite.prepare('INSERT INTO effects VALUES (?)').run('after-authorize') },
        prepareTurn: async () => { sqlite.prepare('INSERT INTO effects VALUES (?)').run('prepare'); return { ok: true as const } },
        produce: { router: async () => {
          const text = await fetch(`${origin}/model`).then(response => response.text())
          return { stream: (async function* () { yield { type: 'text' as const, text } })(), finalText: () => text }
        } },
        log: () => {},
      })
      try {
        const response = await routes.turn(new Request('http://app.test/chat', {
          method: 'POST', headers: { 'content-type': 'application/json', ...(progress ? { [TURN_PROGRESS_HEADER]: TURN_PROGRESS_FIRST } : {}) },
          body: JSON.stringify({ threadId: 'thread', content: 'Answer once.', model: 'unclassified-model' }),
        }), { waitUntil: work => { pending.push(work) } })
        expect(response.status).toBe(refusal === 'identity' ? 401 : 403)
        expect(response.headers.get('content-type')).toContain('application/json')
        expect(await response.text()).not.toContain('session.run.phase')
        await Promise.all(pending)
        expect(requests).toEqual(['/identity'])
        expect(sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n).toBe(0)
        expect(sqlite.prepare('SELECT COUNT(*) AS n FROM effects').get()?.n).toBe(0)
      } finally {
        service.closeAllConnections()
        await new Promise<void>((resolve, reject) => service.close(error => error ? reject(error) : resolve()))
        sqlite.close()
      }
    })
  }
}
