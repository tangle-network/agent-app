/** Actual workerd consumer used only by durable-stop.integration.ts. No fake DO, storage, clock or model transport. */
import { TurnStreamDO, type TurnStreamDOState } from '../../src/turn-stream/do'
import { acquireDurableTurnLock, peekDurableTurnLock, releaseDurableTurnLock, createDurableTurnLock,
  createDurableObjectTurnEventStore, releaseInterruptedDurableTurnLock, reconcileStaleDurableTurnLock, type TurnStreamNamespaceLike } from '../../src/turn-stream/adapters'
import { connectDurableTurnCancellation, requestDurableTurnCancellation, type TurnCancellationIdentity } from '../../src/turn-stream/cancellation'
import { mintTurnStreamToken, TURN_STREAM_TOKEN_HEADER, turnLockChannelKey, turnLockStorageKey } from '../../src/turn-stream/core'
import { createChatTurnRoutes } from '../../src/chat-routes/turn-routes'
import type { ChatTurnMessageStore } from '../../src/chat-routes/turn-route-contracts'
import type { StaleTurnLockOwnerProbeResult } from '../../src/chat-routes/stale-turn-lock'

interface Statement {
  bind(...values: unknown[]): { run(): Promise<unknown>; all<T>(): Promise<{ results: T[] }> }
}
interface Env {
  TURNS: TurnStreamNamespaceLike
  SHORT_TURNS: TurnStreamNamespaceLike
  OUTAGE_TURNS: TurnStreamNamespaceLike
  DEFERRED_TURNS: TurnStreamNamespaceLike
  SHORT_DEFERRED_TURNS: TurnStreamNamespaceLike
  CHAT: { prepare(sql: string): Statement }
  TURN_STREAM_AUTH_SECRET: string
  MODEL_URL: string
}
interface Context { waitUntil(promise: Promise<unknown>): void }
export class FixtureTurnStream extends TurnStreamDO {
  protected async handleProductRequest(request: Request, url: URL) {
    if (url.pathname === '/fixture/sockets') return Response.json({ open: this.state.getWebSockets()
      .filter(socket => (socket as unknown as { readyState: number }).readyState === 1).length })
    if (url.pathname === '/fixture/close') {
      for (const socket of this.state.getWebSockets()) socket.close(1011, 'Fixture connection loss')
      return Response.json({ closed: true })
    }
    if (url.pathname === '/fixture/raw-lock') {
      const input = await request.json() as TurnCancellationIdentity
      return Response.json({ active: await this.state.storage.get(turnLockStorageKey(input.scope, input.threadId)) ?? null })
    }
    return super.handleProductRequest(request, url)
  }
}
export class ShortTurnStream extends FixtureTurnStream {
  constructor(state: TurnStreamDOState, env: Env) { super(state, env, { lockTtlMs: 1000 }) }
}
/** A real control-transport outage while the same actual DO storage still serves lock acquisition/release. */
export class ControlOutageTurnStream extends FixtureTurnStream {
  async fetch(request: Request) {
    if (request.headers.get('Upgrade') === 'websocket') return new Response('Fixture control outage', { status: 503 })
    return super.fetch(request)
  }
}
export class DeferredTurnStream extends FixtureTurnStream {
  protected async shouldDeferLockRelease(executionId: string) {
    const { results } = await (this.env as Env).CHAT.prepare('SELECT execution_id, status FROM child_holds WHERE execution_id = ? AND status != ?')
      .bind(executionId, 'settled').all<{ execution_id: string; status: string }>()
    if (results.some(row => row.status === 'read-error')) await (this.env as Env).CHAT.prepare('SELECT * FROM unavailable_child_owner')
      .bind().all()
    return results.length > 0
  }
}
export class ShortDeferredTurnStream extends DeferredTurnStream {
  constructor(state: TurnStreamDOState, env: Env) { super(state, env, { lockTtlMs: 1000 }) }
}

