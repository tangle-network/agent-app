import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { createChatTurnRoutes, type ChatTurnMessageStore, type CreateChatTurnRoutesOptions } from '../../src/chat-routes/index'
import { createD1TurnEventStore, TURN_EVENTS_MIGRATION_SQL } from '../../src/stream/index'
import { createMemoryTurnStreamHarness, MEMORY_TURN_STREAM_AUTH_SECRET } from '../../src/turn-stream/memory'
import { PREWARM_CLAIM_TABLE_DDL } from '../../src/sandbox/prewarm-claim-d1'
import { WARM_RECEIPT_TABLE_DDL } from '../../src/sandbox/warm-receipts'
import { sqliteD1 } from '../launch-invariants/sqlite-d1'

type RouterPayload = { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> }

/** Real HTTP protocol peers, SQLite migrations/stores and the authenticated
 * TurnStreamDO core. No producer, SDK method, fetch or clock is replaced.
 * The local Router/sidecar peers establish wiring, not hosted model quality.
 */
async function boundary() {
  const db = sqliteD1(`${TURN_EVENTS_MIGRATION_SQL};${WARM_RECEIPT_TABLE_DDL};${PREWARM_CLAIM_TABLE_DDL};
    CREATE TABLE message(id TEXT PRIMARY KEY,thread TEXT,role TEXT,content TEXT,parts TEXT)`)
  const requests: RouterPayload[] = []
  const channels: string[] = []
  const pending: Promise<unknown>[] = []
  const held: Array<() => void> = []
  const modelStarted: Array<() => void> = []
  let heldModelStarted = false
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      if (request.url?.startsWith('/native/')) {
        response.writeHead(200, { 'content-type': 'application/x-ndjson' })
        response.write(`${JSON.stringify({ type: 'message.part.updated', data: { part: { type: 'text', id: 'native-text' }, delta: 'Native partial answer.' } })}\n`)
        if (request.url === '/native/terminal') response.write(`${JSON.stringify({ type: 'result', data: { finalText: 'Native terminal answer.' } })}\n`)
        response.end()
        return
      }
      const payload = JSON.parse(body) as RouterPayload
      requests.push(payload)
      const member = payload.messages.filter(message => message.role === 'user').at(-1)?.content
      const toolResult = payload.messages.find(message => message.role === 'tool')
      const send = () => {
        const escalate = member === 'Please use the computer.' && !toolResult
        const delta = escalate
          ? { tool_calls: [{ index: 0, id: 'default-box-call', function: { name: 'sandbox_run', arguments: JSON.stringify({ task: 'Read the workspace file.' }) } }] }
          : { content: toolResult ? 'The computer was unavailable; no file was read.' : 'A default Router answer.' }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(`data: ${JSON.stringify({ model: 'served/default', choices: [{ delta, finish_reason: escalate ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
      }
      if (member === 'Hold this turn.') {
        held.push(send)
        heldModelStarted = true
        for (const ready of modelStarted.splice(0)) ready()
      } else send()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const durable = createMemoryTurnStreamHarness()
  const env = {
    DB: db.d1,
    TURN_STREAM: {
      idFromName(name: string) { channels.push(name); return durable.namespace.idFromName(name) },
      get: durable.namespace.get.bind(durable.namespace),
    },
    TURN_STREAM_AUTH_SECRET: MEMORY_TURN_STREAM_AUTH_SECRET,
    TANGLE_API_KEY: 'loopback-only-router-key', TANGLE_ROUTER_URL: origin, MODEL_NAME: 'requested/default',
  }
  const store: ChatTurnMessageStore = {
    async listMessages(thread) {
      return db.sqlite.prepare('SELECT id,role,content,parts FROM message WHERE thread=? ORDER BY rowid').all(thread)
        .map(row => ({ id: String(row.id), role: row.role as 'user' | 'assistant', content: String(row.content),
          parts: JSON.parse(String(row.parts)) }))
    },
    async appendMessage(input) {
      const id = input.id ?? crypto.randomUUID()
      db.sqlite.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(id, input.threadId, input.role, input.content, JSON.stringify(input.parts ?? []))
      return { id }
    },
  }
  const routes = (extra: Partial<CreateChatTurnRoutesOptions> = {}) => createChatTurnRoutes({
    projectId: 'default-assembly', env, store,
    // A custom event store must not prevent env bindings from supplying the lock.
    turnStore: createD1TurnEventStore(db.d1), turnTrace: false,
    authorize: async ({ request, threadId, body }) => {
      if (request.headers.get('authorization') !== 'Bearer member') return { ok: false, response: new Response(null, { status: 401 }) }
      if ((threadId ?? body?.threadId)?.startsWith('foreign')) return { ok: false, response: new Response(null, { status: 404 }) }
      return { ok: true, tenantId: 'verified-workspace', userId: 'member', context: undefined }
    },
    ...extra,
  })
  const post = (path: string, body: Record<string, unknown> = {}, authenticated = true) => new Request(`http://app.local${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: 'Bearer member' } : {}) },
    body: JSON.stringify(body),
  })
  const turn = (threadId: string, content = 'Hello.') => post('/api/chat', { threadId, turnId: crypto.randomUUID(), content })
  const ctx = { waitUntil(work: Promise<unknown>) { pending.push(work) } }
  const flush = async () => { for (let at = 0; at < pending.length; at++) await pending[at] }
  return { db, requests, channels, routes, post, turn, ctx, flush, origin,
    holdStarted: () => heldModelStarted ? Promise.resolve() : new Promise<void>(resolve => modelStarted.push(resolve)),
    release: () => { for (const send of held.splice(0)) send() },
    close: async () => {
      for (const send of held.splice(0)) send()
      await flush()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      db.sqlite.close()
    },
  }
}

