/**
 * Worker-side adapters over {@link TurnStreamDO}: the concrete implementations
 * of the chat vertical's `turnStore` and `turnLock` seams, the WebSocket
 * upgrade forwarder, the best-effort broadcast helpers, and an in-process
 * memory harness for tests and keyless local dev.
 *
 * Everything takes the namespace STRUCTURALLY ({@link TurnStreamNamespaceLike}
 * — Cloudflare's `DurableObjectNamespace` satisfies it), so nothing here
 * imports Cloudflare types and the same adapters run against the memory
 * harness in vitest.
 *
 * Live fanout is deliberately NOT a side effect of the turn-event store: the
 * store is keyed by turnId/scopeId while viewer sockets live on the
 * `${workspaceId}:${threadId}` channel, and only the product's per-turn
 * context knows both. Products wire {@link broadcastTurnStreamEvent} (and the
 * workspace helpers) into `createChatTurnRoutes`' `onEvent` — the same
 * contract the reference consumer already runs.
 */

import { reconcileStaleTurnLock, type ReconcileStaleTurnLockOptions } from '../chat-routes/stale-turn-lock'
import type { TurnEventStore, TurnStatus } from '../stream/turn-buffer'
import {
  TURN_STREAM_PATHS,
  scopeIndexChannelKey,
  threadChannelKey,
  turnLockChannelKey,
  turnStorageChannelKey,
  workspaceChannelKey,
  type DurableTurnLock,
  type TurnLockAcquireResult,
  type TurnLockReleaseInput,
  type TurnLockScope,
  type TurnStreamEvent,
} from './core'

// ── structural namespace ────────────────────────────────────────────────────

/** Resolve a stub interface for handling fetch requests with optional initialization parameters */
export interface TurnStreamStubLike {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>
}

/** The surface of `DurableObjectNamespace` the adapters use. */
export interface TurnStreamNamespaceLike {
  idFromName(name: string): unknown
  get(id: unknown): TurnStreamStubLike
}

const INTERNAL_ORIGIN = 'https://turn-stream.internal'

