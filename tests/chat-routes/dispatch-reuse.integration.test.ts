import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { createChatTurnRoutes, type ChatTurnMessageStore, type ChatTurnProduceArgs, type ChatTurnRequestContext } from '../../src/chat-routes/index'
import { createMemoryTurnEventStore, TURN_EVENTS_MIGRATION_SQL } from '../../src/stream/index'
import { createMemoryTurnStreamHarness, MEMORY_TURN_STREAM_AUTH_SECRET } from '../../src/turn-stream/memory'
import { sqliteD1 } from '../launch-invariants/sqlite-d1'

async function harness(options: { backend?: 'router' | 'sandbox' | 'function'; refuse?: 'authorize' | 'gate'; concurrent?: boolean; bindings?: boolean; customLock?: boolean; resource?: 'late' | 'normal' | 'throw' } = {}) {
  const database = new DatabaseSync(':memory:')
  database.exec(`
    CREATE TABLE message(id TEXT PRIMARY KEY, thread TEXT, role TEXT, content TEXT, parts TEXT, answered INTEGER DEFAULT 0);
    CREATE TABLE active_lock(thread TEXT PRIMARY KEY);
    CREATE TABLE effect(user_message TEXT PRIMARY KEY);
    CREATE TABLE resource_disposal(resource TEXT);
  `)
  const store: ChatTurnMessageStore = {
    async listMessages(threadId) {
      return database.prepare('SELECT id,role,content,parts FROM message WHERE thread=? ORDER BY rowid').all(threadId).map(row => ({
        id: String(row.id), role: row.role as 'user' | 'assistant', content: String(row.content),
        parts: row.parts ? JSON.parse(String(row.parts)) : null,
      }))
    },
    async appendMessage(input) {
      const id = crypto.randomUUID()
      database.prepare('INSERT INTO message(id,thread,role,content,parts) VALUES (?,?,?,?,?)')
        .run(id, input.threadId, input.role, input.content, JSON.stringify(input.parts ?? null))
      return { id }
    },
  }
  const durable = options.bindings ? sqliteD1(TURN_EVENTS_MIGRATION_SQL) : undefined
  const namespace = createMemoryTurnStreamHarness().namespace
  const forwardContinuation = (phase: string, args: { waitUntil?: ChatTurnRequestContext['waitUntil'] }) => {
    args.waitUntil?.(Promise.resolve(`seam:${phase}`))
  }
  let requests = 0
  let acquired = 0
  let gates = 0
  const signals: AbortSignal[] = []
  const refusals: unknown[] = []
  const seen: Array<{ id: string | null | undefined; admitted: boolean; locked: boolean; gates: number }> = []
  const requestStarts: Array<() => void> = []
  const modelStarted = (number: number) => requests >= number ? Promise.resolve()
    : new Promise<void>(resolve => { requestStarts[number - 1] = resolve })
  let resourceReady!: () => void
  const resourceStarted = new Promise<void>(resolve => { resourceReady = resolve })
  let releaseResource: (() => void) | undefined
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      if (request.url === '/resource') {
        let finished = false
        const finish = () => {
          if (finished) return
          finished = true
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'resource-1' }))
        }
        releaseResource = finish
        resourceReady()
        if (options.resource !== 'late') finish()
      } else if (request.method === 'DELETE') {
        database.prepare('INSERT INTO resource_disposal VALUES (?)').run(request.url!)
        response.end('disposed')
      } else {
        requests++; requestStarts[requests - 1]?.(); response.end('A persisted answer.')
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const pending: Promise<unknown>[] = []
  const produce = async (args: ChatTurnProduceArgs<Record<string, never>>) => {
    forwardContinuation('produce', args)
    if (args.earlyResource) {
      await args.earlyResource
      expect(database.prepare('SELECT COUNT(*) AS n FROM resource_disposal').get()?.n).toBe(0)
    }
    seen.push({ id: args.userMessageId, admitted: Boolean(args.admitted),
      locked: Boolean(database.prepare('SELECT thread FROM active_lock').get()), gates })
    if (args.admissionSignal) signals.push(args.admissionSignal)
    void args.admitted?.catch(error => { refusals.push(error) })
    const text = await fetch(origin, { signal: args.admissionSignal }).then(response => response.text())
    return {
      stream: (async function* () {
        yield { type: 'text' as const, text }
        // The real model call can finish early; durable work still awaits the committed row.
        const final = args.admitted ? await args.admitted : args
        database.prepare('INSERT INTO effect VALUES (?)').run(final.userMessageId!)
        if (options.resource === 'throw') throw new Error('stream ended with a real acquisition still owned')
      })(),
      finalText: () => text,
    }
  }
  const routes = createChatTurnRoutes({
    projectId: 'dispatch-reuse', store, turnTrace: false,
    turnStore: durable ? { db: durable.d1, lock: { namespace, auth: { secret: MEMORY_TURN_STREAM_AUTH_SECRET } } } : createMemoryTurnEventStore(),
    authorize: async args => {
      forwardContinuation('authorize', args)
      return options.refuse === 'authorize'
      ? { ok: false as const, response: Response.json({ error: 'unauthorized' }, { status: 401 }) }
      : { ok: true as const, tenantId: 'workspace', userId: 'member', context: {} }
    },
    afterAuthorize: args => {
      forwardContinuation('afterAuthorize', args)
      if (options.resource) return {
        resource: fetch(`${origin}/resource`).then(async response => await response.json() as { id: string }),
        async dispose(resource: { id: string }) {
          const response = await fetch(`${origin}/resource/${resource.id}`, { method: 'DELETE' })
          if (!response.ok) throw new Error('resource disposal failed')
        },
      }
    },
    prepareTurn: async args => { forwardContinuation('prepareTurn', args); return { ok: true as const } },
    turnLock: durable && !options.customLock ? undefined : {
      acquire: async args => {
        if (!args.userMessageId && (options.backend ?? 'router') === 'router') {
          await modelStarted(options.concurrent ? 2 : 1)
        }
        const locked = database.prepare('INSERT OR IGNORE INTO active_lock VALUES (?)').run(args.identity.sessionId)
        if (!locked.changes) return { acquired: false as const, response: Response.json({ error: 'busy' }, { status: 409 }) }
        acquired++
        return { acquired: true as const, handle: args.identity.sessionId }
      },
      release: handle => { database.prepare('DELETE FROM active_lock WHERE thread=?').run(String(handle)) },
    },
    contextGate: async args => {
      if (durable && options.concurrent) await modelStarted(2)
      gates++
      const row = database.prepare('SELECT answered FROM message WHERE id=?').get(args.userMessageId ?? '')
      if (row?.answered === 1) return { proceed: false as const, response: Response.json({ error: 'already answered' }, { status: 409 }) }
      return options.refuse === 'gate'
        ? { proceed: false as const, response: Response.json({ error: 'gate refused' }, { status: 402 }) }
        : { proceed: true as const }
    },
    produce: options.backend === 'function' ? produce : {
      router: produce,
      when: () => options.backend !== 'sandbox',
      sandbox: produce,
    },
    log: () => {},
  })
  return {
    database, signals, refusals, seen, pending, durable, resourceStarted, releaseResource: () => releaseResource?.(),
    requests: () => requests, acquired: () => acquired,
    send: (turnId = 'same-client-turn', ctx?: ChatTurnRequestContext, threadId = 'thread') => routes.turn(new Request('http://app.test/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId, turnId, content: 'Answer once.' }),
    }), ctx ?? { waitUntil: promise => { pending.push(promise) } }),
    async close() {
      releaseResource?.()
      await Promise.all(pending)
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      database.close()
      durable?.sqlite.close()
    },
  }
}

