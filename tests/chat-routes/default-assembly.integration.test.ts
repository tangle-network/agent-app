import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Sandbox } from '@tangle-network/sandbox'
import { expect, it } from 'vitest'
import { createChatTurnRoutes, type ChatTurnMessageStore, type CreateChatTurnRoutesOptions } from '../../src/chat-routes/index'
import { createD1TurnEventStore, TURN_EVENTS_MIGRATION_SQL } from '../../src/stream/index'
import { createMemoryTurnStreamHarness, MEMORY_TURN_STREAM_AUTH_SECRET } from '../../src/turn-stream/memory'
import { PREWARM_CLAIM_TABLE_DDL } from '../../src/sandbox/prewarm-claim-d1'
import { WARM_RECEIPT_TABLE_DDL } from '../../src/sandbox/warm-receipts'
import { sandboxPromptRunner } from '../../src/sandbox/sandbox-run-tool'
import { defaultChatShell } from '../../src/chat-routes/default-backend'
import { sqliteD1 } from '../launch-invariants/sqlite-d1'

type RouterPayload = { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }>;
  max_tokens?: number; max_completion_tokens?: number; reasoning_effort?: string }

/** Real HTTP protocol peers, SQLite migrations/stores and the authenticated
 * TurnStreamDO core. No producer, SDK method, fetch or clock is replaced.
 * The local Router/sidecar peers establish wiring, not hosted model quality.
 */
