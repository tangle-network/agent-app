/**
 * Real shared route -> D1 -> authenticated TurnStreamDO integration fixture.
 * The only artificial latency is a 240ms DO initialization delay. This is NOT
 * a measurement of Cloudflare cold activation, transport, or physical placement.
 */
import type { D1Database } from '@cloudflare/workers-types'
import { createWorkspacePrewarmRoute } from '../../src/sandbox/prewarm-route'
import { WARM_RECEIPT_TABLE_DDL } from '../../src/sandbox/warm-receipts'
import { createChatTurnRoutes, type ChatTurnMessageStore } from '../../src/chat-routes/turn-routes'
import { createDefaultTurnLock, type ChatTurnStoreBindings } from '../../src/chat-routes/route-storage'
import { TURN_EVENTS_MIGRATION_SQL } from '../../src/stream/turn-buffer'
import { TurnStreamDO, type TurnStreamDOState } from '../../src/turn-stream/do'
import type { TurnStreamNamespaceLike } from '../../src/turn-stream/adapters'

export class ColdStartTurnStreamDO extends TurnStreamDO {
  constructor(state: TurnStreamDOState & { blockConcurrencyWhile(callback: () => Promise<void>): void }, env: unknown) {
    super(state, env)
    // A constructor barrier holds every overlapping peek/acquire request until
    // initialization finishes, as real DO initialization must. No protocol is replaced.
    state.blockConcurrencyWhile(async () => { await new Promise(resolve => setTimeout(resolve, 240)) })
  }