it('inherits the hybrid Router backend and persists a real protocol reply without a produce option', async () => {
  const peer = await boundary()
  try {
    const response = await peer.routes().turn(peer.turn('first'), peer.ctx)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('A default Router answer.')
    await peer.flush()
    expect(peer.requests).toHaveLength(1)
    expect(peer.requests[0]?.tools?.map(tool => tool.function.name)).toContain('sandbox_run')
    expect(peer.db.sqlite.prepare('SELECT role,content FROM message ORDER BY rowid').all()).toEqual([
      { role: 'user', content: 'Hello.' }, { role: 'assistant', content: 'A default Router answer.' },
    ])
    // This is an independently constructed factory over the same bindings.
    const next = await peer.routes().turn(peer.turn('second'), peer.ctx)
    expect(next.status).toBe(200)
    await next.text()
    await peer.flush()
  } finally { await peer.close() }
})

it('fences a different thread in the same workspace, and releases after a terminal Router reply', async () => {
  const peer = await boundary()
  try {
    const running = await peer.routes().turn(peer.turn('first', 'Hold this turn.'), peer.ctx)
    await peer.holdStarted()
    const contender = await peer.routes().turn(peer.turn('second'), peer.ctx)
    expect(contender.status).toBe(409)
    expect(await contender.json()).toMatchObject({ error: { code: 'workspace_turn_in_flight', threadId: 'first' } })
    expect(peer.db.sqlite.prepare("SELECT COUNT(*) AS n FROM message WHERE thread='second'").get()).toEqual({ n: 0 })
    peer.release()
    await running.text()
    await peer.flush()
    const after = await peer.routes().turn(peer.turn('second'), peer.ctx)
    expect(after.status).toBe(200)
    await after.text()
  } finally { await peer.close() }
})

it('sends an unavailable default sandbox escalation back through the real Router tool loop', async () => {
  const peer = await boundary()
  try {
    const response = await peer.routes().turn(peer.turn('escalate', 'Please use the computer.'), peer.ctx)
    const text = await response.text()
    await peer.flush()
    expect(response.status).toBe(200)
    expect(peer.requests).toHaveLength(2)
    const receipt = peer.requests[1]?.messages.find(message => message.role === 'tool')
    expect(String(receipt?.content)).toContain('sandbox_unavailable')
    expect(text).toContain('The computer was unavailable; no file was read.')
    expect(peer.db.sqlite.prepare("SELECT content FROM message WHERE role='assistant'").get()?.content).toContain('The computer was unavailable')
  } finally { await peer.close() }
})