async function boundary() {
  const db = sqliteD1(`${TURN_EVENTS_MIGRATION_SQL};${WARM_RECEIPT_TABLE_DDL};${PREWARM_CLAIM_TABLE_DDL};
    CREATE TABLE message(id TEXT PRIMARY KEY,thread TEXT,role TEXT,content TEXT,parts TEXT)`)
  const requests: RouterPayload[] = []
  const nativeRequests: string[] = []
  const channels: string[] = []
  const pending: Promise<unknown>[] = []
  const held: Array<() => void> = []
  const modelStarted: Array<() => void> = []
  let heldModelStarted = false
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      if (request.url === '/v1/sandboxes/observation-box') {
        nativeRequests.push(`${request.method} ${request.url}`)
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          id: 'observation-box', status: 'running', filesystemIncarnationId: 'observation-incarnation',
          filesystemIncarnationProvenance: 'fresh', filesystemIncarnationReadiness: 'ready',
          connection: { runtimeUrl: `${origin}/v1/sandboxes/observation-box/runtime` },
        }))
        return
      }
      if (request.url === '/v1/sandboxes/observation-box/runtime/agents/run/stream') {
        nativeRequests.push(`${request.method} ${request.url}`)
        const input = JSON.parse(body) as { sessionId: string }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        if (request.headers['x-execution-id']) response.write(`id: admitted\nevent: execution.started\ndata: ${JSON.stringify({
          executionId: request.headers['x-execution-id'], sessionId: input.sessionId,
        })}\n\n`)
        // The exact backend execution was admitted, but observation ends without
        // any native result/done. The SDK, rather than this peer, synthesizes done.
        response.end(`id: partial\nevent: message.part.updated\ndata: ${JSON.stringify({
          part: { type: 'text', id: 'sdk-partial' }, delta: 'Native SDK partial answer.',
        })}\n\n`)
        return
      }
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
      return db.sqlite.prepare<[string], { id: string; role: 'user' | 'assistant'; content: string; parts: string }>('SELECT id,role,content,parts FROM message WHERE thread=? ORDER BY rowid').all(thread)
        .map(row => ({ ...row, parts: JSON.parse(row.parts) }))
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
  return { db, requests, nativeRequests, channels, routes, post, turn, ctx, flush, origin,
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
  const receipts: Array<{ userMessageId?: string | null; backendTerminal?: boolean }> = []
  try {
    const response = await peer.routes({ lifecycle: { onTurnComplete: receipt => { receipts.push(receipt) } } }).turn(peer.turn('first'), { ...peer.ctx,
      executionLimits: { maxOutputTokens: 321, maxReasoningTokens: 0 },
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('A default Router answer.')
    await peer.flush()
    expect(peer.requests).toHaveLength(1)
    expect(peer.requests[0]?.tools?.map(tool => tool.function.name)).toContain('sandbox_run')
    expect(peer.requests[0]).toMatchObject({ max_tokens: 321, max_completion_tokens: 321, reasoning_effort: 'none' })
    expect(peer.db.sqlite.prepare('SELECT role,content FROM message ORDER BY rowid').all()).toEqual([
      { role: 'user', content: 'Hello.' }, { role: 'assistant', content: 'A default Router answer.' },
    ])
    expect(receipts).toEqual([expect.objectContaining({
      userMessageId: peer.db.sqlite.prepare<[], { id: string }>("SELECT id FROM message WHERE role='user'").get()?.id,
      backendTerminal: true,
    })])
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
    expect(peer.db.sqlite.prepare<[], { content: string }>("SELECT content FROM message WHERE role='assistant'").get()?.content).toContain('The computer was unavailable')
    const after = await peer.routes().turn(peer.turn('after-unavailable'), peer.ctx)
    expect(after.status).toBe(200)
    await after.text()
  } finally { await peer.close() }
})

it('prewarms only a server-authorized workspace and checks access to any named thread', async () => {
  const peer = await boundary()
  try {
    const routes = peer.routes()
    expect((await routes.prewarm(peer.post('/api/chat/prewarm', {}, false))).status).toBe(401)
    expect((await routes.prewarm(peer.post('/api/chat/prewarm', { threadId: 'first' }, false))).status).toBe(401)
    expect((await routes.prewarm(peer.post('/api/chat/prewarm', { threadId: 'foreign-thread' }))).status).toBe(404)
    expect(peer.channels).toEqual([])
    const opened = await routes.prewarm(peer.post('/api/chat/prewarm'))
    expect(await opened.json()).toMatchObject({ outcome: 'warmed', steps: [{ name: 'turn_lock', outcome: 'miss' }] })
    const warm = await routes.prewarm(peer.post('/api/chat/prewarm', { threadId: 'first', workspaceId: 'forged-workspace' }))
    expect(warm.status).toBe(200)
    expect(await warm.json()).toMatchObject({ outcome: 'recent', steps: [{ name: 'turn_lock', outcome: 'hit' }] })
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

it('keeps the workspace fenced when the real Sandbox SDK synthesizes failed done after observation loss', async () => {
  const peer = await boundary()
  try {
    const box = await new Sandbox({ apiKey: 'loopback-only-sandbox-key', baseUrl: peer.origin }).get('observation-box')
    if (!box) throw new Error('Local observation box is missing')
    const frames: Array<{ type: string; data: unknown }> = []
    const native = peer.routes({ produce: {
      when: () => false,
      router: () => { throw new Error('Native execution must not ask the Router') },
      sandbox: args => ({ model: 'native/model', openEvents: ({ signal }) => (async function* () {
        for await (const event of box.streamPrompt('Observe this exact native execution.', {
          sessionId: args.identity.sessionId, executionId: args.executionId,
          turnId: args.executionId, detach: true, timeoutMs: 500, signal,
        })) {
          frames.push(event)
          yield event
        }
      })() }),
    } })
    const observation = await native.turn(peer.turn('native-sdk'), peer.ctx)
    await observation.text()
    await peer.flush()
    expect(frames.some(frame => frame.type === 'execution.started')).toBe(true)
    expect(frames.some(frame => frame.type === 'done' && (frame.data as { status?: string }).status === 'failed')).toBe(true)
    expect(frames.some(frame => frame.type === 'result')).toBe(false)
    expect(peer.nativeRequests.filter(request => request.startsWith('POST'))).toHaveLength(1)
    const contender = await peer.routes().turn(peer.turn('different-thread'), peer.ctx)
    expect(contender.status).toBe(409)
    expect(await contender.json()).toMatchObject({ error: { code: 'workspace_turn_in_flight', threadId: 'native-sdk' } })
  } finally { await peer.close() }
}, 10_000)

it('keeps an unconfirmed SDK sandbox child fenced after the Router finishes its answer', async () => {
  const peer = await boundary()
  try {
    const box = await new Sandbox({ apiKey: 'loopback-only-sandbox-key', baseUrl: peer.origin }).get('observation-box')
    if (!box) throw new Error('Local observation box is missing')
    const shell = defaultChatShell('default-assembly', {
      TANGLE_API_KEY: 'loopback-only-router-key', TANGLE_ROUTER_URL: peer.origin,
    }, { model: 'native/model', systemPrompt: 'Report the confirmed computer result.' })
    const hybrid = peer.routes({ produce: {
      router: () => ({
        apiKey: 'loopback-only-router-key', model: 'requested/default', baseUrl: peer.origin,
        systemPrompt: 'Use the workspace computer when asked.',
        renderToolResult: () => undefined,
        box: {
          acquire: async () => box,
          runTask: sandboxPromptRunner(shell, { model: 'native/model', sessionId: 'hybrid-native' }),
          timeoutMs: 5_000,
        },
      }),
    } })
    const reply = await hybrid.turn(peer.turn('hybrid', 'Please use the computer.'), peer.ctx)
    expect(reply.status).toBe(200)
    await reply.text()
    await peer.flush()
    expect(peer.nativeRequests.filter(request => request.startsWith('POST'))).toHaveLength(1)
    expect(peer.requests).toHaveLength(2)
    const result = peer.requests[1]?.messages.find(message => message.role === 'tool')
    expect(String(result?.content)).toContain('sandbox_unconfirmed')
    expect(String(result?.content)).not.toContain('"answer":"Native SDK partial answer."')
    const contender = await peer.routes().turn(peer.turn('after-hybrid'), peer.ctx)
    expect(contender.status).toBe(409)
    expect(await contender.json()).toMatchObject({ error: { code: 'workspace_turn_in_flight', threadId: 'hybrid' } })
  } finally { await peer.close() }
}, 10_000)

it('releases workspace admission when the real child prompt preflight refuses an incompatible harness and model', async () => {
  const peer = await boundary()
  try {
    const box = await new Sandbox({ apiKey: 'loopback-only-sandbox-key', baseUrl: peer.origin }).get('observation-box')
    if (!box) throw new Error('Local observation box is missing')
    const shell = defaultChatShell('default-assembly', {
      TANGLE_API_KEY: 'loopback-only-router-key', TANGLE_ROUTER_URL: peer.origin,
    }, { model: 'openai/gpt-5' })
    const hybrid = peer.routes({ produce: {
      router: () => ({
        apiKey: 'loopback-only-router-key', model: 'requested/default', baseUrl: peer.origin,
        systemPrompt: 'Use the workspace computer when asked.',
        box: {
          acquire: async () => box,
          // Kimi Code is vendor locked. Its real provider preflight must refuse
          // an OpenAI model before the SDK dispatches any execution.
          runTask: sandboxPromptRunner(shell, { harness: 'kimi-code', model: 'openai/gpt-5', sessionId: 'refused-child' }),
        },
      }),
    } })
    const refused = await hybrid.turn(peer.turn('refused-child', 'Please use the computer.'), peer.ctx)
    await refused.text()
    await peer.flush()
    expect(peer.nativeRequests.filter(request => request.startsWith('POST'))).toEqual([])
    expect(peer.requests).toHaveLength(2)
    const result = peer.requests[1]?.messages.find(message => message.role === 'tool')
    expect(String(result?.content)).toContain('sandbox_unavailable')
    const next = await peer.routes().turn(peer.turn('after-refused-child'), peer.ctx)
    expect(next.status).toBe(200)
    expect(await next.text()).toContain('A default Router answer.')
  } finally { await peer.close() }
})

it('gives detached tool calls distinct native identities and reuses only the exact call retry', async () => {
  type NativeTurn = { sessionId: string; executionId: string; turnId: string; answer: string }
  const turns = new Map<string, NativeTurn>()
  const admissions: NativeTurn[] = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    const url = new URL(request.url!, 'http://loopback.local')
    const json = (value: unknown, status = 200) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
    if (url.pathname === '/v1/sandboxes/identity-box') return json({
      id: 'identity-box', status: 'running', filesystemIncarnationId: 'identity-incarnation',
      filesystemIncarnationProvenance: 'fresh', filesystemIncarnationReadiness: 'ready',
      connection: { runtimeUrl: `${origin}/v1/sandboxes/identity-box/runtime` },
    })
    const path = url.pathname.replace('/v1/sandboxes/identity-box/runtime', '')
    if (request.method === 'GET' && path.startsWith('/agents/sessions/')) {
      const sessionId = decodeURIComponent(path.slice('/agents/sessions/'.length))
      const latest = admissions.filter(turn => turn.sessionId === sessionId).at(-1)
      return latest ? json({ id: sessionId, status: 'completed', latestExecutionId: latest.executionId }) : json({ error: 'not found' }, 404)
    }
    if (request.method === 'GET' && path === '/messages/turns') {
      const turnId = url.searchParams.get('turnId')!
      const sessionId = url.searchParams.get('sessionId')!
      const turn = turns.get(`${sessionId}:${turnId}`)
      return turn ? json({ turnId, sessionId, completedAt: '2026-10-24T00:00:00Z',
        result: { executionId: turn.executionId, finalText: turn.answer } }) : response.writeHead(204).end()
    }
    const frame = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
    if (request.method === 'POST' && path === '/agents/run/stream') {
      const input = JSON.parse(body) as { sessionId: string; turnId: string; runControlRef?: unknown; parts: Array<{ type: string; text?: string }> }
      const executionId = String(request.headers['x-execution-id'])
      // The SDK encodes every text part on the wire; the sidecar decodes it before dispatch.
      const task = input.parts.filter(part => part.type === 'text').map(part => Buffer.from(part.text ?? '', 'base64').toString('utf8')).join('\n')
      const turn = { sessionId: input.sessionId, executionId, turnId: input.turnId, answer: `Answer:${task}` }
      admissions.push(turn)
      turns.set(`${turn.sessionId}:${turn.turnId}`, turn)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(frame('execution.started', { sessionId: turn.sessionId, executionId,
        ...(input.runControlRef ? { runControlRef: input.runControlRef } : {}) }))
      return
    }
    const replay = /^\/agents\/run\/([^/]+)\/events$/.exec(path)
    if (request.method === 'GET' && replay) {
      const turn = admissions.find(turn => turn.executionId === decodeURIComponent(replay[1]!))
      if (!turn) return json({ error: 'execution not found' }, 404)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(frame('result', { executionId: turn.executionId, sessionId: turn.sessionId, finalText: turn.answer })
        + frame('done', { status: 'completed', executionId: turn.executionId, sessionId: turn.sessionId }))
      return
    }
    return json({ error: `Unexpected protocol path ${request.method} ${url.pathname}` }, 500)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const box = await new Sandbox({ apiKey: 'loopback-only-sandbox-key', baseUrl: origin }).get('identity-box')
    if (!box) throw new Error('Local identity box is missing')
    const shell = defaultChatShell('identity-proof', { TANGLE_API_KEY: 'loopback-only-router-key', TANGLE_ROUTER_URL: origin }, { model: 'native/model' })
    const run = sandboxPromptRunner(shell, { model: 'native/model', sessionId: 'same-child-session',
      executionId: 'same-parent-execution', turnId: 'same-parent-turn', detach: true })
    const options = (callId?: string) => ({ signal: AbortSignal.timeout(5_000), timeoutMs: 5_000, emit() {}, ...(callId ? { callId } : {}) })
    expect(await run(box, 'first task', options('call-one'))).toBe('Answer:first task')
    expect(await run(box, 'second task', options('call-two'))).toBe('Answer:second task')
    expect(admissions).toHaveLength(2)
    expect(new Set(admissions.map(turn => turn.executionId)).size).toBe(2)
    expect(new Set(admissions.map(turn => turn.turnId)).size).toBe(2)
    expect(new Set(admissions.map(turn => turn.sessionId))).toEqual(new Set(['same-child-session']))
    expect(await run(box, 'first task', options('call-one'))).toBe('Answer:first task')
    expect(admissions).toHaveLength(2)
    // A caller without tool identity must never reuse its parent's cached work.
    expect(await run(box, 'third task', options())).toBe('Answer:third task')
    expect(await run(box, 'fourth task', options())).toBe('Answer:fourth task')
    expect(admissions).toHaveLength(4)
    expect(new Set(admissions.map(turn => turn.executionId)).size).toBe(4)
    expect(new Set(admissions.map(turn => turn.turnId)).size).toBe(4)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}, 15_000)
