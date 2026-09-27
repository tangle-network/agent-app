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
 * context knows both. Products wire the workspace signal helpers into
 * `createChatTurnRoutes`' `onEvent`.
 *
 * Which adapters are still the right answer (see `./core`'s header for the
 * production measurement behind this split):
 *
 * | adapter                              | status                            |
 * | ------------------------------------ | --------------------------------- |
 * | {@link createDurableTurnLock}        | KEPT — no SDK equivalent          |
 * | {@link reconcileStaleDurableTurnLock}| KEPT — no SDK equivalent          |
 * | {@link createDurableObjectTurnEventStore} | KEPT — the DETACHED lane     |
 * | {@link broadcastWorkspaceActivity}   | KEPT — workspace signal           |
 * | {@link broadcastThreadCreated}       | KEPT — workspace signal           |
 * | {@link createTurnStreamUpgradeHandler} | KEPT for the workspace channel  |
 * | {@link broadcastTurnStreamEvent}     | `@deprecated` for sandbox turns   |
 */
import { type ReconcileStaleTurnLockOptions } from '../chat-routes/stale-turn-lock';
import type { TurnEventStore } from '../stream/turn-buffer';
import { type DurableTurnLock, type TurnLockAcquireResult, type TurnLockReleaseInput, type TurnLockScope } from './core';
/** Resolve a stub interface for handling fetch requests with optional initialization parameters */
export interface TurnStreamStubLike {
    fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}
/** The surface of `DurableObjectNamespace` the adapters use. */
export interface TurnStreamNamespaceLike {
    idFromName(name: string): unknown;
    get(id: unknown): TurnStreamStubLike;
}
/**
 * A {@link TurnEventStore} backed by {@link TurnStreamDO} storage — the
 * production implementation of `createChatTurnRoutes`' `turnStore` seam for
 * apps that don't run D1 for turn events (or want replay co-located with the
 * live channel). Each buffered turn lives on its own `turn:<turnId>` DO
 * instance; `listRunning` reconnect discovery rides a per-scope index
 * instance. Drops in wherever `createD1TurnEventStore(env.DB)` would.
 *
 * KEPT and load-bearing for AUTONOMOUS work. A detached run driven through
 * `dispatchPrompt({ detach: true })` or `streamPrompt` executes on the sandbox
 * run/stream lane, which publishes nothing to the session event bus on the
 * measured path (0 of 71 / 0 of 527 / 0 of 408 across three session-id
 * strategies). Sandbox 0.37 `driveTurn` uses the session message lane and is
 * gateway-visible by SDK contract. A browser tailing a stream/dispatch run
 * needs these durable rows plus `runDetachedTurn` (`/chat-routes`). Nothing
 * here is deprecated.
 */
export declare function createDurableObjectTurnEventStore(namespace: TurnStreamNamespaceLike): TurnEventStore;
/** Define input parameters required to acquire a durable turn lock in a workspace thread context */
export interface AcquireDurableTurnLockInput {
    workspaceId: string;
    threadId: string;
    scope: TurnLockScope;
    executionId: string;
    turnId?: string;
    /** Supply to reclaim/retry with a stable id; default mints a UUID. */
    lockId?: string;
}
/** Acquire a durable turn lock in the specified namespace with given input parameters */
export declare function acquireDurableTurnLock(namespace: TurnStreamNamespaceLike, input: AcquireDurableTurnLockInput): Promise<TurnLockAcquireResult>;
/** Release a durable turn lock and indicate if the release was successful or deferred */
export declare function releaseDurableTurnLock(namespace: TurnStreamNamespaceLike, input: TurnLockReleaseInput): Promise<{
    released: boolean;
    deferred?: boolean;
}>;
/** Define input parameters to release an interrupted durable turn lock in a workspace or thread */
export interface ReleaseInterruptedDurableTurnLockInput {
    workspaceId: string;
    threadId: string;
    /** Try only this scope; omit to try workspace then thread (a stop button
     *  doesn't know which lane the wedged turn ran on). */
    scope?: TurnLockScope;
    interruptedAt: number;
    turnId?: string;
}
/** Fenced out-of-band release — the DO refuses a successor lock (started
 *  after `interruptedAt`) and a turnId mismatch. Returns whether any scope
 *  released. */