  async fetch(request: Request): Promise<Response> {
    // The constructor barrier finishes before this handler begins. This measures
    // only the real handler, not activation or the binding's transport/queue.
    const started = performance.now()
    const response = await super.fetch(request)
    const headers = new Headers(response.headers)
    headers.set('x-local-proof-do-ms', String(performance.now() - started))
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
}

interface Env { DB: D1Database; TURN_STREAM_DO: TurnStreamNamespaceLike; TURN_STREAM_AUTH_SECRET: string }
interface BindingCall {
  channel: string
  id: string
  locationHint?: string
  path?: string
  fetchMs?: number
  handlerMs?: number
}
const calls: BindingCall[] = []
const factories = new Map<string, ReturnType<typeof createPrewarm>>()
const validWorkspace = (value: string) => /^proof-[a-z0-9-]+$/.test(value)

function observedNamespace(namespace: TurnStreamNamespaceLike): TurnStreamNamespaceLike {
  const names = new Map<unknown, string>()
  return {
    idFromName(name) { const id = namespace.idFromName(name); names.set(id, name); return id },
    get(id, options) {
      const call: BindingCall = { channel: names.get(id) ?? '', id: String(id), ...options }
      calls.push(call)
      const stub = namespace.get(id, options)
      return {
        async fetch(input, init) {
          // Record only the path and elapsed times, never capabilities, headers
          // or bodies. The request and response are delegated unchanged.
          call.path = new URL(typeof input === 'string' ? input : input.url).pathname
          const started = performance.now()
          try {
            const response = await stub.fetch(input, init)
            const handlerMs = response.headers.get('x-local-proof-do-ms')
            if (handlerMs !== null && Number.isFinite(Number(handlerMs))) call.handlerMs = Number(handlerMs)
            return response
          } finally {
            call.fetchMs = performance.now() - started
          }
        },
      }
    },
  }
}

function bindings(env: Env, url: URL): ChatTurnStoreBindings {
  return {
    db: env.DB,
    ...(url.searchParams.get('region') === 'weur' ? { region: 'weur' as const } : {}),
    lock: {
      namespace: observedNamespace(env.TURN_STREAM_DO),
      auth: { secret: url.searchParams.has('wrongSecret') ? 'incorrect-local-proof-secret-000000' : env.TURN_STREAM_AUTH_SECRET },
    },
  }
}

function createPrewarm(env: Env, url: URL) {
  return createWorkspacePrewarmRoute({
    turnStore: bindings(env, url),
    authorize: async ({ request }) => {
      const workspaceId = new URL(request.url).pathname.split('/')[2] ?? ''
      if (request.headers.get('authorization') !== 'Bearer editor') {
        return { status: 'denied' as const, response: Response.json({ error: 'not authorized' }, { status: 403 }) }
      }
      if (!validWorkspace(workspaceId)) return { status: 'denied' as const, response: new Response(null, { status: 404 }) }
      return {
        status: 'allowed' as const,
        workspaceId, // Verified route workspace; never take identity from JSON.
        key: `legacy:${workspaceId}`,
        warm: async () => {
          if (request.headers.get('x-fail-legacy') === '1') throw new Error('local legacy warm failure')
          await env.DB.prepare('SELECT 1').first()
          return { legacyReady: true }
        },
      }
    },
  })
}

function messages(db: D1Database): ChatTurnMessageStore {
  return {
    async listMessages(threadId) {
      const rows = await db.prepare('SELECT id,role,content,parts FROM proof_messages WHERE thread_id=? ORDER BY rowid').bind(threadId)
        .all<{ id: string; role: 'user' | 'assistant'; content: string; parts: string | null }>()
      return rows.results.map(row => ({ ...row, parts: row.parts ? JSON.parse(row.parts) : null }))
    },
    async appendMessage(input) {
      const id = input.id ?? crypto.randomUUID()
      await db.prepare('INSERT INTO proof_messages (id,thread_id,role,content,parts) VALUES (?,?,?,?,?)')
        .bind(id, input.threadId, input.role, input.content, input.parts ? JSON.stringify(input.parts) : null).run()
      return { ...input, id }
    },
  }
}

function lockArgs(workspaceId: string, url: URL) {
  return {
    identity: { tenantId: workspaceId, userId: 'editor', sessionId: url.searchParams.get('thread') ?? 'fencing-thread', turnIndex: 0 },
    executionId: url.searchParams.get('execution') ?? 'first-execution',
    body: { threadId: 'fencing-thread', content: 'proof', turnId: 'proof-turn' },
    context: undefined,
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    const start = calls.length
    if (url.pathname === '/proof/seed') {
      const ddl = `${TURN_EVENTS_MIGRATION_SQL};${WARM_RECEIPT_TABLE_DDL};
        CREATE TABLE IF NOT EXISTS proof_messages (id TEXT PRIMARY KEY,thread_id TEXT,role TEXT,content TEXT,parts TEXT)`
      await env.DB.batch(ddl.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => env.DB.prepare(sql)))
      return new Response(null, { status: 204 })
    }
    const workspaceId = url.pathname.split('/')[2] ?? ''
    if (url.pathname.startsWith('/prewarm/')) {
      const key = `${url.searchParams.get('region') ?? 'default'}:${url.searchParams.has('wrongSecret')}`
      let route = factories.get(key)
      if (!route || url.searchParams.has('fresh')) {
        route = createPrewarm(env, url)
        if (!url.searchParams.has('fresh')) factories.set(key, route)
      }
      const response = await route(request, undefined)
      return Response.json({ ...await response.json() as object, bindingCalls: calls.slice(start) }, {
        status: response.status, headers: response.headers,
      })
    }
    if (!validWorkspace(workspaceId)) return new Response(null, { status: 404 })
    if (url.pathname.startsWith('/chat/')) {
      const routes = createChatTurnRoutes({
        projectId: 'lock-prewarm-workerd-proof',
        authorize: async () => request.headers.get('authorization') === 'Bearer editor'
          ? { ok: true as const, tenantId: workspaceId, userId: 'editor', context: undefined }
          : { ok: false as const, response: new Response(null, { status: 403 }) },
        store: messages(env.DB),
        turnStore: bindings(env, url),
        produce: () => ({
          stream: (async function* () { yield { type: 'text', text: 'Local integration answer' } })(),
          finalText: () => 'Local integration answer',
        }),
        turnTrace: { sink: async () => {} },
        log: () => {},
      })
      const pending: Promise<unknown>[] = []
      const response = await routes.turn(request, { waitUntil: promise => { pending.push(promise) } })
      // The stream is consumed exactly once before waiting for its writer.
      const text = await response.text()
      await Promise.all(pending)
      return Response.json({ text, bindingCalls: calls.slice(start) }, { status: response.status, headers: response.headers })
    }
    const lock = createDefaultTurnLock(bindings(env, url))
    if (url.pathname.startsWith('/acquire/')) {
      const result = await lock.acquire(lockArgs(workspaceId, url))
      return Response.json({ acquired: result.acquired, ...(result.acquired ? { handle: result.handle } : {}),
        bindingCalls: calls.slice(start) })
    }
    if (url.pathname.startsWith('/release/')) {
      await lock.release(await request.json())
      return Response.json({ bindingCalls: calls.slice(start) })
    }
    if (url.pathname.startsWith('/warm/')) {
      await lock.warm({ tenantId: workspaceId })
      return Response.json({ bindingCalls: calls.slice(start) })
    }
    return new Response(null, { status: 404 })
  },
}
