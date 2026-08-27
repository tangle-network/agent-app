/**
 * `TurnStreamDO` — the shared Durable Object transport shell over the pure
 * core (`./core`). One class serves every channel family; the instance NAME
 * decides which endpoints a given instance ever sees:
 *
 * - **thread channel** (`${workspaceId}:${threadId}`) — the live chat turn:
 *   WebSocket fanout, per-turn segments with `sync`/`afterSeq` reconnect
 *   replay, and the thread-scope lock.
 * - **workspace channel** (`${workspaceId}`) — coarse sidebar signals
 *   (`thread.activity` responding set, durable across eviction;
 *   `thread.created` recent list) and the workspace-scope lock.
 * - **turn storage** (`turn:${turnId}`) — the durable `TurnEventStore` rows +
 *   status for one buffered turn (replay survives DO eviction — this is what
 *   graduates the vertical's `turnStore` from no-op).
 * - **scope index** (`scope:${scopeId}`) — the running-turn index backing
 *   `TurnEventStore.listRunning` reconnect discovery.
 *
 * The class is a PLAIN class over a structural {@link TurnStreamDOState} —
 * no `cloudflare:workers` import, so this package stays substrate-free and
 * the DO is unit-testable in Node. Cloudflare's `DurableObjectState`
 * satisfies the interface; a product binds it in wrangler by re-exporting:
 *
 *   // worker entry
 *   export { TurnStreamDO } from '@tangle-network/agent-app/turn-stream'
 *
 * Fan-out enumerates `state.getWebSockets()` (never an in-memory socket map)
 * and reads per-socket metadata from the serialized attachment, so it is
 * correct across WebSocket hibernation.
 *
 * Product extension (how the reference consumer keeps its Vault machinery
 * while deleting its fork): subclass and override
 * {@link TurnStreamDO.handleProductRequest} (extra POST endpoints),
 * {@link TurnStreamDO.shouldDeferLockRelease} /
 * {@link TurnStreamDO.completeDeferredLockRelease} (park a lock release
 * behind a product-owned post-turn task), and
 * {@link TurnStreamDO.productSyncEvents} (extra state replayed to a
 * late-connecting socket). Product storage keys must avoid
 * {@link TURN_STREAM_STORAGE_KEYS}.
 */

import {
  ACTIVITY_TTL_MS,
  MAX_RECENT_CREATED,
  MAX_SEGMENT_EVENTS,
  TURN_LOCK_TTL_MS,
  TURN_STREAM_PATHS,
  TURN_STREAM_STORAGE_KEYS,
  activeTurnLock,
  appendSegmentEvent,
  createSegmentStore,
  createTurnLock,
  interruptedReleaseApplies,
  isTerminalRunEvent,
  pruneStaleThreads,
  replayActiveSegment,
  turnEventStorageKey,
  turnLockMatchesRelease,
  type DurableTurnLock,
  type TurnLockAcquireResult,
  type TurnLockScope,
  type TurnStreamEvent,
} from './core'

// ── structural Cloudflare surface ───────────────────────────────────────────

/** The socket surface the DO touches. Cloudflare's hibernatable `WebSocket`
 *  satisfies it. */
export interface TurnStreamSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
}

/** The storage surface the DO touches (Cloudflare `DurableObjectStorage`
 *  satisfies it structurally). `list` must return keys in ascending order —
 *  the turn-event rows rely on it for replay order. */
export interface TurnStreamStorage {
  get<T = unknown>(key: string): Promise<T | undefined>
  put<T = unknown>(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean | void>
  list<T = unknown>(options: { prefix: string; start?: string }): Promise<Map<string, T>>
}

/** The `DurableObjectState` surface the DO uses. */
export interface TurnStreamDOState {
  storage: TurnStreamStorage
  acceptWebSocket(ws: TurnStreamSocket): void
  getWebSockets(): TurnStreamSocket[]
}

interface SocketMeta {
  sessionId: string
  scope: 'thread' | 'workspace'
  /** Live fan-out is withheld until the client has run its initial `sync`
   *  (see {@link TurnStreamDO.webSocketMessage}). This makes replay and live
   *  delivery mutually exclusive per socket, so frames can neither interleave
   *  out of order nor drop in the connect race. */
  synced: boolean
}

// ── request/response plumbing ───────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const body = await request.json().catch(() => null)
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
}