it('dispatches the default Router backend before the lock and refuses an answered retry without another model request', async () => {
  const h = await harness()
  try {
    const first = await h.send()
    expect(first.status).toBe(200)
    expect(await first.text()).toContain('A persisted answer.')
    await Promise.all(h.pending)
    h.database.prepare("UPDATE message SET answered=1 WHERE role='user'").run()
    const retry = await h.send()
    expect(retry.status).toBe(409)
    expect(await retry.json()).toEqual({ error: 'already answered' })
    await Promise.all(h.pending)
    expect(h.requests(), 'HTTP model requests').toBe(1)
    expect(h.seen).toEqual([{ id: undefined, admitted: true, locked: false, gates: 0 }])
    expect(h.database.prepare('SELECT role,content FROM message ORDER BY rowid').all()).toEqual([
      { role: 'user', content: 'Answer once.' }, { role: 'assistant', content: 'A persisted answer.' },
    ])
    expect(h.database.prepare('SELECT COUNT(*) AS n FROM effect').get()?.n).toBe(1)
  } finally { await h.close() }
})

it('refuses authorization without starting the Router, lock or durable work', async () => {
  const h = await harness({ refuse: 'authorize' })
  try {
    expect((await h.send()).status).toBe(401)
    expect(h.requests()).toBe(0)
    expect(h.acquired()).toBe(0)
    expect(h.database.prepare('SELECT COUNT(*) AS n FROM message').get()?.n).toBe(0)
    expect(h.database.prepare('SELECT COUNT(*) AS n FROM effect').get()?.n).toBe(0)
  } finally { await h.close() }
})