export declare function releaseInterruptedDurableTurnLock(namespace: TurnStreamNamespaceLike, input: ReleaseInterruptedDurableTurnLockInput): Promise<boolean>;
/** Define options to reconcile stale durable turn locks with context, namespace, workspace, and active lock details */
export interface ReconcileStaleDurableTurnLockOptions extends Pick<ReconcileStaleTurnLockOptions, 'probeSandbox' | 'probeSession' | 'graceMs' | 'terminalGraceMs' | 'context' | 'log' | 'now'> {
    namespace: TurnStreamNamespaceLike;
    workspaceId: string;
    threadId: string;
    /** The lock the acquire attempt was refused on. */
    active: DurableTurnLock;
}
/**
 * `/chat-routes`' `reconcileStaleTurnLock` policy wired to the DO: the
 * product supplies the probes (which box, what its session says), the policy
 * decides, and a release lands as a FENCED interrupted release —
 * `interruptedAt` is the policy's `fence.observedAt`, so a successor lock
 * acquired while the probes were in flight survives by construction.
 */
export declare function reconcileStaleDurableTurnLock(options: ReconcileStaleDurableTurnLockOptions): Promise<{
    released: boolean;
    diagnostics: Record<string, unknown>;
}>;
/** The subset of `ChatTurnProduceArgs` the lock adapter reads — structural,
 *  so this module needs no import from `/chat-routes/turn-routes` (which
 *  would drag the `agent-runtime` peer into every `/turn-stream` consumer). */
export interface TurnLockSeamArgs<TContext> {
    identity: {
        tenantId: string;
        sessionId: string;
    };
    executionId: string;
    context: TContext;
    body: {
        turnId?: string;
    };
}
/** Verdict shape of the vertical's `turnLock.acquire`. */
export type TurnLockSeamResult = {
    acquired: true;
    handle?: unknown;
} | {
    acquired: false;
    response: Response;
};
/** Define options for creating a durable turn lock with customizable scope and identification methods */
export interface CreateDurableTurnLockOptions<TContext> {
    namespace: TurnStreamNamespaceLike;
    /** Which lane serializes this turn: `'workspace'` (shared sandbox — one
     *  turn per workspace) or `'thread'` (router lane — one turn per thread). */
    scopeOf(args: TurnLockSeamArgs<TContext>): TurnLockScope;
    /** Override the execution id the lock records (e.g. a follow-up reclaiming
     *  the execution it already dispatched). Default: the turn's own. */
    lockExecutionIdOf?(args: TurnLockSeamArgs<TContext>): string | undefined;
    /** Client turn id recorded on the lock (fences interrupted releases to the
     *  right turn). Default: the request body's `turnId`. */
    clientTurnIdOf?(args: TurnLockSeamArgs<TContext>): string | undefined;
    /**
     * Attempt stale-lock recovery after a refused acquire. Return whether the
     * held lock was released (the adapter then retries the acquire once).
     * Products wire {@link reconcileStaleDurableTurnLock} with their sandbox +
     * session probes here. Omit → a refused acquire is final.
     */
    reconcile?(args: TurnLockSeamArgs<TContext>, active: DurableTurnLock): Promise<{
        released: boolean;
        diagnostics?: Record<string, unknown>;
    }>;
    /** Build the refusal `Response`. Default: a 409 with the shared body shape
     *  (`code`, `message`, lock identity + age, reconcile diagnostics). */
    onRefused?(active: DurableTurnLock, diagnostics: Record<string, unknown> | undefined): Response;
}
/**
 * The vertical's `turnLock` seam on the shared DO: dual-scope single-flight
 * acquire (with one reconcile-then-retry pass when the product supplies a
 * stale-lock reconciler) and cooperative release on settle. The returned
 * object satisfies `createChatTurnRoutes`' `ChatTurnLock<TContext>`
 * structurally.
 */
