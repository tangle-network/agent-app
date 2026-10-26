/** Actual workerd transport fixture, shared by the complete route proof and its bounded transport diagnostic. */
import { TurnStreamDO, type TurnStreamDOState } from '../../src/turn-stream/do'
// The consumer's installed, published agent-app: an actual DO from before /chat-turn-lock/park (aliased by the integration's Wrangler config).
import { TurnStreamDO as PublishedTurnStreamDO, TURN_STREAM_PATHS as PUBLISHED_TURN_STREAM_PATHS } from 'agent-app-published-turn-stream'
import { acquireDurableTurnLock, peekDurableTurnLock, releaseDurableTurnLock, parkDurableTurnLock, createDurableTurnLock,
  createDurableObjectTurnEventStore, releaseInterruptedDurableTurnLock, reconcileStaleDurableTurnLock, type TurnStreamNamespaceLike } from '../../src/turn-stream/adapters'
import { connectDurableTurnCancellation, requestDurableTurnCancellation, type TurnCancellationIdentity } from '../../src/turn-stream/cancellation'
import { mintTurnStreamToken, TURN_STREAM_PATHS, TURN_STREAM_TOKEN_HEADER, turnLockChannelKey, turnLockStorageKey, type TurnStreamTokenClaims } from '../../src/turn-stream/core'
import type { StaleTurnLockOwnerProbeResult } from '../../src/chat-routes/stale-turn-lock'

interface Statement {
  bind(...values: unknown[]): { run(): Promise<unknown>; all<T>(): Promise<{ results: T[] }> }
}
export interface StopFixtureEnv {
  TURNS: TurnStreamNamespaceLike
  SHORT_TURNS: TurnStreamNamespaceLike
  OUTAGE_TURNS: TurnStreamNamespaceLike
  DEFERRED_TURNS: TurnStreamNamespaceLike
  SHORT_DEFERRED_TURNS: TurnStreamNamespaceLike
  PUBLISHED_TURNS: TurnStreamNamespaceLike
  BARRIER_TURNS: TurnStreamNamespaceLike
  CHAT: { prepare(sql: string): Statement }
  TURN_STREAM_AUTH_SECRET: string
  MODEL_URL: string
}
export interface StopFixtureContext { waitUntil(promise: Promise<unknown>): void }
export class FixtureTurnStream extends TurnStreamDO {
  protected async handleProductRequest(request: Request, url: URL) {
    if (url.pathname === '/fixture/sockets') return Response.json({ open: this.state.getWebSockets()
      .filter(socket => (socket as unknown as { readyState: number }).readyState === 1).length })
    if (url.pathname === '/fixture/close') {
      for (const socket of this.state.getWebSockets()) socket.close(1011, 'Fixture connection loss')
      return Response.json({ closed: true })
    }
    if (url.pathname === '/fixture/complete-deferred') {
      const input = await request.json() as TurnCancellationIdentity
      return Response.json({ completed: await this.completeDeferredLockRelease(input.executionId) })
    }
    if (url.pathname === '/fixture/raw-lock') {
      const input = await request.json() as TurnCancellationIdentity
      return Response.json({ active: await this.state.storage.get(turnLockStorageKey(input.scope, input.threadId)) ?? null })
    }
    return super.handleProductRequest(request, url)
  }
}
export class PublishedTurnStream extends PublishedTurnStreamDO {}
export class ShortTurnStream extends FixtureTurnStream {
  constructor(state: TurnStreamDOState, env: StopFixtureEnv) { super(state, env, { lockTtlMs: 1000 }) }
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
    const { results } = await (this.env as StopFixtureEnv).CHAT.prepare('SELECT execution_id, status FROM child_holds WHERE execution_id = ? AND status != ?')
      .bind(executionId, 'settled').all<{ execution_id: string; status: string }>()
    if (results.some(row => row.status === 'read-error')) await (this.env as StopFixtureEnv).CHAT.prepare('SELECT * FROM unavailable_child_owner')
      .bind().all()
    return results.length > 0
  }
}
export class ShortDeferredTurnStream extends DeferredTurnStream {
  constructor(state: TurnStreamDOState, env: StopFixtureEnv) { super(state, env, { lockTtlMs: 1000 }) }
}

/** A real external ownership read deliberately held by the local HTTP peer. */
export class BarrierTurnStream extends FixtureTurnStream {
  constructor(state: TurnStreamDOState, env: StopFixtureEnv) { super(state, env, { lockTtlMs: 1000 }) }
  protected async shouldDeferLockRelease(executionId: string) {
    const response = await fetch(`${(this.env as StopFixtureEnv).MODEL_URL}/deferral?executionId=${encodeURIComponent(executionId)}`)
    return (await response.json() as { defer: boolean }).defer
  }
}

