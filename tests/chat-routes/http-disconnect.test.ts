/**
 * Real HTTP on both sides of the composed route, with actual SQLite storage.
 * Node proves route draining after an HTTP disconnect. It does not reproduce
 * or certify Cloudflare's post-disconnect waitUntil lifetime limit.
 */
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { createChatTurnRoutes, createRouterTurnProducer, type ChatTurnMessageStore } from '../../src/chat-routes/index'
import { createD1TurnEventStore, TURN_EVENTS_MIGRATION_SQL } from '../../src/stream/index'
import { buildTurnTraceOtelSpans, type TurnTraceSnapshot } from '../../src/turn-trace/index'
import { sqliteD1 } from '../launch-invariants/sqlite-d1'

const AFTER_DISCONNECT_MS = 31_000
async function within<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`HTTP disconnect fixture exceeded ${timeoutMs}ms`)), timeoutMs)
    })])
  } finally {
    clearTimeout(timer)
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

it('settles a SQLite-backed turn once when the browser disconnects 31 seconds before Router completion', async () => {
  const { d1, sqlite } = sqliteD1(TURN_EVENTS_MIGRATION_SQL + `
    CREATE TABLE messages (id INTEGER PRIMARY KEY, threadId TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL);
    CREATE TABLE terminal_writes (turnId TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TRIGGER record_terminal_update AFTER UPDATE OF status ON turn_status
      WHEN NEW.status IN ('complete', 'error')
      BEGIN INSERT INTO terminal_writes VALUES (NEW.turnId, NEW.status); END;
  `)
  const messageStore: ChatTurnMessageStore = {
    async listMessages(threadId) {
      return sqlite.prepare('SELECT CAST(id AS TEXT) AS id, role, content FROM messages WHERE threadId = ? ORDER BY id')
        .all(threadId) as Awaited<ReturnType<ChatTurnMessageStore['listMessages']>>
    },
    async appendMessage(input) {
      const result = sqlite.prepare('INSERT INTO messages (threadId, role, content) VALUES (?, ?, ?)')
        .run(input.threadId, input.role, input.content)
      return { id: String(result.lastInsertRowid) }
    },
  }
  const fixtureAbort = new AbortController()
  const disconnected = deferred<number>()
  const routerFinished = deferred<number>()
  const pending: Promise<unknown>[] = []
  const bridgeTasks: Promise<void>[] = []
  const snapshots: TurnTraceSnapshot[] = []
  const completions: Array<{ firstVisibleMs?: number; firstTextMs?: number }> = []
  const lifecycle: string[] = []
  let completionEffects = 0
  let modelCalls = 0
  let turnId: string | undefined
  let requestAborted = false
  const router = createServer((incoming, outgoing) => {
    incoming.resume()
    incoming.on('end', () => {
      modelCalls += 1
      const task = (async () => {
        const frame = (delta: Record<string, unknown>) => `data: ${JSON.stringify({ model: 'socket-model', choices: [{ index: 0, delta }] })}\n\n`
        outgoing.writeHead(200, { 'content-type': 'text/event-stream' })
        outgoing.write(frame({ role: 'assistant', reasoning_content: 'The browser can see this thought.' }))
        await disconnected.promise
        await sleep(AFTER_DISCONNECT_MS, undefined, { signal: fixtureAbort.signal })
        outgoing.write(frame({ content: 'The completed answer survives the closed browser.' }))
        outgoing.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
        outgoing.end('data: [DONE]\n\n')
        routerFinished.resolve(Date.now())
      })()
      bridgeTasks.push(task)
      void task.catch(() => {}) // Observed again below; avoid an early unhandled rejection.
    })
  })
  let app: Server | undefined
  try {
    const routerUrl = await listen(router)
    const routes = createChatTurnRoutes({
      projectId: 'http-disconnect',
      authorize: async () => ({ ok: true as const, tenantId: 'workspace', userId: 'user', context: {} }),
      store: messageStore,
      turnStore: createD1TurnEventStore(d1),

      log: () => {},
      lifecycle: {
        onTurnStart: () => { lifecycle.push('start') },
        onTurnComplete: info => { lifecycle.push('complete'); completions.push(info) },
        onTurnError: () => { lifecycle.push('error') },
      },
      onTurnComplete: async () => { completionEffects += 1 },
      turnTrace: { sink: snapshot => { snapshots.push(snapshot) } },
      produce: ({ trace }) => createRouterTurnProducer({
        apiKey: 'integration-only-key', model: 'socket-model', baseUrl: routerUrl,
        systemPrompt: 'Return the deterministic socket response.', userMessage: 'Keep working.', trace,
      }),
    })
    app = createServer((incoming, outgoing) => {
      const task = (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
        const controller = new AbortController()
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
        outgoing.once('close', () => {
          if (outgoing.writableFinished) return
          requestAborted = true
          controller.abort(new Error('Browser HTTP socket closed'))
          disconnected.resolve(Date.now())
          // Stop forwarding without awaiting tee cancellation, which waits for
          // the independent producer drain to finish.
          void reader?.cancel().catch(() => {})
        })
        const response = await routes.turn(new Request('http://app.test/api/chat', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: Buffer.concat(chunks).toString('utf8'), signal: controller.signal,
        }), {
          waitUntil: work => { pending.push(work) },
          cancelOnDisconnect: false,
        })
        turnId = response.headers.get('x-turn-id') ?? undefined
        outgoing.writeHead(response.status, Object.fromEntries(response.headers))
        reader = response.body!.getReader()
        try {
          for (;;) {
            const next = await reader.read()
            if (next.done || outgoing.destroyed) break
            outgoing.write(next.value)
          }
          if (!outgoing.destroyed) outgoing.end()
        } finally {
          reader.releaseLock()
        }
      })()
      bridgeTasks.push(task)
      void task.catch(error => { outgoing.destroy(error instanceof Error ? error : new Error(String(error))) })
    })
    const appUrl = await listen(app)
    const browserText = await within(new Promise<string>((resolve, reject) => {
      const browser = httpRequest(appUrl, { method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
        let text = ''
        response.on('data', chunk => {
          text += String(chunk)
          if (!text.includes('The browser can see this thought.')) return
          response.destroy()
          browser.destroy()
          resolve(text)
        })
        response.on('error', error => { if (!text.includes('The browser can see this thought.')) reject(error) })
        response.on('end', () => { if (!text.includes('The browser can see this thought.')) reject(new Error('No reasoning reached the HTTP client')) })
      })
      browser.on('error', reject)
      browser.end(JSON.stringify({ threadId: 'thread-disconnected', content: 'Keep working.' }))
    }), 5_000)
    expect(browserText).toContain('The browser can see this thought.')
    expect(browserText).not.toContain('The completed answer')
    const disconnectedAt = await within(disconnected.promise, 5_000)
    const finishedAt = await within(routerFinished.promise, 40_000)
    expect(finishedAt - disconnectedAt).toBeGreaterThanOrEqual(AFTER_DISCONNECT_MS)
    // Progress-first admission can register another drain while its pump is
    // pending, so include every promise it hands to the host.
    for (let awaited = 0; awaited < pending.length;) {
      awaited = pending.length
      await within(Promise.all(pending.slice(0, awaited)), 10_000)
    }
    await within(Promise.all(bridgeTasks), 10_000)
    expect(requestAborted).toBe(true)
    expect(modelCalls).toBe(1)
    expect(turnId).toBeTruthy()
    expect(sqlite.prepare('SELECT role, content FROM messages ORDER BY id').all()).toEqual([
      { role: 'user', content: 'Keep working.' },
      { role: 'assistant', content: 'The completed answer survives the closed browser.' },
    ])
    expect(sqlite.prepare('SELECT status FROM turn_status WHERE turnId = ?').get(turnId)).toEqual({ status: 'complete' })
    expect(sqlite.prepare('SELECT status FROM terminal_writes WHERE turnId = ?').all(turnId)).toEqual([{ status: 'complete' }])
    expect(lifecycle).toEqual(['start', 'complete'])
    expect(completionEffects).toBe(1)
    expect(completions).toHaveLength(1)
    expect(completions[0]!.firstVisibleMs).toBeGreaterThanOrEqual(0)
    expect(completions[0]!.firstTextMs! - completions[0]!.firstVisibleMs!).toBeGreaterThanOrEqual(AFTER_DISCONNECT_MS)
    expect(snapshots).toHaveLength(1)
    const snapshot = snapshots[0]!
    expect(snapshot.status).toBe('ok')
    const root = buildTurnTraceOtelSpans(snapshot)[0]!
    expect(root.attributes.find(attr => attr.key === 'tangle.turn.first_visible_ms')?.value)
      .toEqual({ doubleValue: snapshot.summary.firstVisibleMs })
    expect(root.attributes.find(attr => attr.key === 'tangle.turn.first_text_ms')?.value)
      .toEqual({ doubleValue: snapshot.summary.firstTextMs })
    expect(snapshot.summary.firstTextMs! - snapshot.summary.firstVisibleMs!).toBeGreaterThanOrEqual(AFTER_DISCONNECT_MS)
  } finally {
    // Unblock cleanup even if admission or the client assertion fails early.
    disconnected.resolve(Date.now())
    fixtureAbort.abort()
    if (app) await close(app)
    await close(router)
    await within(Promise.allSettled(bridgeTasks), 2_000).catch(() => {})
    await within(Promise.allSettled(pending), 2_000).catch(() => {})
    sqlite.close()
  }
}, 60_000)