async function verifyViewerAuthority(namespace: TurnStreamNamespaceLike, input: TurnCancellationIdentity, env: Env, path: string) {
  const key = turnLockChannelKey(input.workspaceId, input.threadId, input.scope)
  const url = new URL('https://fixture.internal/')
  for (const [name, value] of Object.entries(input)) url.searchParams.set(name, value)
  url.searchParams.set('sessionId', input.threadId)
  if (path !== '/viewer') url.searchParams.set('cancellation', '1')
  const claims = path === '/wrong-identity-control' ? { purpose: 'turn-control' as const, identity: { ...input, lockId: 'not-the-owner' } }
    : path === '/wrong-purpose-control' ? { purpose: 'turn-cancel' as const, identity: input } : undefined
  const token = await mintTurnStreamToken(key, env.TURN_STREAM_AUTH_SECRET, undefined, undefined, claims)
  const response = await namespace.get(namespace.idFromName(key)).fetch(url.href,
    { headers: { Upgrade: 'websocket', [TURN_STREAM_TOKEN_HEADER]: token } }) as Response & { webSocket?: WebSocket & { accept(): void } }
  response.webSocket?.accept(); response.webSocket?.close(1000, 'Authority checked')
  return Response.json({ status: response.status })
}

async function recover(namespace: TurnStreamNamespaceLike, env: Env, input: TurnCancellationIdentity, grace: boolean) {
  const active = await peekDurableTurnLock(namespace, input, { secret: env.TURN_STREAM_AUTH_SECRET })
  if (!active) return { released: false, diagnostics: { ownerStatus: 'unknown' } }
  return reconcileStaleDurableTurnLock({ namespace, auth: { secret: env.TURN_STREAM_AUTH_SECRET }, active,
    workspaceId: input.workspaceId, threadId: input.threadId, terminalGraceMs: grace ? 1000 : 0,
    // Actual HTTP probes must not run when an outer Router owner is being judged.
    probeSandbox: async () => (await fetch(`${env.MODEL_URL}/native-probe`)).json(),
    probeSession: async () => (await fetch(`${env.MODEL_URL}/native-session-probe`)).json(),
    probeOwner: async (identity): Promise<StaleTurnLockOwnerProbeResult> => {
      const { results } = await env.CHAT.prepare('SELECT * FROM owner_evidence WHERE turn_stream_id = ?')
        .bind(identity.turnStreamId).all<{ workspace_id: string; thread_id: string; scope: 'thread' | 'workspace';
          execution_id: string; lock_id: string; turn_stream_id: string; status: 'live' | 'abandoned' | 'unknown' }>()
      const row = results[0]
      return row ? { status: row.status, identity: { workspaceId: row.workspace_id, threadId: row.thread_id, scope: row.scope,
        executionId: row.execution_id, lockId: row.lock_id, turnStreamId: row.turn_stream_id } } : { identity, status: 'unknown' }
    }, log: () => {},
  })
}

function messages(env: Env): ChatTurnMessageStore {
  return {
    async listMessages(threadId) {
      const { results } = await env.CHAT.prepare('SELECT id, role, content, parts FROM messages WHERE thread_id = ? ORDER BY rowid')
        .bind(threadId).all<{ id: string; role: 'user' | 'assistant' | 'system' | 'tool'; content: string; parts: string | null }>()
      return results.map(row => ({ ...row, parts: row.parts ? JSON.parse(row.parts) : null }))
    },
    async appendMessage(input) {
      const id = input.id ?? crypto.randomUUID()
      await env.CHAT.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)')
        .bind(id, input.threadId, input.role, input.content, input.parts ? JSON.stringify(input.parts) : null).run()
      return { id }
    },
  }
}