/** Per-scope running-turn index entry (one record per buffered turn). */
interface ScopeTurnEntry {
  status: 'running' | 'complete' | 'error'
  updatedAt: number
}

/** Cap on remembered turns per scope; oldest terminal entries are pruned
 *  first, so a busy thread's index stays bounded without ever dropping a
 *  still-running turn. */
const MAX_SCOPE_TURNS = 100

// ── the DO ──────────────────────────────────────────────────────────────────

/** Define options to override default TTL and event limits for TURN stream DO operations */
export interface TurnStreamDOOptions {
  /** Override {@link TURN_LOCK_TTL_MS}. */
  lockTtlMs?: number
  /** Override {@link MAX_SEGMENT_EVENTS}. */
  maxSegmentEvents?: number
  /** Override {@link ACTIVITY_TTL_MS}. */
  activityTtlMs?: number
}

/** Manage per-turn segments and track active threads with durable event storage */
export class TurnStreamDO {
  protected readonly state: TurnStreamDOState
  protected readonly env: unknown
  protected readonly options: TurnStreamDOOptions

  // Thread channel: per-turn segments; only the active one is replayed.
  private segments = createSegmentStore()
  // Workspace channel: recent thread.created markers (in-memory, best-effort)
  // + durable responding set (threadId → startedAt) that survives eviction.
  private recentCreated: TurnStreamEvent[] = []
  private activeThreads: Map<string, number> | null = null

  constructor(state: TurnStreamDOState, env?: unknown, options: TurnStreamDOOptions = {}) {
    this.state = state
    this.env = env
    this.options = options
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(request, url)
    }

    if (request.method === 'POST') {
      switch (url.pathname) {
        case TURN_STREAM_PATHS.broadcast:
          return this.handleBroadcast(request)
        case TURN_STREAM_PATHS.lockAcquire:
          return this.handleLockAcquire(request)
        case TURN_STREAM_PATHS.lockRelease:
          return this.handleLockRelease(request)
        case TURN_STREAM_PATHS.lockReleaseInterrupted:
          return this.handleLockReleaseInterrupted(request)
        case TURN_STREAM_PATHS.turnEventsAppend:
          return this.handleTurnEventsAppend(request)
        case TURN_STREAM_PATHS.turnEventsRead:
          return this.handleTurnEventsRead(request)
        case TURN_STREAM_PATHS.turnStatusSet:
          return this.handleTurnStatusSet(request)
        case TURN_STREAM_PATHS.turnStatusGet:
          return this.handleTurnStatusGet()
        case TURN_STREAM_PATHS.scopeStatusSet:
          return this.handleScopeStatusSet(request)
        case TURN_STREAM_PATHS.scopeRunningList:
          return this.handleScopeRunningList()
      }
    }