async function verifyViewerAuthority(namespace: TurnStreamNamespaceLike, input: TurnCancellationIdentity, env: StopFixtureEnv, path: string) {
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

async function recover(namespace: TurnStreamNamespaceLike, env: StopFixtureEnv, input: TurnCancellationIdentity, grace: boolean) {
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

export async function handleDurableStopTransport(request: Request, env: StopFixtureEnv): Promise<Response> {
    const url = new URL(request.url)
    // Remaining endpoints expose only isolated integration protocol boundaries.
    if (request.headers.get('Authorization') !== 'Bearer fixture-authorized-member') return new Response('Unauthorized', { status: 401 })
    const namespace = url.searchParams.has('barrier') ? env.BARRIER_TURNS
      : url.searchParams.has('published') ? env.PUBLISHED_TURNS
      : url.searchParams.get('deferred') === '1' && url.searchParams.get('short') === '1' ? env.SHORT_DEFERRED_TURNS
      : url.searchParams.get('deferred') === '1' ? env.DEFERRED_TURNS
      : url.searchParams.get('short') === '1' ? env.SHORT_TURNS
      : url.searchParams.get('outage') === '1' ? env.OUTAGE_TURNS : env.TURNS
    const input = await request.json() as TurnCancellationIdentity & {
      ownerStatus?: 'live' | 'abandoned' | 'unknown'; childStatus?: 'pending' | 'unknown' | 'read-error'
    }
    const auth = { secret: env.TURN_STREAM_AUTH_SECRET }
    if (url.pathname === '/purpose-capability') {
      const purpose = url.searchParams.get('purpose') as TurnStreamTokenClaims['purpose']
      const operation = url.searchParams.get('operation')!
      const key = turnLockChannelKey(input.workspaceId, input.threadId, input.scope)
      const token = await mintTurnStreamToken(key, auth.secret, undefined, undefined, { purpose, identity: input })
      const paths: Record<string, string> = { acquire: TURN_STREAM_PATHS.lockAcquire, release: TURN_STREAM_PATHS.lockRelease,
        interrupt: TURN_STREAM_PATHS.lockReleaseInterrupted, status: TURN_STREAM_PATHS.turnStatusSet, product: '/fixture/raw-lock' }
      const target = new URL(`https://fixture.internal${paths[operation] ?? '/'}`)
      const headers: Record<string, string> = { [TURN_STREAM_TOKEN_HEADER]: token }
      if (operation === 'viewer') { headers.Upgrade = 'websocket'; target.searchParams.set('sessionId', input.threadId) }
      const response = await namespace.get(namespace.idFromName(key)).fetch(target.href, { method: operation === 'viewer' ? 'GET' : 'POST', headers,
        ...(operation === 'viewer' ? {} : { body: JSON.stringify({ ...input, interruptedAt: Date.now(), turnId: input.turnStreamId, status: 'complete' }) }) }) as Response & { webSocket?: WebSocket & { accept(): void } }
      response.webSocket?.accept(); response.webSocket?.close(1000, 'Capability checked')
      return Response.json({ status: response.status })
    }
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
    if (url.pathname === '/park') {
      try { return Response.json({ parked: await parkDurableTurnLock(namespace, input, auth) }) }
      catch (error) { return Response.json({ parked: false, refused: error instanceof Error ? error.message : String(error) }) }
    }
    if (url.pathname === '/published-paths') return Response.json({ paths: PUBLISHED_TURN_STREAM_PATHS })
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
      let connection
      try { connection = await connectDurableTurnCancellation(namespace, input, auth) }
      catch (error) { return Response.json({ refused: true, error: error instanceof Error ? error.message : String(error) }, { status: 409 }) }
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
    const headers: Record<string, string> = url.pathname === '/raw-unauthenticated' ? {} : { [TURN_STREAM_TOKEN_HEADER]: await mintTurnStreamToken(tokenKey, auth.secret) }
    const path = url.pathname === '/close' ? '/fixture/close' : url.pathname === '/sockets' ? '/fixture/sockets'
      : url.pathname === '/raw-lock' ? '/fixture/raw-lock' : url.pathname === '/complete-deferred' ? '/fixture/complete-deferred' : '/chat-turn-lock/peek'
    const response = await namespace.get(namespace.idFromName(key)).fetch(`https://fixture.internal${path}`,
      { method: 'POST', headers, body: JSON.stringify(input) })
    return new Response(response.body, { status: response.status, headers: response.headers })
}

export default { fetch: handleDurableStopTransport }