function routes(env: Env) {
  let signal: AbortSignal | undefined
  const baseLock = createDurableTurnLock({ namespace: env.TURNS, auth: { secret: env.TURN_STREAM_AUTH_SECRET },
    scopeOf: () => 'thread', cancellationOf: () => true })
  return createChatTurnRoutes({ projectId: 'durable-stop-fixture', store: messages(env),
    turnStore: createDurableObjectTurnEventStore(env.TURNS, { secret: env.TURN_STREAM_AUTH_SECRET }),
    turnTrace: false, log: () => {},
    authorize: async ({ request, threadId }) => {
      const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? ''
      const { results } = await env.CHAT.prepare('SELECT user_id, workspace_id, role FROM members WHERE token = ?')
        .bind(token).all<{ user_id: string; workspace_id: string; role: string }>()
      const member = results[0]
      if (!member) return { ok: false as const, response: new Response('Unauthorized', { status: 401 }) }
      const thread = await env.CHAT.prepare('SELECT workspace_id FROM threads WHERE id = ?')
        .bind(threadId).all<{ workspace_id: string }>()
      if (member.role !== 'editor' || thread.results[0]?.workspace_id !== member.workspace_id) {
        return { ok: false as const, response: new Response('Forbidden', { status: 403 }) }
      }
      return { ok: true as const, tenantId: member.workspace_id, userId: member.user_id,
        context: { signal: undefined as AbortSignal | undefined } }
    },
    cancel: { async target(args) {
      await env.CHAT.prepare('INSERT INTO target_reads VALUES (?, ?)').bind(args.body.threadId, args.messageId ? 'observation' : 'request').run()
      const { results } = await env.CHAT.prepare('SELECT metadata FROM control_targets WHERE thread_id = ? AND client_turn_id = ?')
        .bind(args.body.threadId, args.body.turnId).all<{ metadata: string }>()
      if (!results[0]) return new Response('Target not found', { status: 404 })
      const captured = JSON.parse(results[0].metadata) as TurnCancellationIdentity & Record<string, unknown> & { dispatchToken: string; responseStatus: string }
      if (captured.workspaceId !== args.tenantId) return new Response('Forbidden', { status: 403 })
      return { capturedMetadata: captured, status: captured.responseStatus, requiresDispatchToken: true, dispatchToken: captured.dispatchToken,
        control: { async request(snapshot: Record<string, unknown>) {
          const current = await env.CHAT.prepare('SELECT metadata FROM control_targets WHERE thread_id = ?').bind(args.body.threadId).all<{ metadata: string }>()
          if (current.results[0]?.metadata !== JSON.stringify(snapshot)) return { requested: false }
          return requestDurableTurnCancellation(env.TURNS, captured, { secret: env.TURN_STREAM_AUTH_SECRET })
        } },
        async markStopped(snapshot: Record<string, unknown>, stoppedAt: string) {
          await env.CHAT.prepare('INSERT INTO forbidden_effects VALUES (?)').bind('premature-stopped').run()
          const updated = await env.CHAT.prepare('UPDATE control_targets SET metadata = ? WHERE thread_id = ? AND metadata = ? RETURNING thread_id')
            .bind(JSON.stringify({ ...snapshot, responseStatus: 'stopped', stoppedAt }), args.body.threadId, JSON.stringify(snapshot)).all()
          return updated.results.length > 0
        },
      }
    } },
    turnLock: { ...baseLock, async acquire(args) {
      const acquired = await baseLock.acquire(args)
      if (!acquired.acquired) return acquired
      try {
        const captured = { ...(acquired.handle as TurnCancellationIdentity), turnStreamId: args.turnStreamId,
          dispatchToken: `dispatch-${args.executionId}`, responseStatus: 'running' }
        await env.CHAT.prepare('INSERT OR REPLACE INTO control_targets VALUES (?, ?, ?)')
          .bind(args.identity.sessionId, args.body.turnId ?? '', JSON.stringify(captured)).run()
        await fetch(`${env.MODEL_URL}/admitted`, { method: 'POST' })
        return acquired
      } catch (error) {
        acquired.cancellation?.close()
        await baseLock.release(acquired.handle)
        throw error
      }
    }, async release(handle) {
      await baseLock.release(handle)
      await fetch(`${env.MODEL_URL}/released`, { method: 'POST', body: JSON.stringify({ aborted: signal?.aborted }) })
    } },
    produce: { router(args) {
      args.context.signal = args.admissionSignal
      signal = args.admissionSignal
      return { apiKey: 'fixture-no-spend', model: 'fixture/model', baseUrl: env.MODEL_URL,
        systemPrompt: 'Answer the member.', repeat: false }
    } },
    lifecycle: {
      async onTurnError(info) {
        const reason = info.context.signal?.reason as { code?: string } | undefined
        await env.CHAT.prepare('INSERT INTO effects VALUES (?, ?)').bind(info.turnStreamId, reason?.code ?? 'unknown').run()
        // The actual consumer has a terminal effect to finish. Hold it through a real HTTP boundary.
        await fetch(`${env.MODEL_URL}/settlement`, { method: 'POST' })
        await env.CHAT.prepare("UPDATE control_targets SET metadata = json_set(metadata, '$.responseStatus', 'error') WHERE thread_id = ? AND json_extract(metadata, '$.executionId') = ?")
          .bind(info.identity.sessionId, info.executionId).run()
      },
      async onTurnComplete(info) {
        await env.CHAT.prepare('INSERT INTO effects VALUES (?, ?)').bind(info.turnStreamId, 'complete').run()
        await fetch(`${env.MODEL_URL}/settlement`, { method: 'POST' })
        await env.CHAT.prepare("UPDATE control_targets SET metadata = json_set(metadata, '$.responseStatus', 'answered') WHERE thread_id = ? AND json_extract(metadata, '$.executionId') = ?")
          .bind(info.identity.sessionId, info.executionId).run()
      },
    },
  })
}