it('prewarms only an authenticated accessible thread and derives the workspace from authorization', async () => {
  const peer = await boundary()
  try {
    const routes = peer.routes()
    expect(await (await routes.prewarm(peer.post('/api/chat/prewarm'))).json()).toMatchObject({ outcome: 'declined', reason: 'thread_required' })
    expect((await routes.prewarm(peer.post('/api/chat/prewarm', { threadId: 'first' }, false))).status).toBe(401)
    expect((await routes.prewarm(peer.post('/api/chat/prewarm', { threadId: 'foreign-thread' }))).status).toBe(404)
    expect(peer.channels).toEqual([])
    const warm = await routes.prewarm(peer.post('/api/chat/prewarm', { threadId: 'first', workspaceId: 'forged-workspace' }))
    expect(warm.status).toBe(200)
    expect(await warm.json()).toMatchObject({ outcome: 'warmed', steps: [{ name: 'turn_lock', outcome: 'miss' }] })
    expect(peer.channels.length).toBeGreaterThan(0)
    expect(peer.channels.every(channel => channel === 'verified-workspace')).toBe(true)
    const readsOnly = peer.routes({ authorize: async () => ({ ok: true, intent: 'replay', tenantId: 'other', userId: 'member' }) })
    const count = peer.channels.length
    expect((await readsOnly.prewarm(peer.post('/api/chat/prewarm', { threadId: 'first' }))).status).toBe(403)
    expect(peer.channels).toHaveLength(count)
    expect(peer.requests).toEqual([])
    expect(peer.db.sqlite.prepare('SELECT * FROM sandbox_prewarm_claims').all()).toEqual([])
  } finally { await peer.close() }
})

it('honors explicit lock and prewarm opt-outs while keeping the default Router producer', async () => {
  const peer = await boundary()
  try {
    const routes = peer.routes({ turnLock: false, prewarm: false })
    expect((await routes.prewarm(peer.post('/api/chat/prewarm', { threadId: 'first' }))).status).toBe(405)
    const running = await routes.turn(peer.turn('first', 'Hold this turn.'), peer.ctx)
    await peer.holdStarted()
    const parallel = await routes.turn(peer.turn('second'), peer.ctx)
    expect(parallel.status).toBe(200)
    expect(await parallel.text()).toContain('A default Router answer.')
    expect(peer.channels).toEqual([])
    peer.release()
    await running.text()
    await peer.flush()
  } finally { await peer.close() }
})

it.each(['lost', 'terminal'] as const)('retains native workspace ownership on %s observation only when no terminal was received', async mode => {
  const peer = await boundary()
  try {
    const native = peer.routes({ produce: {
      when: () => false,
      router: () => { throw new Error('A native selection must not ask the Router') },
      sandbox: () => ({ model: 'native/model', events: (async function* () {
        const response = await fetch(`${peer.origin}/native/${mode}`)
        for (const line of (await response.text()).trim().split('\n')) yield JSON.parse(line)
      })() }),
    } })
    const observed = await native.turn(peer.turn('native'), peer.ctx)
    expect(observed.status).toBe(200)
    await observed.text()
    await peer.flush()
    const contender = await peer.routes().turn(peer.turn('different-thread'), peer.ctx)
    expect(contender.status).toBe(mode === 'lost' ? 409 : 200)
    if (mode === 'lost') expect(await contender.json()).toMatchObject({ error: { code: 'workspace_turn_in_flight', threadId: 'native' } })
    else await contender.text()
  } finally { await peer.close() }
})

it('refuses an unnamed forbidden default model before claiming or provisioning its sandbox', async () => {
  const peer = await boundary()
  try {
    const restricted = peer.routes({
      produce: { router: false },
      modelPolicy: { catalog: [{ id: 'requested/default' }], filter: () => false },
    })
    const denied = await restricted.turn(peer.turn('restricted'), peer.ctx)
    await denied.text()
    await peer.flush()
    // A claim is the first durable side effect of default sandbox acquisition.
    // Checking its real SQLite table detects even a failed acquisition attempt.
    expect(peer.db.sqlite.prepare('SELECT * FROM sandbox_prewarm_claims').all()).toEqual([])
    expect(peer.requests).toEqual([])
    const allowed = await peer.routes().turn(peer.turn('allowed'), peer.ctx)
    expect(allowed.status).toBe(200)
    expect(await allowed.text()).toContain('A default Router answer.')
  } finally { await peer.close() }
})