it('cancels a gate-refused Router call and discards its answer without a durable effect', async () => {
  const h = await harness({ refuse: 'gate' })
  try {
    const response = await h.send()
    expect(response.status).toBe(402)
    expect(await response.text()).not.toContain('A persisted answer.')
    expect(h.requests()).toBe(1)
    expect(h.signals[0]?.aborted).toBe(true)
    expect(h.refusals).toHaveLength(1)
    expect(h.database.prepare('SELECT role FROM message').all()).toEqual([{ role: 'user' }])
    expect(h.database.prepare('SELECT COUNT(*) AS n FROM effect').get()?.n).toBe(0)
    expect(h.database.prepare('SELECT COUNT(*) AS n FROM active_lock').get()?.n).toBe(0)
  } finally { await h.close() }
})

it('keeps one assistant and one durable effect when fresh Router sends contend for the SQLite lock', async () => {
  const h = await harness({ concurrent: true })
  try {
    const responses = await Promise.all([h.send(), h.send()])
    expect(responses.map(response => response.status).sort()).toEqual([200, 409])
    const bodies = await Promise.all(responses.map(response => response.text()))
    expect(bodies.filter(body => body.includes('A persisted answer.'))).toHaveLength(1)
    await Promise.all(h.pending)
    expect(h.requests()).toBe(2)
    expect(h.acquired()).toBe(1)
    expect(h.signals.filter(signal => signal.aborted)).toHaveLength(1)
    expect(h.database.prepare('SELECT role FROM message ORDER BY rowid').all()).toEqual([{ role: 'user' }, { role: 'assistant' }])
    expect(h.database.prepare('SELECT COUNT(*) AS n FROM effect').get()?.n).toBe(1)
  } finally { await h.close() }
})

for (const backend of ['sandbox', 'function'] as const) {
  it(`starts a ${backend} producer only after the lock, user row and gate commit`, async () => {
    const h = await harness({ backend })
    try {
      const response = await h.send()
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('A persisted answer.')
      expect(h.seen).toEqual([{ id: expect.any(String), admitted: false, locked: true, gates: 1 }])
      expect(h.requests()).toBe(1)
    } finally { await h.close() }
  })
}

