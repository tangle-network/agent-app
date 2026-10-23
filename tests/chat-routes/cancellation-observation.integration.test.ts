import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { createChatTurnRoutes, type ChatTurnMessageStore } from '../../src/chat-routes/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'

/** Real HTTP model transport, SQLite canonical Stop state and assistant draft storage. */
async function observationFixture(constructionHeld = false, iteratorCleanup = false) {
  const sql = new DatabaseSync(':memory:')
  sql.exec(`CREATE TABLE message(id TEXT PRIMARY KEY,thread TEXT,role TEXT,content TEXT);
    CREATE TABLE turn_state(status TEXT); INSERT INTO turn_state VALUES ('running');
    CREATE TABLE retired(id TEXT);`)
  let sawDraft!: () => void, sawRequest!: () => void, finishHttp!: () => void, sawRetirement!: () => void, finishRetirement: (() => void) | undefined
  const draftWritten = new Promise<void>(resolve => { sawDraft = resolve })
  const httpStarted = new Promise<void>(resolve => { sawRequest = resolve })
  const retirementStarted = new Promise<void>(resolve => { sawRetirement = resolve })
  const pending: Promise<unknown>[] = [], signals: AbortSignal[] = []
  let sourceClosed = 0, reads = 0, releaseLate!: () => void
  const late = new Promise<void>(resolve => { releaseLate = resolve })
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      if (request.method === 'DELETE' && request.url === '/retire') {
        finishRetirement = () => {
          sql.prepare('INSERT INTO retired VALUES (?)').run('iterator-finally')
          response.end('retired')
        }
        sawRetirement()
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.flushHeaders()
      if (!constructionHeld) response.write('Draft answer.')
      finishHttp = () => response.end(' Finished answer.')
      sawRequest()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const store: ChatTurnMessageStore = {
    async listMessages(thread) {
      return sql.prepare('SELECT id,role,content FROM message WHERE thread=? ORDER BY rowid').all(thread)
        .map(row => ({ id: String(row.id), role: row.role as 'user' | 'assistant', content: String(row.content) }))
    },
    async appendMessage(input) {
      const id = input.id ?? crypto.randomUUID()
      sql.prepare('INSERT INTO message VALUES (?,?,?,?)').run(id, input.threadId, input.role, input.content)
      if (input.role === 'assistant') sawDraft()
      return { id }
    },
    async updateMessage(id, input) { sql.prepare('UPDATE message SET content=? WHERE id=?').run(input.content ?? '', id) },
    async deleteMessage(id) { sql.prepare('DELETE FROM message WHERE id=?').run(id) },
  }
  const routes = createChatTurnRoutes({
    projectId: 'stop-observation', store, turnStore: createMemoryTurnEventStore(), turnTrace: false,
    authorize: async () => ({ ok: true as const, tenantId: 'workspace', userId: 'member', context: {} }),
    cancel: { async target(args) {
      expect(args.messageId).toBeTruthy()
      expect(sql.prepare("SELECT id FROM message WHERE id=? AND role='user'").get(args.messageId!)).toBeTruthy()
      reads++
      return { capturedMetadata: {}, status: String(sql.prepare('SELECT status FROM turn_state').get()?.status),
        requiresDispatchToken: false,
        async markStopped() { throw new Error('Observation must never write Stop') },
        native: { state: 'running', async source() { throw new Error('Observation must never resolve native authority') } },
      }
    } },
    produce: async args => {
      signals.push(args.admissionSignal!)
      const response = await fetch(origin, { signal: args.admissionSignal })
      const cleanup = constructionHeld ? new Promise<void>(resolve => {
        args.admissionSignal?.addEventListener('abort', () => {
          void late.then(() => { sql.prepare('INSERT INTO retired VALUES (?)').run('late-producer'); resolve() })
        }, { once: true })
      }) : undefined
      if (constructionHeld) await late
      let text = ''
      const reader = response.body!.getReader()
      return {
        cleanup,
        stream: (async function* () {
          try {
            for (;;) {
              const next = await reader.read()
              if (next.done) return
              const delta = new TextDecoder().decode(next.value)
              text += delta
              yield { type: 'text' as const, text: delta }
            }
          } finally {
            sourceClosed++
            await reader.cancel().catch(() => {})
            if (iteratorCleanup) await fetch(`${origin}/retire`, { method: 'DELETE' })
          }
        })(),
        finalText: () => text || 'A retained producer projection must never escape Stop.',
        assistantParts: () => [{ type: 'text', text: text || 'Retained part.' }],
      }
    },
    log: () => {},
  })
  return {
    sql, pending, signals, draftWritten, httpStarted, retirementStarted, releaseLate,
    releaseRetirement: () => finishRetirement?.(),
    finish: () => finishHttp(), reads: () => reads, sourceClosed: () => sourceClosed,
    setStatus: (status: string) => { sql.prepare('UPDATE turn_state SET status=?').run(status) },
    send: () => routes.turn(new Request('http://app.test/chat', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId: 'thread', turnId: 'client-turn', content: 'Answer.' }) }),
      { waitUntil: promise => { pending.push(promise) } }),
    async close() {
      releaseLate(); finishHttp?.(); finishRetirement?.()
      await Promise.all(pending)
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      sql.close()
    },
  }
}