async function postJson<T>(
  namespace: TurnStreamNamespaceLike,
  channelKey: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: T }> {
  const stub = namespace.get(namespace.idFromName(channelKey))
  const response = await stub.fetch(`${INTERNAL_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as T }
}

async function postJsonOk<T>(
  namespace: TurnStreamNamespaceLike,
  channelKey: string,
  path: string,
  body: unknown,
): Promise<T> {
  const result = await postJson<T>(namespace, channelKey, path, body)
  if (result.status !== 200) {
    throw new Error(`turn-stream ${path} failed with status ${result.status}`)
  }
  return result.body
}

// ── TurnEventStore adapter (the real turnStore) ─────────────────────────────

/**
 * A {@link TurnEventStore} backed by {@link TurnStreamDO} storage — the
 * production implementation of `createChatTurnRoutes`' `turnStore` seam for
 * apps that don't run D1 for turn events (or want replay co-located with the
 * live channel). Each buffered turn lives on its own `turn:<turnId>` DO
 * instance; `listRunning` reconnect discovery rides a per-scope index
 * instance. Drops in wherever `createD1TurnEventStore(env.DB)` would.
 */
export function createDurableObjectTurnEventStore(namespace: TurnStreamNamespaceLike): TurnEventStore {
  return {
    async append(turnId, events) {
      if (!events.length) return
      await postJsonOk(namespace, turnStorageChannelKey(turnId), TURN_STREAM_PATHS.turnEventsAppend, { events })
    },
    async read(turnId, fromSeq) {
      const body = await postJsonOk<{ events: Array<{ seq: number; event: string }> }>(
        namespace,
        turnStorageChannelKey(turnId),
        TURN_STREAM_PATHS.turnEventsRead,
        { fromSeq },
      )
      return body.events
    },
    async setStatus(turnId, status, scopeId) {
      await postJsonOk(namespace, turnStorageChannelKey(turnId), TURN_STREAM_PATHS.turnStatusSet, { status })
      if (scopeId) {
        await postJsonOk(namespace, scopeIndexChannelKey(scopeId), TURN_STREAM_PATHS.scopeStatusSet, {
          turnId,
          status,
        })
      }
    },
    async getStatus(turnId) {
      const body = await postJsonOk<{ status: TurnStatus | null }>(
        namespace,
        turnStorageChannelKey(turnId),
        TURN_STREAM_PATHS.turnStatusGet,
        {},
      )
      return body.status
    },
    async listRunning(scopeId) {
      const body = await postJsonOk<{ running: string[] }>(
        namespace,
        scopeIndexChannelKey(scopeId),
        TURN_STREAM_PATHS.scopeRunningList,
        {},
      )
      return body.running
    },
  }
}

// ── lock primitives (usable outside the route seam too) ─────────────────────

/** Define input parameters required to acquire a durable turn lock in a workspace thread context */
export interface AcquireDurableTurnLockInput {
  workspaceId: string
  threadId: string
  scope: TurnLockScope
  executionId: string
  turnId?: string
  /** Supply to reclaim/retry with a stable id; default mints a UUID. */
  lockId?: string
}

/** Acquire a durable turn lock in the specified namespace with given input parameters */
export async function acquireDurableTurnLock(
  namespace: TurnStreamNamespaceLike,
  input: AcquireDurableTurnLockInput,
): Promise<TurnLockAcquireResult> {
  const lockId = input.lockId ?? crypto.randomUUID()
  const key = turnLockChannelKey(input.workspaceId, input.threadId, input.scope)
  const result = await postJson<TurnLockAcquireResult>(namespace, key, TURN_STREAM_PATHS.lockAcquire, {
    ...input,
    lockId,
  })
  if (result.status !== 200 && result.status !== 409) {
    throw new Error(`turn-stream lock acquire failed with status ${result.status}`)
  }
  return result.body
}

/** Release a durable turn lock and indicate if the release was successful or deferred */
export async function releaseDurableTurnLock(
  namespace: TurnStreamNamespaceLike,
  input: TurnLockReleaseInput,
): Promise<{ released: boolean; deferred?: boolean }> {
  const key = turnLockChannelKey(input.workspaceId, input.threadId, input.scope)
  return postJsonOk(namespace, key, TURN_STREAM_PATHS.lockRelease, input)
}

/** Define input parameters to release an interrupted durable turn lock in a workspace or thread */
export interface ReleaseInterruptedDurableTurnLockInput {
  workspaceId: string
  threadId: string
  /** Try only this scope; omit to try workspace then thread (a stop button
   *  doesn't know which lane the wedged turn ran on). */
  scope?: TurnLockScope
  interruptedAt: number
  turnId?: string
}

/** Fenced out-of-band release — the DO refuses a successor lock (started
 *  after `interruptedAt`) and a turnId mismatch. Returns whether any scope
 *  released. */
export async function releaseInterruptedDurableTurnLock(
  namespace: TurnStreamNamespaceLike,
  input: ReleaseInterruptedDurableTurnLockInput,
): Promise<boolean> {
  const scopes: readonly TurnLockScope[] = input.scope ? [input.scope] : ['workspace', 'thread']
  for (const scope of scopes) {
    const key = turnLockChannelKey(input.workspaceId, input.threadId, scope)
    const result = await postJsonOk<{ released: boolean }>(namespace, key, TURN_STREAM_PATHS.lockReleaseInterrupted, {
      threadId: input.threadId,
      interruptedAt: input.interruptedAt,
      ...(input.turnId ? { turnId: input.turnId } : {}),
    })
    if (result.released) return true
  }
  return false
}

// ── stale-lock reconciliation against the DO ────────────────────────────────

/** Define options to reconcile stale durable turn locks with context, namespace, workspace, and active lock details */
export interface ReconcileStaleDurableTurnLockOptions
  extends Pick<
    ReconcileStaleTurnLockOptions,
    'probeSandbox' | 'probeSession' | 'graceMs' | 'terminalGraceMs' | 'context' | 'log' | 'now'
  > {
  namespace: TurnStreamNamespaceLike
  workspaceId: string
  threadId: string
  /** The lock the acquire attempt was refused on. */
  active: DurableTurnLock
}

/**
 * `/chat-routes`' `reconcileStaleTurnLock` policy wired to the DO: the
 * product supplies the probes (which box, what its session says), the policy
 * decides, and a release lands as a FENCED interrupted release —
 * `interruptedAt` is the policy's `fence.observedAt`, so a successor lock
 * acquired while the probes were in flight survives by construction.
 */
export async function reconcileStaleDurableTurnLock(
  options: ReconcileStaleDurableTurnLockOptions,
): Promise<{ released: boolean; diagnostics: Record<string, unknown> }> {
  const { namespace, workspaceId, threadId, active, ...policy } = options
  return reconcileStaleTurnLock({
    ...policy,
    lockStartedAt: active.startedAt,
    release: (fence) =>
      releaseInterruptedDurableTurnLock(namespace, {
        workspaceId,
        threadId: active.threadId,
        scope: active.scope,
        interruptedAt: fence.observedAt,
        ...(active.turnId ? { turnId: active.turnId } : {}),
      }),
  })
}

// ── ChatTurnLock adapter (the turnLock seam) ────────────────────────────────

/** The subset of `ChatTurnProduceArgs` the lock adapter reads — structural,
 *  so this module needs no import from `/chat-routes/turn-routes` (which
 *  would drag the `agent-runtime` peer into every `/turn-stream` consumer). */
export interface TurnLockSeamArgs<TContext> {
  identity: { tenantId: string; sessionId: string }
  executionId: string
  context: TContext
  body: { turnId?: string }
}

/** Verdict shape of the vertical's `turnLock.acquire`. */
export type TurnLockSeamResult =
  | { acquired: true; handle?: unknown }
  | { acquired: false; response: Response }

/** Define options for creating a durable turn lock with customizable scope and identification methods */
export interface CreateDurableTurnLockOptions<TContext> {
  namespace: TurnStreamNamespaceLike
  /** Which lane serializes this turn: `'workspace'` (shared sandbox — one
   *  turn per workspace) or `'thread'` (router lane — one turn per thread). */
  scopeOf(args: TurnLockSeamArgs<TContext>): TurnLockScope
  /** Override the execution id the lock records (e.g. a follow-up reclaiming
   *  the execution it already dispatched). Default: the turn's own. */
  lockExecutionIdOf?(args: TurnLockSeamArgs<TContext>): string | undefined
  /** Client turn id recorded on the lock (fences interrupted releases to the
   *  right turn). Default: the request body's `turnId`. */
  clientTurnIdOf?(args: TurnLockSeamArgs<TContext>): string | undefined
  /**
   * Attempt stale-lock recovery after a refused acquire. Return whether the
   * held lock was released (the adapter then retries the acquire once).
   * Products wire {@link reconcileStaleDurableTurnLock} with their sandbox +
   * session probes here. Omit → a refused acquire is final.
   */
  reconcile?(
    args: TurnLockSeamArgs<TContext>,
    active: DurableTurnLock,
  ): Promise<{ released: boolean; diagnostics?: Record<string, unknown> }>
  /** Build the refusal `Response`. Default: a 409 with the shared body shape
   *  (`code`, `message`, lock identity + age, reconcile diagnostics). */
  onRefused?(active: DurableTurnLock, diagnostics: Record<string, unknown> | undefined): Response
}

function defaultRefusalResponse(
  active: DurableTurnLock,
  diagnostics: Record<string, unknown> | undefined,
): Response {
  const workspaceConflict = active.scope === 'workspace'
  return Response.json(
    {
      error: {
        code: workspaceConflict ? 'workspace_turn_in_flight' : 'chat_turn_in_flight',
        message: workspaceConflict
          ? 'A chat turn is already running for this workspace. Wait for it to finish before starting another.'
          : 'A chat turn is already running for this thread. Reconnect to the active response or wait for it to finish.',
        threadId: active.threadId,
        executionId: active.executionId,
        ...(active.turnId ? { turnId: active.turnId } : {}),
        lockStartedAt: active.startedAt,
        lockAgeMs: Date.now() - active.startedAt,
        ...(diagnostics ? { diagnostics } : {}),
      },
    },
    { status: 409 },
  )
}

/**
 * The vertical's `turnLock` seam on the shared DO: dual-scope single-flight
 * acquire (with one reconcile-then-retry pass when the product supplies a
 * stale-lock reconciler) and cooperative release on settle. The returned
 * object satisfies `createChatTurnRoutes`' `ChatTurnLock<TContext>`
 * structurally.
 */
export function createDurableTurnLock<TContext>(options: CreateDurableTurnLockOptions<TContext>): {
  acquire(args: TurnLockSeamArgs<TContext>): Promise<TurnLockSeamResult>
  release(handle: unknown): Promise<void>
} {
  return {
    async acquire(args) {
      const workspaceId = args.identity.tenantId
      const threadId = args.identity.sessionId
      const scope = options.scopeOf(args)
      const executionId = options.lockExecutionIdOf?.(args) ?? args.executionId
      const turnId = options.clientTurnIdOf ? options.clientTurnIdOf(args) : args.body.turnId
      const input: AcquireDurableTurnLockInput = {
        workspaceId,
        threadId,
        scope,
        executionId,
        ...(turnId ? { turnId } : {}),
      }

      let acquired = await acquireDurableTurnLock(options.namespace, input)
      let diagnostics: Record<string, unknown> | undefined
      if (!acquired.acquired && options.reconcile) {
        const reconciled = await options.reconcile(args, acquired.active)
        diagnostics = reconciled.diagnostics
        if (reconciled.released) {
          acquired = await acquireDurableTurnLock(options.namespace, input)
        }
      }
      if (!acquired.acquired) {
        return {
          acquired: false,
          response: (options.onRefused ?? defaultRefusalResponse)(acquired.active, diagnostics),
        }
      }
      const handle: TurnLockReleaseInput = {
        workspaceId,
        threadId,
        scope,
        executionId,
        lockId: acquired.lock.lockId,
      }
      return { acquired: true, handle }
    },
    async release(handle) {
      if (!handle) return
      await releaseDurableTurnLock(options.namespace, handle as TurnLockReleaseInput)
    },
  }
}

// ── broadcast helpers (products wire these into onEvent) ────────────────────

/**
 * Fan a turn event out to the per-thread channel. `executionId` groups events
 * into a per-turn segment with a monotonic seq, so a reconnecting client
 * replays only the active turn and resumes from a cursor. Callers MUST await
 * (the DO assigns seq on arrival — emission order matters); failures are
 * swallowed (fanout is best-effort and never breaks chat delivery).
 */
export async function broadcastTurnStreamEvent(
  namespace: TurnStreamNamespaceLike,
  input: {
    workspaceId: string
    threadId: string
    executionId: string
    event: { type: string; data?: Record<string, unknown> }
  },
): Promise<void> {
  try {
    await postJson(namespace, threadChannelKey(input.workspaceId, input.threadId), TURN_STREAM_PATHS.broadcast, {
      type: input.event.type,
      timestamp: Date.now(),
      data: {
        ...(input.event.data ?? {}),
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        sessionId: input.threadId,
        executionId: input.executionId,
      },
    } satisfies TurnStreamEvent)
  } catch {
    // Best-effort.
  }
}

/** Coarse per-workspace marker that a thread's turn started / ended — drives
 *  a sidebar "agent responding" indicator subscribed once per workspace. */
export async function broadcastWorkspaceActivity(
  namespace: TurnStreamNamespaceLike,
  workspaceId: string,
  threadId: string,
  phase: 'start' | 'end',
): Promise<void> {
  try {
    await postJson(namespace, workspaceChannelKey(workspaceId), TURN_STREAM_PATHS.broadcast, {
      type: 'thread.activity',
      timestamp: Date.now(),
      data: { threadId, phase, workspaceId, sessionId: workspaceId },
    } satisfies TurnStreamEvent)
  } catch {
    // Best-effort: the indicator is non-critical UI.
  }
}

/** Per-workspace marker that a new thread was created, so an already-open
 *  history list prepends it without a reload. */
export async function broadcastThreadCreated(
  namespace: TurnStreamNamespaceLike,
  workspaceId: string,
  thread: { threadId: string; title: string },
): Promise<void> {
  try {
    await postJson(namespace, workspaceChannelKey(workspaceId), TURN_STREAM_PATHS.broadcast, {
      type: 'thread.created',
      timestamp: Date.now(),
      data: { threadId: thread.threadId, title: thread.title, workspaceId, sessionId: workspaceId },
    } satisfies TurnStreamEvent)
  } catch {
    // Best-effort: the loader reconciles on the next revalidation.
  }
}

// ── WebSocket upgrade forwarder (worker entry) ──────────────────────────────

/** Represent success or failure of a TURN stream upgrade authorization with optional response data */
export type TurnStreamUpgradeAuthorization = { ok: true } | { ok: false; response: Response }

/** Define options for creating a TURN stream upgrade handler including namespace, path, and authorization logic */
export interface CreateTurnStreamUpgradeHandlerOptions {
  namespace: TurnStreamNamespaceLike
  /** The worker route serving the stream. Default `/api/session-stream`. */
  path?: string
  /** Viewer access check (session cookie → workspace membership). */
  authorize(
    request: Request,
    target: { workspaceId: string; threadId: string | null },
  ): Promise<TurnStreamUpgradeAuthorization>
}

/**
 * The worker-entry WebSocket forwarder. Call BEFORE the app router (a router
 * loader cannot return a 101); returns `null` for requests that are not a
 * WebSocket upgrade on the configured path.
 *
 *   GET {path}?workspaceId=...            → workspace channel (sidebar)
 *   GET {path}?workspaceId=...&threadId=… → thread channel (turn resume)
 *
 * After the 101, the client sends `{type:'sync', afterSeq}` and receives the
 * replay-then-live stream (see {@link TurnStreamDO.webSocketMessage}).
 */
export function createTurnStreamUpgradeHandler(
  options: CreateTurnStreamUpgradeHandlerOptions,
): (request: Request) => Promise<Response | null> {
  const path = options.path ?? '/api/session-stream'
  return async (request) => {
    const url = new URL(request.url)
    if (url.pathname !== path || request.headers.get('Upgrade') !== 'websocket') return null

    const workspaceId = url.searchParams.get('workspaceId')
    const threadId = url.searchParams.get('threadId')
    if (!workspaceId) return new Response('Missing workspaceId', { status: 400 })

    const auth = await options.authorize(request, { workspaceId, threadId })
    if (!auth.ok) return auth.response

    // threadId present → per-thread turn channel; absent → workspace channel.
    const key = threadId ? threadChannelKey(workspaceId, threadId) : workspaceChannelKey(workspaceId)
    const sessionId = threadId ?? workspaceId
    const stub = options.namespace.get(options.namespace.idFromName(key))

    const forwardUrl = new URL(request.url)
    forwardUrl.searchParams.set('sessionId', sessionId)
    forwardUrl.searchParams.set('scope', threadId ? 'thread' : 'workspace')
    return stub.fetch(new Request(forwardUrl, request))
  }
}