it('assembles D1 replay and authenticated default locks while keeping each request continuation bound to its own host', async () => {
  const h = await harness({ bindings: true })
  function host(id: string) {
    return {
      id,
      pending: [] as Promise<unknown>[],
      waitUntil(this: { id: string; pending: Promise<unknown>[] }, work: Promise<unknown>) {
        if (this.id !== id) throw new Error('wrong host continuation receiver')
        this.pending.push(work)
      },
    }
  }
  const first = host('first')
  const second = host('second')
  try {
    const responses = await Promise.all([h.send('first-turn', first, 'first-thread'), h.send('second-turn', second, 'second-thread')])
    expect(responses.map(response => response.status)).toEqual([200, 200])
    await Promise.all(responses.map(response => response.text()))
    for (const context of [first, second]) {
      const values = await Promise.all(context.pending)
      expect(values.filter(value => typeof value === 'string' && value.startsWith('seam:')).sort())
        .toEqual(['seam:afterAuthorize', 'seam:authorize', 'seam:prepareTurn', 'seam:produce'])
    }
    expect(h.requests()).toBe(2)
    expect(h.database.prepare('SELECT COUNT(*) AS n FROM effect').get()?.n).toBe(2)
    const statuses = h.durable!.sqlite.prepare('SELECT status FROM turn_status').all()
    expect(statuses).toEqual([{ status: 'complete' }, { status: 'complete' }])
    expect((h.durable!.sqlite.prepare('SELECT COUNT(*) AS n FROM turn_events').get() as { n: number }).n).toBeGreaterThan(0)
  } finally { await h.close() }
})

it('the shared binding descriptor supplies a single-flight lock without app lock wiring', async () => {
  const h = await harness({ bindings: true, concurrent: true })
  try {
    const responses = await Promise.all([h.send('one'), h.send('two')])
    expect(responses.map(response => response.status).sort()).toEqual([200, 409])
    await Promise.all(responses.map(response => response.text()))
    await Promise.all(h.pending)
    expect(h.database.prepare('SELECT COUNT(*) AS n FROM effect').get()?.n).toBe(1)
    expect(h.signals.filter(signal => signal.aborted)).toHaveLength(1)
  } finally { await h.close() }
})

it('disposes an HTTP resource that arrives after the gate already refused the turn', async () => {
  const h = await harness({ backend: 'function', resource: 'late', refuse: 'gate' })
  try {
    const response = await h.send()
    expect(response.status).toBe(402)
    await h.resourceStarted
    expect(h.database.prepare('SELECT COUNT(*) AS n FROM resource_disposal').get()?.n).toBe(0)
    h.releaseResource()
    await Promise.all(h.pending)
    expect(h.database.prepare('SELECT * FROM resource_disposal').all()).toEqual([{ resource: '/resource/resource-1' }])
    expect(h.requests()).toBe(0)
  } finally { await h.close() }
})

for (const resource of ['normal', 'throw'] as const) {
  it(`disposes the acquired HTTP resource exactly once after a ${resource} producer terminal path`, async () => {
    const h = await harness({ backend: 'function', resource })
    try {
      const response = await h.send()
      await response.text()
      await Promise.all(h.pending)
      expect(h.requests()).toBe(1)
      expect(h.database.prepare('SELECT COUNT(*) AS n FROM effect').get()?.n).toBe(1)
      expect(h.database.prepare('SELECT * FROM resource_disposal').all()).toEqual([{ resource: '/resource/resource-1' }])
    } finally { await h.close() }
  })
}

it('preserves an explicit app lock while the shared descriptor owns D1 replay', async () => {
  const h = await harness({ bindings: true, customLock: true })
  try {
    const response = await h.send()
    expect(response.status).toBe(200)
    await response.text()
    await Promise.all(h.pending)
    expect(h.acquired()).toBe(1)
    expect(h.database.prepare('SELECT COUNT(*) AS n FROM active_lock').get()?.n).toBe(0)
    expect(h.durable!.sqlite.prepare('SELECT status FROM turn_status').all()).toEqual([{ status: 'complete' }])
  } finally { await h.close() }
})