it.each(['stopped', 'superseded'])('rechecks a fast terminal HTTP response and retracts its SQLite draft when canonical state is %s', async status => {
  const h = await observationFixture()
  try {
    const response = await h.send()
    const body = response.text()
    await h.httpStarted
    await h.draftWritten
    expect(h.sql.prepare("SELECT COUNT(*) AS n FROM message WHERE role='assistant'").get()?.n).toBe(1)
    // No timer is advanced: completion follows Stop immediately, before the next one-second poll.
    h.setStatus(status)
    h.finish()
    await body
    await Promise.all(h.pending)
    expect(h.reads()).toBeGreaterThanOrEqual(2)
    expect(h.signals[0].aborted).toBe(true)
    expect(h.sql.prepare('SELECT role FROM message').all()).toEqual([{ role: 'user' }])
    expect(h.sourceClosed()).toBe(1)
  } finally { await h.close() }
}, 10_000)

it('observes Stop during ordinary async construction and tracks late producer cleanup on the actual request host', async () => {
  const h = await observationFixture(true)
  try {
    const response = await h.send()
    const body = response.text()
    await h.httpStarted
    h.setStatus('stopped')
    await body
    expect(h.signals[0].aborted).toBe(true)
    let settled = false
    const cleanup = Promise.all(h.pending).then(() => { settled = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    h.releaseLate()
    await cleanup
    expect(h.sql.prepare('SELECT * FROM retired').all()).toEqual([{ id: 'late-producer' }])
    expect(h.sql.prepare('SELECT role FROM message').all()).toEqual([{ role: 'user' }])
  } finally { await h.close() }
}, 10_000)


it('retains a generic source iterator finally on the actual host while its real HTTP retirement is still pending', async () => {
  const h = await observationFixture(false, true)
  try {
    const response = await h.send()
    const body = response.text()
    await h.draftWritten
    h.setStatus('stopped')
    await h.retirementStarted
    await body
    expect(h.signals[0].aborted).toBe(true)
    let settled = false
    const continuations = Promise.all(h.pending).then(() => { settled = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    // This producer declares NO cleanup promise. Only the observer's retained
    // iterator.return can keep its still-running finally attached to this host.
    expect(settled).toBe(false)
    expect(h.sql.prepare('SELECT * FROM retired').all()).toEqual([])
    h.releaseRetirement()
    await continuations
    expect(h.sql.prepare('SELECT * FROM retired').all()).toEqual([{ id: 'iterator-finally' }])
    expect(h.sourceClosed()).toBe(1)
    expect(h.sql.prepare('SELECT role FROM message').all()).toEqual([{ role: 'user' }])
  } finally { await h.close() }
}, 10_000)
