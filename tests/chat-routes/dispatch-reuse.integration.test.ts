import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { createChatTurnRoutes, type ChatTurnMessageStore, type ChatTurnProduceArgs, type ChatTurnRequestContext, type ChatTurnRouterBackend, type ChatTurnSandboxBackend, type ChatTurnRouteProducer } from '../../src/chat-routes/index'
import { createD1TurnEventStore, createMemoryTurnEventStore, TURN_EVENTS_MIGRATION_SQL } from '../../src/stream/index'
import { createMemoryTurnStreamHarness, MEMORY_TURN_STREAM_AUTH_SECRET } from '../../src/turn-stream/memory'
import { sqliteD1 } from '../launch-invariants/sqlite-d1'
import { settleTurnResponse, TURN_PROGRESS_FIRST, TURN_PROGRESS_HEADER } from '../../src/chat-routes/turn-progress'
import { ProfileConflictError } from '../../src/agent-profiles/index'

type ProofResource = { id: string; box?: Promise<{ id: string }> }

async function harness(options: { backend?: 'router' | 'sandbox' | 'function' | 'router-data' | 'sandbox-data' | 'router-class'; refuse?: 'authorize' | 'gate' | 'profile' | 'private'; readAuthorization?: 'replay' | 'running' | 'cancel' | 'matching'; concurrent?: boolean; bindings?: boolean; existingStoreDb?: boolean; customLock?: boolean; cleanup?: boolean; domainFence?: boolean; resource?: 'late' | 'normal' | 'throw' | 'nested' | 'nested-reject' } = {}) {
  const database = new DatabaseSync(':memory:')
  database.exec(`
    CREATE TABLE message(id TEXT PRIMARY KEY, thread TEXT, role TEXT, content TEXT, parts TEXT, model TEXT, input_tokens INTEGER, answered INTEGER DEFAULT 0);
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
      database.prepare('INSERT INTO message(id,thread,role,content,parts,model,input_tokens) VALUES (?,?,?,?,?,?,?)')
        .run(id, input.threadId, input.role, input.content, JSON.stringify(input.parts ?? null), input.model ?? null, input.inputTokens ?? null)
      return { id }
    },
  }
  const durable = options.bindings || options.existingStoreDb ? sqliteD1(TURN_EVENTS_MIGRATION_SQL) : undefined
  const existingStore = durable && options.existingStoreDb
    ? Object.assign(createD1TurnEventStore(durable.d1), { db: durable.d1 }) : undefined
  const namespace = createMemoryTurnStreamHarness().namespace
  const forwardContinuation = (phase: string, args: { waitUntil?: ChatTurnRequestContext['waitUntil'] }) => {
    args.waitUntil?.(Promise.resolve(`seam:${phase}`))
  }
  let requests = 0
  let externalRequests = 0
  let acquired = 0
  let gates = 0
  const signals: AbortSignal[] = []
  const refusals: unknown[] = []
  const seen: Array<{ id: string | null | undefined; admitted: boolean; locked: boolean; gates: number }> = []
  const requestStarts: Array<Array<() => void>> = []
  const modelStarted = (number: number) => requests >= number ? Promise.resolve()
    : new Promise<void>(resolve => { (requestStarts[number - 1] ??= []).push(resolve) })
  let resourceReady!: () => void
  const resourceStarted = new Promise<void>(resolve => { resourceReady = resolve })
  let releaseResource: (() => void) | undefined
  let toolReady!: () => void
  const toolObserved = new Promise<void>(resolve => { toolReady = resolve })
  let releaseDomain!: () => void
  const domainAdmitted = new Promise<void>(resolve => { releaseDomain = resolve })
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      externalRequests++
      if (request.url === '/resource') {
        let finished = false
        const finish = () => {
          if (finished) return
          finished = true
          response.writeHead(options.resource === 'nested-reject' ? 503 : 200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'resource-1' }))
        }
        releaseResource = finish
        resourceReady()
        if (!['late', 'nested', 'nested-reject'].includes(options.resource ?? '') && !options.cleanup) finish()
      } else if (request.method === 'DELETE') {
        database.prepare('INSERT INTO resource_disposal VALUES (?)').run(request.url!)
        response.end('disposed')
      } else {
        requests++
        for (const resolve of requestStarts[requests - 1] ?? []) resolve()
        if (options.backend === 'router-data') {
          const delta = requests === 1 ? { tool_calls: [{ index: 0, id: 'write', function: { name: 'write_record', arguments: '{}' } }] }
            : { content: 'A persisted answer.' }
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.end(`data: ${JSON.stringify({ model: 'served/model', choices: [{ delta, finish_reason: requests === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
        } else response.end('A persisted answer.')
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
    const producer = {
      stream: (async function* () {
        yield { type: 'text' as const, text }
        // The real model call can finish early; durable work still awaits the committed row.
        const final = args.admitted ? await args.admitted : args
        database.prepare('INSERT INTO effect VALUES (?)').run(final.userMessageId!)
        if (options.resource === 'throw') throw new Error('stream ended with a real acquisition still owned')
      })(),
      finalText: () => text,
    }
    if (options.backend !== 'router-class') return producer
    class HttpProducer {
      #text = text
      #model = 'served/private-model'
      #receipt = { inputTokens: 11 }
      constructor(readonly stream: ChatTurnRouteProducer['stream']) {}
      get model() { return this.#model }
      finalText() { return this.#text }
      usage() { return this.#receipt }
      assistantParts() { return [{ type: 'text', text: this.#text }] }
    }
    return Object.freeze(new HttpProducer(producer.stream))
  }
  const configured = (args: ChatTurnProduceArgs<Record<string, never>>): ChatTurnRouterBackend | ChatTurnSandboxBackend => {
    seen.push({ id: args.userMessageId, admitted: Boolean(args.admitted),
      locked: Boolean(database.prepare('SELECT thread FROM active_lock').get()), gates })
    if (args.admissionSignal) signals.push(args.admissionSignal)
    if (options.backend === 'sandbox-data') return {
      events: (async function* () {
        const text = await fetch(origin).then(response => response.text())
        database.prepare('INSERT INTO effect VALUES (?)').run(args.userMessageId!)
        yield { type: 'message.part.updated', data: { part: { type: 'text' }, delta: text } }
        yield { type: 'result', data: { finalText: text } }
      })(),
      model: 'sandbox/model',
    }
    return {
      apiKey: options.cleanup ? fetch(`${origin}/resource`).then(async response => {
        const resource = await response.json() as { id: string }
        return { key: 'local-key', revoke: async () => { await fetch(`${origin}/resource/${resource.id}`, { method: 'DELETE' }) } }
      }) : 'local-key', model: 'requested/model', baseUrl: origin,
      systemPrompt: options.cleanup ? Promise.reject(new Error('prompt preparation failed before credential arrived'))
        : { profile: { prompt: { systemPrompt: 'Answer the member.' } }, stable: ['Fixed policy.'], context: ['This turn.'] },
      admitted: options.domainFence ? domainAdmitted : undefined,
      onEvent: event => { if (event.type === 'tool' && event.status === 'running') toolReady() },
      tools: [{ name: 'write_record', description: 'Write one record.', inputSchema: { type: 'object', properties: {} },
        run: async () => {
          const row = database.prepare("SELECT id FROM message WHERE role='user'").get()
          expect(gates).toBe(1)
          database.prepare('INSERT INTO effect VALUES (?)').run(String(row?.id))
          return 'Written.'
        } }],
    }
  }
  const routes = createChatTurnRoutes<Record<string, never>, ProofResource>({
    projectId: 'dispatch-reuse', store, turnTrace: false,
    turnStore: existingStore ?? (durable ? { db: durable.d1, lock: { namespace, auth: { secret: MEMORY_TURN_STREAM_AUTH_SECRET } } } : createMemoryTurnEventStore()),
    authorize: async args => {
      forwardContinuation('authorize', args)
      if (options.readAuthorization) {
        const intent = options.readAuthorization === 'matching'
          ? (args.intent === 'running' || args.intent === 'cancel' ? args.intent : 'replay') : options.readAuthorization
        return { ok: true as const, intent, tenantId: 'workspace', userId: 'member' }
      }
      return options.refuse === 'authorize'
      ? { ok: false as const, response: Response.json({ error: 'unauthorized' }, { status: 401 }) }
      : { ok: true as const, tenantId: 'workspace', userId: 'member', context: {} }
    },
    afterAuthorize: args => {
      forwardContinuation('afterAuthorize', args)
      if (options.resource === 'nested' || options.resource === 'nested-reject') {
        const box = fetch(`${origin}/resource`).then(async response => {
          if (!response.ok) throw new Error('The external box failed to become ready')
          return response.json() as Promise<{ id: string }>
        })
        void box.catch(() => {})
        return {
          resource: Promise.resolve({ box, id: 'resource-1' }),
          async dispose(resource: ProofResource) {
            await resource.box?.catch(() => {})
            const response = await fetch(`${origin}/resource/${resource.id}`, { method: 'DELETE' })
            if (!response.ok) throw new Error('resource disposal failed')
          },
        }
      }
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
        if (!options.cleanup && !args.userMessageId && ['router', 'router-data'].includes(options.backend ?? 'router')) {
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
      if (options.backend === 'router-data' && !options.cleanup) {
        await toolObserved
        expect(database.prepare('SELECT COUNT(*) AS n FROM effect').get()?.n).toBe(0)
      }
      const row = database.prepare('SELECT answered FROM message WHERE id=?').get(args.userMessageId ?? '')
      if (row?.answered === 1) return { proceed: false as const, response: Response.json({ error: 'already answered' }, { status: 409 }) }
      return options.refuse === 'gate'
        ? { proceed: false as const, response: Response.json({ error: 'gate refused' }, { status: 402 }) }
        : { proceed: true as const }
    },
    beforeTurn: async () => {
      if (options.refuse === 'private') throw Object.assign(new Error('private credential and internal profile failure'), { code: 'profile_changed' })
      if (options.refuse !== 'profile') return
      // The public adapter recognizes this specific domain error. Arbitrary
      // coded exceptions remain private; the route transports only Responses.
      try { throw new ProfileConflictError('The agent profile changed while this turn started. Send the message again.', 'profile_changed') }
      catch (error) {
        if (error instanceof ProfileConflictError && error.code === 'profile_changed') {
          throw Response.json({ error: error.message, code: error.code }, { status: 409 })
        }
        throw error
      }
    },
    produce: options.backend === 'function' ? produce : {
      router: options.backend === 'router-data' ? configured as (args: ChatTurnProduceArgs<Record<string, never>>) => ChatTurnRouterBackend : produce,
      when: () => !['sandbox', 'sandbox-data'].includes(options.backend ?? 'router'),
      sandbox: options.backend === 'sandbox-data' ? configured as (args: ChatTurnProduceArgs<Record<string, never>>) => ChatTurnSandboxBackend : produce,
    },
    log: () => {},
  })
  return {
    database, signals, refusals, seen, pending, durable, resourceStarted, toolObserved, releaseDomain, releaseResource: () => releaseResource?.(),
    requests: () => requests, externalRequests: () => externalRequests, acquired: () => acquired,
    replay: (turnId: string) => routes.replay(new Request('http://app.test/replay'), { turnId }),
    running: () => routes.running(new Request('http://app.test/running?threadId=thread')),
    send: (turnId = 'same-client-turn', ctx?: ChatTurnRequestContext, threadId = 'thread', progress = false) => routes.turn(new Request('http://app.test/chat', {
      method: 'POST', headers: { 'content-type': 'application/json', ...(progress ? { [TURN_PROGRESS_HEADER]: TURN_PROGRESS_FIRST } : {}) },
      body: JSON.stringify({ threadId, turnId, content: 'Answer once.' }),
    }), ctx ?? { waitUntil: promise => { pending.push(promise) } }),
    async close() {
      releaseResource?.()
      releaseDomain()
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

it('persists a frozen class-backed Router producer through early dispatch without changing private-state receivers', async () => {
  const h = await harness({ backend: 'router-class' })
  try {
    const response = await h.send()
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('A persisted answer.')
    expect(body).not.toContain('turn.error')
    await Promise.all(h.pending)
    expect(h.seen).toEqual([{ id: undefined, admitted: true, locked: false, gates: 0 }])
    expect(h.requests()).toBe(1)
    expect(h.database.prepare("SELECT content,model,input_tokens FROM message WHERE role='assistant'").all()).toEqual([
      { content: 'A persisted answer.', model: 'served/private-model', input_tokens: 11 },
    ])
    expect(h.database.prepare('SELECT COUNT(*) AS n FROM effect').get()?.n).toBe(1)
    expect(h.database.prepare('SELECT COUNT(*) AS n FROM active_lock').get()?.n).toBe(0)
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
    const firstResponse = await h.send('first-turn', first, 'first-thread')
    expect(firstResponse.status).toBe(200)
    await firstResponse.text()
    const secondResponse = await h.send('second-turn', second, 'second-thread')
    expect(secondResponse.status).toBe(200)
    await secondResponse.text()
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

it('constructs Router option data before the lock and fences its real HTTP tool until admission', async () => {
  const h = await harness({ backend: 'router-data' })
  try {
    const response = await h.send()
    expect(await response.text()).toContain('A persisted answer.')
    await Promise.all(h.pending)
    expect(h.seen).toEqual([{ id: undefined, admitted: true, locked: false, gates: 0 }])
    expect(h.requests()).toBe(2)
    expect(h.database.prepare('SELECT role FROM message ORDER BY rowid').all()).toEqual([{ role: 'user' }, { role: 'assistant' }])
    expect(h.database.prepare('SELECT COUNT(*) AS n FROM effect').get()?.n).toBe(1)
  } finally { await h.close() }
})

it('constructs Sandbox option data only after the lock, user row and gate commit', async () => {
  const h = await harness({ backend: 'sandbox-data' })
  try {
    const response = await h.send()
    expect(await response.text()).toContain('A persisted answer.')
    await Promise.all(h.pending)
    expect(h.seen).toEqual([{ id: expect.any(String), admitted: false, locked: true, gates: 1 }])
    expect(h.requests()).toBe(1)
    expect(h.database.prepare('SELECT COUNT(*) AS n FROM effect').get()?.n).toBe(1)
  } finally { await h.close() }
})

it('tracks late Router credential retirement on the host after admission already refused', async () => {
  const h = await harness({ backend: 'router-data', cleanup: true, refuse: 'gate' })
  try {
    expect((await h.send()).status).toBe(402)
    await h.resourceStarted
    let settled = false
    const continuation = Promise.all(h.pending).then(() => { settled = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    h.releaseResource()
    await continuation
    expect(h.database.prepare('SELECT * FROM resource_disposal').all()).toEqual([{ resource: '/resource/resource-1' }])
    expect(h.requests()).toBe(0)
  } finally { await h.close() }
})

it('preserves an additional domain fence after shared Router admission has committed', async () => {
  const h = await harness({ backend: 'router-data', domainFence: true })
  try {
    const response = await h.send()
    expect(response.status).toBe(200)
    await h.toolObserved
    expect(h.database.prepare("SELECT COUNT(*) AS n FROM message WHERE role='user'").get()?.n).toBe(1)
    expect(h.database.prepare('SELECT COUNT(*) AS n FROM effect').get()?.n).toBe(0)
    h.releaseDomain()
    expect(await response.text()).toContain('A persisted answer.')
    await Promise.all(h.pending)
    expect(h.database.prepare('SELECT COUNT(*) AS n FROM effect').get()?.n).toBe(1)
  } finally { await h.close() }
})

it('preserves a public profile conflict through progress-first turn.response and aborts the speculative HTTP tool loop', async () => {
  const h = await harness({ backend: 'router-data', refuse: 'profile' })
  try {
    const response = await h.send('profile-conflict', undefined, 'thread', true)
    expect(response.status).toBe(200)
    const frames = await response.clone().text()
    expect(frames).toContain('"type":"turn.response"')
    const settled = await settleTurnResponse(response, () => {})
    expect(settled.status).toBe(409)
    expect(await settled.json()).toEqual({ code: 'profile_changed', error: 'The agent profile changed while this turn started. Send the message again.' })
    await Promise.all(h.pending)
    expect(h.requests()).toBe(1)
    expect(h.signals[0]?.aborted).toBe(true)
    expect(h.database.prepare('SELECT role FROM message').all()).toEqual([{ role: 'user' }])
    expect(h.database.prepare('SELECT COUNT(*) AS n FROM effect').get()?.n).toBe(0)
    expect(h.database.prepare('SELECT COUNT(*) AS n FROM active_lock').get()?.n).toBe(0)
  } finally { await h.close() }
})

it('keeps ordinary-route thrown Response semantics for a public profile conflict', async () => {
  const h = await harness({ backend: 'router-data', refuse: 'profile' })
  try {
    const refusal = await h.send().catch(error => error)
    expect(refusal).toBeInstanceOf(Response)
    expect(refusal.status).toBe(409)
    expect((await refusal.json()).code).toBe('profile_changed')
    await Promise.all(h.pending)
    expect(h.signals[0]?.aborted).toBe(true)
    expect(h.database.prepare('SELECT COUNT(*) AS n FROM effect').get()?.n).toBe(0)
  } finally { await h.close() }
})

it('keeps an arbitrary coded exception private on a progress-first stream', async () => {
  const h = await harness({ backend: 'router-data', refuse: 'private' })
  try {
    const settled = await settleTurnResponse(await h.send('private-error', undefined, 'thread', true), () => {})
    expect(settled.status).toBe(500)
    const body = await settled.text()
    expect(body).not.toContain('private credential')
    expect(body).not.toContain('profile_changed')
    expect(body).toContain('The turn failed before it started. Try again.')
    await Promise.all(h.pending)
    expect(h.signals[0]?.aborted).toBe(true)
    expect(h.database.prepare('SELECT COUNT(*) AS n FROM effect').get()?.n).toBe(0)
  } finally { await h.close() }
})

for (const resource of ['nested', 'nested-reject'] as const) {
  it(`keeps an acquired credential until its in-flight HTTP box settles after refusal (${resource})`, async () => {
    const h = await harness({ backend: 'function', resource, refuse: 'gate' })
    try {
      expect((await h.send()).status).toBe(402)
      await h.resourceStarted
      expect(h.database.prepare('SELECT COUNT(*) AS n FROM resource_disposal').get()?.n).toBe(0)
      h.releaseResource()
      await Promise.all(h.pending)
      expect(h.database.prepare('SELECT * FROM resource_disposal').all()).toEqual([{ resource: '/resource/resource-1' }])
      expect(h.requests()).toBe(0)
    } finally { await h.close() }
  })
}

it.each(['replay', 'running', 'cancel'] as const)('refuses %s-only authorization before a turn has any model or SQLite effects', async readAuthorization => {
  const h = await harness({ backend: 'router-data', readAuthorization, resource: 'normal' })
  try {
    const response = await h.send()
    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe('chat_authorization_intent_mismatch')
    await Promise.all(h.pending)
    expect(h.externalRequests()).toBe(0)
    expect(h.acquired()).toBe(0)
    expect(h.seen).toEqual([])
    for (const table of ['message', 'active_lock', 'effect', 'resource_disposal']) {
      expect(h.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0)
    }
  } finally { await h.close() }
})

it.each([undefined, 'matching'] as const)('reads real D1 replay/running state with legacy full or matching identity-only authorization (%s)', async readAuthorization => {
  const h = await harness({ bindings: true, readAuthorization })
  try {
    const buffer = createD1TurnEventStore(h.durable!.d1)
    await buffer.setStatus('running-read', 'running', 'thread')
    await buffer.append('finished-read', [{ seq: 1, event: JSON.stringify({ type: 'text', text: 'Persisted replay answer.' }) }])
    await buffer.setStatus('finished-read', 'complete', 'thread')
    const running = await h.running()
    expect(running.status).toBe(200)
    expect(await running.json()).toEqual({ running: ['running-read'] })
    const replay = await h.replay('finished-read')
    expect(replay.status).toBe(200)
    expect(await replay.text()).toContain('Persisted replay answer.')
    expect(h.externalRequests()).toBe(0)
    expect(h.acquired()).toBe(0)
    expect(h.database.prepare('SELECT COUNT(*) AS n FROM message').get()?.n).toBe(0)
  } finally { await h.close() }
})

it('rejects a read authorization tagged for another endpoint', async () => {
  const replayOnly = await harness({ bindings: true, readAuthorization: 'replay' })
  const runningOnly = await harness({ bindings: true, readAuthorization: 'running' })
  try {
    expect((await replayOnly.running()).status).toBe(403)
    expect((await runningOnly.replay('foreign-turn')).status).toBe(403)
    expect(replayOnly.externalRequests() + runningOnly.externalRequests()).toBe(0)
    expect(replayOnly.acquired() + runningOnly.acquired()).toBe(0)
  } finally { await Promise.all([replayOnly.close(), runningOnly.close()]) }
})


it('preserves an existing real D1 event store that also exposes its database and replays the HTTP answer', async () => {
  const h = await harness({ existingStoreDb: true, customLock: true })
  try {
    const response = await h.send('existing-d1-store')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('A persisted answer.')
    await Promise.all(h.pending)
    const turn = h.durable!.sqlite.prepare('SELECT turnId,status FROM turn_status').get() as { turnId: string; status: string }
    expect(turn.status).toBe('complete')
    const replay = await h.replay(turn.turnId)
    expect(replay.status).toBe(200)
    expect(await replay.text()).toContain('A persisted answer.')
    expect(h.requests()).toBe(1)
    expect(h.acquired()).toBe(1)
    expect(h.database.prepare('SELECT role FROM message ORDER BY rowid').all()).toEqual([{ role: 'user' }, { role: 'assistant' }])
    expect(h.database.prepare('SELECT COUNT(*) AS n FROM active_lock').get()?.n).toBe(0)
  } finally { await h.close() }
})