export default {
  async fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    const url = new URL(request.url)
    // Product endpoints use shared authorization/target ownership and actual SQLite access records.
    if (url.pathname === '/turn') return routes(env).turn(request, { waitUntil: promise => ctx.waitUntil(promise) })
    if (url.pathname === '/cancel') return routes(env).cancel(request)
    // Remaining endpoints expose only isolated integration protocol boundaries.
    if (request.headers.get('Authorization') !== 'Bearer fixture-authorized-member') return new Response('Unauthorized', { status: 401 })
    const namespace = url.searchParams.get('deferred') === '1' && url.searchParams.get('short') === '1' ? env.SHORT_DEFERRED_TURNS
      : url.searchParams.get('deferred') === '1' ? env.DEFERRED_TURNS
      : url.searchParams.get('short') === '1' ? env.SHORT_TURNS
      : url.searchParams.get('outage') === '1' ? env.OUTAGE_TURNS : env.TURNS
    const input = await request.json() as TurnCancellationIdentity & {
      ownerStatus?: 'live' | 'abandoned' | 'unknown'; childStatus?: 'pending' | 'unknown' | 'read-error'
    }
    const auth = { secret: env.TURN_STREAM_AUTH_SECRET }
    if (['/viewer', '/viewer-control', '/wrong-identity-control', '/wrong-purpose-control'].includes(url.pathname)) {
      return verifyViewerAuthority(namespace, input, env, url.pathname)
    }
    if (url.pathname === '/viewer-stop' || url.pathname === '/viewer-recover') {
      const key = turnLockChannelKey(input.workspaceId, input.threadId, input.scope)
      const response = await namespace.get(namespace.idFromName(key)).fetch('https://fixture.internal/chat-turn-lock/release-interrupted', {
        method: 'POST', headers: { [TURN_STREAM_TOKEN_HEADER]: await mintTurnStreamToken(key, auth.secret) },
        body: JSON.stringify({ ...input, ...(url.pathname === '/viewer-stop' ? { cancel: true } : { interruptedAt: Date.now(), recovery: input }) }),
      })
      return new Response(response.body, { status: response.status, headers: response.headers })
    }
    if (url.pathname === '/lock') return Response.json(await acquireDurableTurnLock(namespace,
      { ...input, cancellation: { turnStreamId: input.turnStreamId } }, auth))
    if (url.pathname === '/native-lock') return Response.json(await acquireDurableTurnLock(namespace, input, auth))
    if (url.pathname === '/legacy-interrupt') return Response.json({ released: await releaseInterruptedDurableTurnLock(namespace,
      { ...input, interruptedAt: Date.now() }, auth) })
    if (url.pathname === '/peek') {
      try { return Response.json({ active: await peekDurableTurnLock(namespace, input, auth) }) }
      catch { return Response.json({ error: 'Ownership read unavailable' }, { status: 503 }) }
    }
    if (url.pathname === '/status') return Response.json({ status: await createDurableObjectTurnEventStore(namespace, auth).getStatus(input.turnStreamId) })
    if (url.pathname === '/stop') return Response.json(await requestDurableTurnCancellation(namespace, input, auth))
    if (url.pathname === '/release') return Response.json(await releaseDurableTurnLock(namespace, input, auth))
    if (url.pathname === '/owner-evidence') {
      await env.CHAT.prepare('INSERT OR REPLACE INTO owner_evidence VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(input.workspaceId, input.threadId, input.scope, input.executionId, input.lockId, input.turnStreamId, input.ownerStatus ?? 'unknown').run()
      return Response.json({ recorded: true })
    }
    if (url.pathname === '/hold-child' || url.pathname === '/clear-child') {
      if (url.pathname === '/hold-child') await env.CHAT.prepare('INSERT OR REPLACE INTO child_holds VALUES (?, ?, ?, ?)')
        .bind(input.executionId, input.lockId, input.turnStreamId, input.childStatus ?? 'pending').run()
      else await env.CHAT.prepare('UPDATE child_holds SET status = ? WHERE execution_id = ? AND lock_id = ? AND turn_stream_id = ?')
        .bind('settled', input.executionId, input.lockId, input.turnStreamId).run()
      return Response.json({ recorded: true })
    }
    if (url.pathname === '/recover') return Response.json(await recover(namespace, env, input, url.searchParams.has('grace')))
    if (url.pathname === '/recover-exact') return Response.json({ released: await releaseInterruptedDurableTurnLock(namespace,
      { ...input, interruptedAt: Date.now(), recovery: input }, auth) })
    if (url.pathname === '/recover-with-control') {
      const connection = await connectDurableTurnCancellation(namespace, input, auth)
      try { return Response.json(await recover(namespace, env, input, false)) }
      finally { connection.close() }
    }
    if (url.pathname === '/observe') {
      const connection = await connectDurableTurnCancellation(namespace, input, auth).catch(() => null)
      if (!connection) return Response.json({ refused: true }, { status: 409 })
      const aborted = connection.signal.aborted
      connection.close()
      return Response.json({ aborted })
    }
    if (url.pathname === '/observe-race') {
      const connected = connectDurableTurnCancellation(namespace, input, auth)
      const stopped = requestDurableTurnCancellation(namespace, input, auth)
      const connection = await connected
      await stopped
      if (!connection.signal.aborted) await new Promise<void>(resolve => connection.signal.addEventListener('abort', () => resolve(), { once: true }))
      connection.close()
      return Response.json({ aborted: connection.signal.aborted })
    }
    if (url.pathname === '/observe-before-sync') {
      // Deterministic connection race: Stop lands after the real upgrade but before the client's sync.
      const key = turnLockChannelKey(input.workspaceId, input.threadId, input.scope)
      const upgrade = new URL('https://fixture.internal/')
      for (const [name, value] of Object.entries(input)) upgrade.searchParams.set(name, value)
      upgrade.searchParams.set('sessionId', input.threadId)
      upgrade.searchParams.set('cancellation', '1')
      const response = await namespace.get(namespace.idFromName(key)).fetch(upgrade.href, { headers: {
        Upgrade: 'websocket', [TURN_STREAM_TOKEN_HEADER]: await mintTurnStreamToken(key, auth.secret, undefined, undefined,
          { purpose: 'turn-control', identity: input }),
      } }) as Response & { webSocket: WebSocket & { accept(): void } }
      if (response.status !== 101) throw new Error(`Upgrade failed: ${response.status}`)
      await requestDurableTurnCancellation(namespace, input, auth)
      const socket = response.webSocket
      const replay = new Promise<boolean>((resolve, reject) => {
        socket.addEventListener('message', event => {
          const message = JSON.parse(String(event.data)) as { type: string; cancellationRequested: boolean }
          if (message.type === 'turn.control') resolve(message.cancellationRequested)
        })
        socket.addEventListener('close', () => reject(new Error('Control closed before replay')))
      })
      socket.accept(); socket.send(JSON.stringify({ type: 'sync' }))
      const aborted = await replay
      socket.close(1000, 'Replay checked')
      return Response.json({ aborted })
    }
    if (url.pathname === '/setup-failure') {
      const lock = createDurableTurnLock({ namespace, auth, scopeOf: () => input.scope, cancellationOf: () => true })
      try { await lock.acquire({ identity: { tenantId: input.workspaceId, sessionId: input.threadId },
        executionId: input.executionId, turnStreamId: input.turnStreamId, context: {}, body: {} }) }
      catch (error) { return Response.json({ failed: true, message: error instanceof Error ? error.message : 'Unknown' }) }
      throw new Error('Expected a real control setup failure')
    }
    const key = turnLockChannelKey(input.workspaceId, input.threadId, input.scope)
    const tokenKey = url.pathname === '/cross-channel' ? turnLockChannelKey('another-workspace', input.threadId, input.scope) : key
    const headers = url.pathname === '/raw-unauthenticated' ? {} : { [TURN_STREAM_TOKEN_HEADER]: await mintTurnStreamToken(tokenKey, auth.secret) }
    const path = url.pathname === '/close' ? '/fixture/close' : url.pathname === '/sockets' ? '/fixture/sockets'
      : url.pathname === '/raw-lock' ? '/fixture/raw-lock' : '/chat-turn-lock/peek'
    const response = await namespace.get(namespace.idFromName(key)).fetch(`https://fixture.internal${path}`,
      { method: 'POST', headers, body: JSON.stringify(input) })
    return new Response(response.body, { status: response.status, headers: response.headers })
  },
}