    const product = await this.handleProductRequest(request, url)
    if (product) return product
    return request.method === 'POST'
      ? jsonResponse({ error: `Unknown turn-stream endpoint ${url.pathname}` }, 404)
      : new Response('Method not allowed', { status: 405 })
  }

  // ── product extension seam ────────────────────────────────────────────────

  /** Called for any request no base endpoint claimed (before the 404), so a
   *  subclass adds product endpoints without touching base routing. Return
   *  `null` to decline. */
  protected async handleProductRequest(_request: Request, _url: URL): Promise<Response | null> {
    return null
  }

  /** Consulted before any lock release (cooperative, interrupted, or the
   *  terminal-event auto-release). Return `true` while a product-owned
   *  post-turn task for `executionId` must keep the scope serialized (e.g.
   *  file persistence still reading the box) — the release is then parked as
   *  `releasePending` on the lock and completed via
   *  {@link completeDeferredLockRelease}. Base: never defer. */
  protected async shouldDeferLockRelease(_executionId: string): Promise<boolean> {
    return false
  }

  /** Complete a release parked by {@link shouldDeferLockRelease}. A subclass
   *  calls this when its deferred condition settles. */
  protected async completeDeferredLockRelease(executionId: string): Promise<boolean> {
    const active = await this.loadActiveLock()
    if (!active?.releasePending || active.executionId !== executionId) return false
    await this.state.storage.delete(TURN_STREAM_STORAGE_KEYS.lock)
    return true
  }

  /** Extra product state replayed to a socket during its `sync`, after the
   *  base replay for its scope (e.g. an in-flight persistence status card).
   *  Base: none. */
  protected async productSyncEvents(_scope: 'thread' | 'workspace', _meta: { sessionId: string }): Promise<TurnStreamEvent[]> {
    return []
  }

  // ── WebSocket channel ─────────────────────────────────────────────────────

  private handleWebSocketUpgrade(_request: Request, url: URL): Response {
    const sessionId = url.searchParams.get('sessionId')
    if (!sessionId) return new Response('Missing sessionId', { status: 400 })
    const scope = url.searchParams.get('scope') === 'workspace' ? 'workspace' : 'thread'

    const PairCtor = (globalThis as { WebSocketPair?: new () => Record<number, unknown> }).WebSocketPair
    if (!PairCtor) {
      return new Response('WebSocket upgrades require the Cloudflare runtime', { status: 501 })
    }
    const pair = new PairCtor()
    const client = pair[0]
    const server = pair[1] as TurnStreamSocket

    // Accept for hibernation and record routing metadata. No replay is pushed
    // here: sending before the client finishes the 101 handshake is racy
    // (frames can drop). The client issues a `sync` once open; replay happens
    // there.
    this.state.acceptWebSocket(server)
    server.serializeAttachment({ sessionId, scope, synced: false } satisfies SocketMeta)

    return new Response(null, { status: 101, webSocket: client } as ResponseInit)
  }

  /**
   * First (and only) client message after open: `{ type: 'sync', afterSeq }`.
   * Replays the current state for the socket's scope, then marks it `synced`
   * so live broadcasts start flowing. Because the DO is single-threaded, the
   * replay snapshot and the synced flip are atomic w.r.t. broadcasts — every
   * event reaches the socket exactly once, in order, via replay XOR live
   * fan-out.
   */
  async webSocketMessage(ws: TurnStreamSocket, message: string | ArrayBuffer): Promise<void> {
    const meta = ws.deserializeAttachment() as SocketMeta | null
    if (!meta || meta.synced) return
    let afterSeq = 0
    try {
      const parsed = JSON.parse(typeof message === 'string' ? message : '') as { type?: string; afterSeq?: number }
      if (parsed.type !== 'sync') return
      afterSeq = typeof parsed.afterSeq === 'number' ? parsed.afterSeq : 0
    } catch {
      return
    }

    if (meta.scope === 'workspace') {
      // Current responding state as synthetic `start` markers.
      const active = await this.loadActiveThreads()
      const removed = pruneStaleThreads(active, Date.now(), this.options.activityTtlMs ?? ACTIVITY_TTL_MS)
      if (removed.length > 0) await this.persistActiveThreads(active)
      for (const [threadId, startedAt] of active) {
        this.trySend(ws, {
          type: 'thread.activity',
          data: { threadId, phase: 'start', sessionId: meta.sessionId },
          timestamp: startedAt,
        })
      }
      // Recently-created threads for late joiners.
      for (const event of this.recentCreated) this.trySend(ws, event)
    } else {
      // The active, non-terminal turn segment from the cursor.
      for (const event of replayActiveSegment(this.segments, afterSeq)) {
        this.trySend(ws, event)
      }
    }
    for (const event of await this.productSyncEvents(meta.scope, { sessionId: meta.sessionId })) {
      this.trySend(ws, event)
    }

    ws.serializeAttachment({ ...meta, synced: true } satisfies SocketMeta)
  }

  webSocketClose(ws: TurnStreamSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason)
    } catch {
      // Already closed.
    }
  }

  webSocketError(): void {
    // Socket dropped; getWebSockets() will no longer include it.
  }

  private trySend(ws: TurnStreamSocket, event: TurnStreamEvent): void {
    try {
      ws.send(JSON.stringify(event))
    } catch {
      // Client may not be ready yet, or is closing.
    }
  }

  // ── broadcast (live fanout + segments + activity) ─────────────────────────

  private async handleBroadcast(request: Request): Promise<Response> {
    const incoming = (await request.json()) as TurnStreamEvent
    const data = (incoming.data ?? {}) as Record<string, unknown>
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined
    let outgoing: TurnStreamEvent = incoming

    if (incoming.type === 'thread.activity') {
      const threadId = typeof data.threadId === 'string' ? data.threadId : undefined
      if (threadId) {
        const active = await this.loadActiveThreads()
        if (data.phase === 'end') active.delete(threadId)
        else active.set(threadId, Date.now())
        await this.persistActiveThreads(active)
      }
    } else if (incoming.type === 'thread.created') {
      this.recentCreated.push(incoming)
      if (this.recentCreated.length > MAX_RECENT_CREATED) {
        this.recentCreated = this.recentCreated.slice(-MAX_RECENT_CREATED)
      }
    } else if (typeof data.executionId === 'string') {
      outgoing = appendSegmentEvent(
        this.segments,
        data.executionId,
        incoming,
        this.options.maxSegmentEvents ?? MAX_SEGMENT_EVENTS,
      )
      // A finished turn frees the channel's single-flight lock without waiting
      // for the worker's cooperative release — unless a product task defers it.
      if (isTerminalRunEvent(incoming.type)) {
        if (await this.shouldDeferLockRelease(data.executionId)) {
          await this.deferLockRelease({ executionId: data.executionId })
        } else {
          await this.releaseActiveLock({ executionId: data.executionId })
        }
      }
    }

    // Fan out to live sockets for this session. Enumerate accepted sockets so
    // fan-out is correct after WebSocket hibernation (no in-memory socket map).
    // Only `synced` sockets receive live frames; an un-synced socket is still
    // mid-handshake and will pick this event up in its `sync` replay snapshot.
    const message = JSON.stringify(outgoing)
    for (const ws of this.state.getWebSockets()) {
      const meta = ws.deserializeAttachment() as SocketMeta | null
      if (!meta?.synced) continue
      if (!sessionId || meta.sessionId === sessionId) {
        try {
          ws.send(message)
        } catch {
          // Dead/closing socket — getWebSockets() will stop returning it.
        }
      }
    }

    return new Response('OK', { status: 200 })
  }

  private async loadActiveThreads(): Promise<Map<string, number>> {
    if (this.activeThreads === null) {
      const stored = await this.state.storage.get<Record<string, number>>(TURN_STREAM_STORAGE_KEYS.activeThreads)
      this.activeThreads = new Map(Object.entries(stored ?? {}))
    }
    return this.activeThreads
  }

  private async persistActiveThreads(map: Map<string, number>): Promise<void> {
    await this.state.storage.put(TURN_STREAM_STORAGE_KEYS.activeThreads, Object.fromEntries(map))
  }

  // ── chat-turn lock ────────────────────────────────────────────────────────

  protected async loadActiveLock(now = Date.now()): Promise<DurableTurnLock | null> {
    const stored = await this.state.storage.get<DurableTurnLock>(TURN_STREAM_STORAGE_KEYS.lock)
    const lock = activeTurnLock(stored, now)
    if (stored && !lock) await this.state.storage.delete(TURN_STREAM_STORAGE_KEYS.lock)
    return lock
  }

  private async releaseActiveLock(input: { executionId: string; lockId?: string }): Promise<boolean> {
    const active = await this.loadActiveLock()
    if (!active || !turnLockMatchesRelease(active, input)) return false
    await this.state.storage.delete(TURN_STREAM_STORAGE_KEYS.lock)
    return true
  }

  /** Park a release on the lock itself; {@link completeDeferredLockRelease}
   *  finishes it once the product's deferred condition settles. */
  private async deferLockRelease(input: { executionId: string; lockId?: string }): Promise<boolean> {
    const active = await this.loadActiveLock()
    if (!active || !turnLockMatchesRelease(active, input)) return false
    if (active.releasePending) return true
    await this.state.storage.put(TURN_STREAM_STORAGE_KEYS.lock, { ...active, releasePending: true })
    return true
  }

  private async handleLockAcquire(request: Request): Promise<Response> {
    const body = await jsonBody(request)
    const workspaceId = stringValue(body?.workspaceId)
    const threadId = stringValue(body?.threadId)
    const executionId = stringValue(body?.executionId)
    const lockId = stringValue(body?.lockId)
    const scope: TurnLockScope | null =
      body?.scope === 'workspace' ? 'workspace' : body?.scope === 'thread' ? 'thread' : null
    const turnId = stringValue(body?.turnId) ?? undefined
    if (!workspaceId || !threadId || !executionId || !lockId || !scope) {
      return jsonResponse({ error: 'Missing workspaceId, threadId, executionId, lockId, or scope' }, 400)
    }

    const active = await this.loadActiveLock()
    if (active) {
      return jsonResponse({ acquired: false, active } satisfies TurnLockAcquireResult, 409)
    }

    const lock = createTurnLock(
      { workspaceId, threadId, scope, executionId, lockId, ...(turnId ? { turnId } : {}) },
      Date.now(),
      this.options.lockTtlMs ?? TURN_LOCK_TTL_MS,
    )
    await this.state.storage.put(TURN_STREAM_STORAGE_KEYS.lock, lock)
    return jsonResponse({ acquired: true, lock } satisfies TurnLockAcquireResult)
  }

  private async handleLockRelease(request: Request): Promise<Response> {
    const body = await jsonBody(request)
    const executionId = stringValue(body?.executionId)
    const lockId = stringValue(body?.lockId)
    if (!executionId || !lockId) {
      return jsonResponse({ error: 'Missing executionId or lockId' }, 400)
    }

    if (await this.shouldDeferLockRelease(executionId)) {
      const deferred = await this.deferLockRelease({ executionId, lockId })
      return jsonResponse({ released: false, deferred })
    }
    const released = await this.releaseActiveLock({ executionId, lockId })
    return jsonResponse({ released })
  }

  private async handleLockReleaseInterrupted(request: Request): Promise<Response> {
    const body = await jsonBody(request)
    const threadId = stringValue(body?.threadId)
    const interruptedAt =
      typeof body?.interruptedAt === 'number' && Number.isFinite(body.interruptedAt) ? body.interruptedAt : undefined
    if (!threadId || interruptedAt === undefined) {
      return jsonResponse({ error: 'Missing threadId or interruptedAt' }, 400)
    }
    const turnId = stringValue(body?.turnId) ?? undefined

    const active = await this.loadActiveLock()
    if (!active) return jsonResponse({ released: false })
    // A deferred product task holds the scope even against an out-of-band
    // release — the box is still being read.
    if (await this.shouldDeferLockRelease(active.executionId)) {
      return jsonResponse({ released: false })
    }
    if (!interruptedReleaseApplies(active, { threadId, interruptedAt, ...(turnId ? { turnId } : {}) })) {
      return jsonResponse({ released: false })
    }
    await this.state.storage.delete(TURN_STREAM_STORAGE_KEYS.lock)
    return jsonResponse({ released: true })
  }

  // ── durable turn-event storage (TurnEventStore backing) ───────────────────

  private async handleTurnEventsAppend(request: Request): Promise<Response> {
    const body = await jsonBody(request)
    const events = Array.isArray(body?.events) ? body.events : null
    if (!events) return jsonResponse({ error: 'Missing events' }, 400)
    for (const row of events) {
      const seq = (row as { seq?: unknown }).seq
      const event = (row as { event?: unknown }).event
      if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1 || typeof event !== 'string') {
        return jsonResponse({ error: 'Invalid turn-event row' }, 400)
      }
    }
    for (const row of events as Array<{ seq: number; event: string }>) {
      await this.state.storage.put(turnEventStorageKey(row.seq), row.event)
    }
    return jsonResponse({ appended: events.length })
  }

  private async handleTurnEventsRead(request: Request): Promise<Response> {
    const body = await jsonBody(request)
    const fromSeq = typeof body?.fromSeq === 'number' && Number.isFinite(body.fromSeq) ? Math.trunc(body.fromSeq) : 0
    const rows = await this.state.storage.list<string>({
      prefix: TURN_STREAM_STORAGE_KEYS.turnEventPrefix,
      start: turnEventStorageKey(fromSeq + 1),
    })
    const events: Array<{ seq: number; event: string }> = []
    for (const [key, event] of rows) {
      const seq = Number(key.slice(TURN_STREAM_STORAGE_KEYS.turnEventPrefix.length))
      if (Number.isFinite(seq) && seq > fromSeq) events.push({ seq, event })
    }
    return jsonResponse({ events })
  }

  private async handleTurnStatusSet(request: Request): Promise<Response> {
    const body = await jsonBody(request)
    const status = body?.status
    if (status !== 'running' && status !== 'complete' && status !== 'error') {
      return jsonResponse({ error: 'Invalid status' }, 400)
    }
    await this.state.storage.put(TURN_STREAM_STORAGE_KEYS.turnStatus, status)
    return jsonResponse({ ok: true })
  }

  private async handleTurnStatusGet(): Promise<Response> {
    const status = await this.state.storage.get<string>(TURN_STREAM_STORAGE_KEYS.turnStatus)
    return jsonResponse({ status: status ?? null })
  }

  // ── scope index (listRunning reconnect discovery) ─────────────────────────

  private async handleScopeStatusSet(request: Request): Promise<Response> {
    const body = await jsonBody(request)
    const turnId = stringValue(body?.turnId)
    const status = body?.status
    if (!turnId || (status !== 'running' && status !== 'complete' && status !== 'error')) {
      return jsonResponse({ error: 'Invalid scope-status request' }, 400)
    }
    const index =
      (await this.state.storage.get<Record<string, ScopeTurnEntry>>(TURN_STREAM_STORAGE_KEYS.turnScope)) ?? {}
    index[turnId] = { status, updatedAt: Date.now() }
    const entries = Object.entries(index)
    if (entries.length > MAX_SCOPE_TURNS) {
      // Prune oldest terminal entries first; a running turn is never dropped.
      const removable = entries
        .filter(([, entry]) => entry.status !== 'running')
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
      for (const [id] of removable.slice(0, entries.length - MAX_SCOPE_TURNS)) {
        delete index[id]
      }
    }
    await this.state.storage.put(TURN_STREAM_STORAGE_KEYS.turnScope, index)
    return jsonResponse({ ok: true })
  }

  private async handleScopeRunningList(): Promise<Response> {
    const index =
      (await this.state.storage.get<Record<string, ScopeTurnEntry>>(TURN_STREAM_STORAGE_KEYS.turnScope)) ?? {}
    const running = Object.entries(index)
      .filter(([, entry]) => entry.status === 'running')
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .map(([turnId]) => turnId)
    return jsonResponse({ running })
  }
}