export declare function createDurableTurnLock<TContext>(options: CreateDurableTurnLockOptions<TContext>): {
    acquire(args: TurnLockSeamArgs<TContext>): Promise<TurnLockSeamResult>;
    release(handle: unknown): Promise<void>;
};
/**
 * DEPRECATED for sandbox-backed interactive turns (drive on the session-message
 * lane + `SessionGatewayClient` instead) — fan a turn event out to the
 * per-thread channel. `executionId` groups events
 * into a per-turn segment with a monotonic seq, so a reconnecting client
 * replays only the active turn and resumes from a cursor. Callers MUST await
 * (the DO assigns seq on arrival — emission order matters); failures are
 * swallowed (fanout is best-effort and never breaks chat delivery).
 *
 * @deprecated For a SANDBOX-backed interactive turn this re-broadcasts events
 * the sandbox platform already fans out, at the cost of a worker hop. Drive
 * the turn on the session-MESSAGE lane instead —
 * `box.createSession({ sessionId, backend })` then
 * `box.session(id).sendMessage({ parts: [{ type: 'text', text }] })` — and let
 * the tab attach with `box.mintScopedToken({ scope: 'session', sessionId,
 * runtimeSessionId })` + `SessionGatewayClient`
 * (`@tangle-network/sandbox/session-gateway`). Measured on production
 * (4 arms, SDK 0.12.0): turns driven with `box.streamPrompt()` delivered
 * 0 of 71 / 0 of 527 / 0 of 408 turn events to a gateway client, because
 * `POST /agents/run/stream` publishes nothing to the session event bus;
 * the message lane delivered 297 of 297.
 *
 * Two things this deprecation does NOT cover, both still supported:
 * stream/dispatch DETACHED runs (keep `runDetachedTurn` over the durable
 * turn-event rows) and the per-workspace signals
 * ({@link broadcastWorkspaceActivity} / {@link broadcastThreadCreated}).
 * A SANDBOX-FREE copilot that wants a second viewer should use `/stream`'s
 * `replayTurnEvents` (`GET /chat/stream/:turnId`), which follows a running
 * turn from a cursor without a second broadcast fabric.
 *
 * Kept for back-compat; removal is a major-version change.
 */
export declare function broadcastTurnStreamEvent(namespace: TurnStreamNamespaceLike, input: {
    workspaceId: string;
    threadId: string;
    executionId: string;
    event: {
        type: string;
        data?: Record<string, unknown>;
    };
}): Promise<void>;
/** Coarse per-workspace marker that a thread's turn started / ended — drives
 *  a sidebar "agent responding" indicator subscribed once per workspace. */
export declare function broadcastWorkspaceActivity(namespace: TurnStreamNamespaceLike, workspaceId: string, threadId: string, phase: 'start' | 'end'): Promise<void>;
/** Per-workspace marker that a new thread was created, so an already-open
 *  history list prepends it without a reload. */
export declare function broadcastThreadCreated(namespace: TurnStreamNamespaceLike, workspaceId: string, thread: {
    threadId: string;
    title: string;
}): Promise<void>;
/** Represent success or failure of a TURN stream upgrade authorization with optional response data */
export type TurnStreamUpgradeAuthorization = {
    ok: true;
} | {
    ok: false;
    response: Response;
};
/** Define options for creating a TURN stream upgrade handler including namespace, path, and authorization logic */
export interface CreateTurnStreamUpgradeHandlerOptions {
    namespace: TurnStreamNamespaceLike;
    /** The worker route serving the stream. Default `/api/session-stream`. */
    path?: string;
    /** Viewer access check (session cookie → workspace membership). */
    authorize(request: Request, target: {
        workspaceId: string;
        threadId: string | null;
    }): Promise<TurnStreamUpgradeAuthorization>;
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
 *
 * NOT deprecated — the workspace variant (no `threadId`) is the canonical
 * transport for the per-workspace signals, which the session gateway cannot
 * carry (it is per-session and read-only). The THREAD variant is the
 * deprecated half: for a sandbox-backed interactive turn the tab should
 * attach to the session gateway directly instead of to this socket. See
 * {@link broadcastTurnStreamEvent} for the measurement and the replacement
 * wiring.
 */
export declare function createTurnStreamUpgradeHandler(options: CreateTurnStreamUpgradeHandlerOptions): (request: Request) => Promise<Response | null>;
