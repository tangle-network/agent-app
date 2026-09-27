/**
 * `TurnStreamDO` — the shared Durable Object transport shell over the pure
 * core (`./core`). One class serves every channel family; the instance NAME
 * decides which endpoints a given instance ever sees:
 *
 * - **thread channel** (`${workspaceId}:${threadId}`) — the thread-scope lock
 *   (KEPT), plus the live turn rebroadcast: WebSocket fanout and per-turn
 *   segments with `sync`/`afterSeq` reconnect replay. That rebroadcast is
 *   `@deprecated` for sandbox-backed interactive turns — the sandbox session
 *   gateway already does it, browser-direct, when the turn is driven on the
 *   message lane (`./core`'s header has the production measurement).
 * - **workspace channel** (`${workspaceId}`) — coarse sidebar signals
 *   (`thread.activity` responding set, durable across eviction;
 *   `thread.created` recent list) and the workspace-scope lock. KEPT: the
 *   gateway is per-session and read-only, so it carries neither.
 * - **turn storage** (`turn:${turnId}`) — the durable `TurnEventStore` rows +
 *   status for one buffered turn (replay survives DO eviction — this is what
 *   graduates the vertical's `turnStore` from no-op). KEPT and load-bearing:
 *   a stream/dispatch DETACHED run does not reach the gateway on the
 *   measured path, so this is how a browser tails that autonomous work.
 * - **scope index** (`scope:${scopeId}`) — the running-turn index backing
 *   `TurnEventStore.listRunning` reconnect discovery. KEPT.
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
import { type DurableTurnLock, type TurnStreamEvent } from './core';
/** The socket surface the DO touches. Cloudflare's hibernatable `WebSocket`
 *  satisfies it. */
export interface TurnStreamSocket {
    send(data: string): void;
    close(code?: number, reason?: string): void;
    serializeAttachment(value: unknown): void;
    deserializeAttachment(): unknown;
}
/** The storage surface the DO touches (Cloudflare `DurableObjectStorage`
 *  satisfies it structurally). `list` must return keys in ascending order —
 *  the turn-event rows rely on it for replay order. */
export interface TurnStreamStorage {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T = unknown>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean | void>;
    list<T = unknown>(options: {
        prefix: string;
        start?: string;
    }): Promise<Map<string, T>>;
}
/** The `DurableObjectState` surface the DO uses. */
export interface TurnStreamDOState {
    storage: TurnStreamStorage;
    acceptWebSocket(ws: TurnStreamSocket): void;
    getWebSockets(): TurnStreamSocket[];
}
/** Define options to override default TTL and event limits for TURN stream DO operations */
export interface TurnStreamDOOptions {
    /** Override {@link TURN_LOCK_TTL_MS}. */
    lockTtlMs?: number;
    /** Override {@link MAX_SEGMENT_EVENTS}. */
    maxSegmentEvents?: number;
    /** Override {@link ACTIVITY_TTL_MS}. */
    activityTtlMs?: number;
    /** How long an unrenewed running turn remains discoverable. */
    runningTurnLeaseMs?: number;
}
/** Manage per-turn segments and track active threads with durable event storage */
export declare class TurnStreamDO {
    protected readonly state: TurnStreamDOState;
    protected readonly env: unknown;
    protected readonly options: TurnStreamDOOptions;
    private segments;
    private recentCreated;
    private activeThreads;
    constructor(state: TurnStreamDOState, env?: unknown, options?: TurnStreamDOOptions);
    fetch(request: Request): Promise<Response>;
    /** Called for any request no base endpoint claimed (before the 404), so a
     *  subclass adds product endpoints without touching base routing. Return
     *  `null` to decline. */
    protected handleProductRequest(_request: Request, _url: URL): Promise<Response | null>;
    /** Consulted before any lock release (cooperative, interrupted, or the
     *  terminal-event auto-release). Return `true` while a product-owned
     *  post-turn task for `executionId` must keep the scope serialized (e.g.
     *  file persistence still reading the box) — the release is then parked as
     *  `releasePending` on the lock and completed via
     *  {@link completeDeferredLockRelease}. Base: never defer. */
    protected shouldDeferLockRelease(_executionId: string): Promise<boolean>;
    /** Complete a release parked by {@link shouldDeferLockRelease}. A subclass
     *  calls this when its deferred condition settles. */
    protected completeDeferredLockRelease(executionId: string): Promise<boolean>;
    /** Extra product state replayed to a socket during its `sync`, after the
     *  base replay for its scope (e.g. an in-flight persistence status card).
     *  Base: none. */
    protected productSyncEvents(_scope: 'thread' | 'workspace', _meta: {
        sessionId: string;
    }): Promise<TurnStreamEvent[]>;
    private handleWebSocketUpgrade;
    /**
     * First (and only) client message after open: `{ type: 'sync', afterSeq }`.
     * Replays the current state for the socket's scope, then marks it `synced`
     * so live broadcasts start flowing. Because the DO is single-threaded, the
     * replay snapshot and the synced flip are atomic w.r.t. broadcasts — every
     * event reaches the socket exactly once, in order, via replay XOR live
     * fan-out.
     */
    webSocketMessage(ws: TurnStreamSocket, message: string | ArrayBuffer): Promise<void>;
    webSocketClose(ws: TurnStreamSocket, code: number, reason: string): void;
    webSocketError(): void;
    private trySend;
    private handleBroadcast;
    private loadActiveThreads;
    private persistActiveThreads;
    protected loadActiveLock(now?: number): Promise<DurableTurnLock | null>;
    private releaseActiveLock;
    /** Park a release on the lock itself; {@link completeDeferredLockRelease}
     *  finishes it once the product's deferred condition settles. */
    private deferLockRelease;
    private handleLockAcquire;
    private handleLockRelease;
    private handleLockReleaseInterrupted;
    private handleTurnEventsAppend;
    private handleTurnEventsRead;
    private handleTurnStatusSet;
    private handleTurnStatusGet;
    private handleScopeStatusSet;
    private handleScopeRunningList;
}
