/**
 * Resumable chat turns — the router-path answer to "streams resume on
 * disconnect" (issue #27). A turn's loop events are teed into a store as they
 * stream; the turn keeps running under `ctx.waitUntil` when the client drops;
 * a reconnecting client replays the buffered tail by sequence number and
 * keeps following until the turn completes.
 *
 *   POST /chat/stream            → pumpBufferedTurn(...) + live NDJSON
 *   GET  /chat/stream/:turnId    → replayTurnEvents({ fromSeq }) → NDJSON
 *
 * Storage is a structural seam ({@link TurnEventStore}); a D1 implementation
 * ships here because that's what Cloudflare products have (KV is unsuitable:
 * eventually consistent cross-isolate). Per-token deltas would mean hundreds
 * of rows per turn, so consecutive text/reasoning deltas are coalesced within
 * a flush window before they are persisted — replay yields slightly chunkier
 * deltas with identical concatenation.
 */
export type TurnStatus = 'running' | 'complete' | 'error';
/** A running row is a renewable lease, not permanent truth. If the process
 *  driving a turn dies before writing a terminal status, reconnect discovery
 *  must eventually stop returning that abandoned row. */
export declare const DEFAULT_RUNNING_TURN_LEASE_MS: number;
/** Keep a healthy turn's lease comfortably ahead of expiry without turning
 *  per-token streaming into status-write traffic. */
export declare const DEFAULT_RUNNING_TURN_RENEW_INTERVAL_MS = 30000;
/** Represent a buffered turn event with a sequence number and serialized event data */
export interface BufferedTurnEvent {
    seq: number;
    /** The serialized event line (JSON string, no trailing newline). */
    event: string;
}
/** Manage and query turn events and their lifecycle statuses within a scoped event store */
export interface TurnEventStore {
    /**
     * Append rows while the turn is live. Implementations must ignore rows that
     * arrive after `setStatus` publishes `complete` or `error`; the terminal
     * status is the replay fence for a detached live projection.
     */
    append(turnId: string, events: BufferedTurnEvent[]): Promise<void>;
    read(turnId: string, fromSeq: number): Promise<BufferedTurnEvent[]>;
    /** Record turn lifecycle. `scopeId` (a thread/session id) is optional and lets
     *  {@link TurnEventStore.listRunning} rediscover this turn after a client reload
     *  loses the turnId; stores that don't track scope ignore it. */
    setStatus(turnId: string, status: TurnStatus, scopeId?: string): Promise<void>;
    getStatus(turnId: string): Promise<TurnStatus | null>;
    /** Unexpired running turnIds for a scope, newest first — so a reloaded client
     *  (clientRunId lost) can find and resume the in-flight turn without reviving
     *  a row abandoned by a dead process. Optional: a store records it only if
     *  `setStatus` was given a `scopeId`. */
    listRunning?(scopeId: string): Promise<string[]>;
    /** Explicitly remove one turn's events and status. Optional so existing
     *  custom stores remain source-compatible; the built-in D1 and memory stores
     *  provide it. */
    deleteTurn?(turnId: string): Promise<void>;
    /** Remove terminal turns whose status was updated before `before` (Unix
     *  milliseconds or a Date). Running turns are never eligible. */
    pruneTerminalTurns?(before: number | Date): Promise<number>;
}
/** Configure running-turn lease evaluation. The clock is injectable so store
 *  contract tests do not sleep. Keep the default in production unless a
 *  deployment also tunes the buffer's renewal interval. */
export interface TurnEventStoreOptions {
    runningTurnLeaseMs?: number;
    now?: () => number;
}
/** Merge consecutive text/reasoning deltas of the same type into one event.
 *  Concatenation-preserving: replaying the coalesced stream produces the same
 *  accumulated text as the original. */
export declare function coalesceDeltas(events: unknown[]): unknown[];
/**
 * Coalesce consecutive `message.part.updated` deltas for the SAME part into one
 * event. agent-runtime products stream `ChatStreamEvent` NDJSON
 * (`{type:'message.part.updated', data:{part, delta}}`); pumped through the
 * buffer with the default tool-loop coalescer, every per-token delta persists as
 * its own row because that coalescer never recognizes the shape. Pass this as
 * {@link PumpBufferedTurnOptions.coalesce} instead.
 *
 * Concatenation-preserving for BOTH consumer styles: the merged event keeps the
 * LATEST event's `data.part` (already the cumulative accumulation) and sets
 * `data.delta` to the concatenation of the merged deltas, so a client that
 * appends `delta` and one that reads the cumulative `part` both reconstruct the
 * identical final text.
 */
export declare function coalesceChatStreamEvents(events: unknown[]): unknown[];
/** Define options for buffering and flushing turn events with optional live client delivery and event coalescing */
export interface BufferedTurnOptions {
    store: TurnEventStore;
    turnId: string;
    /** Deliver one serialized line to the live client. Throwing here (client
     *  disconnected) does NOT stop buffering — events keep persisting. */
    write?: (line: string) => Promise<void> | void;
    /** Flush buffered events to the store at most this often. Default 400ms. */
    flushIntervalMs?: number;
    /** Per-flush coalescer. Default {@link coalesceDeltas} (tool-loop text/reasoning
     *  deltas). agent-runtime products streaming `ChatStreamEvent` pass
     *  {@link coalesceChatStreamEvents} so per-token deltas don't each persist as a
     *  row. Must be concatenation-preserving. */
    coalesce?: (events: unknown[]) => unknown[];
    /** Optional scope (thread/session id) recorded with the turn status, so
     *  {@link TurnEventStore.listRunning} can find this turn after a reload. */
    scopeId?: string;
    /** How often to renew the running-turn lease while a producer is alive.
     *  The timer is backed up by event-driven renewal when a runtime freezes
     *  unreferenced timers during remote I/O. Default
     *  {@link DEFAULT_RUNNING_TURN_RENEW_INTERVAL_MS}. */
    runningTurnRenewIntervalMs?: number;
}
/** A push-driven buffer for a turn whose producer the caller does NOT own. */
export interface BufferedTurnTap {
    /** Buffer one event: persist (coalesced, on the flush window) + best-effort
     *  live-deliver. Wire to a push source's per-event hook (e.g. agent-runtime
     *  `handleChatTurn`'s `hooks.onEvent`). Marks the turn 'running' on first call. */
    onEvent(raw: unknown): Promise<void>;
    /** Settle the turn: final flush + set status. Call after the producer resolves
     *  ('complete') or rejects ('error'). 'error' flushes what was produced first. */
    done(status?: Extract<TurnStatus, 'complete' | 'error'>): Promise<void>;
    /**
     * Give terminal-status ownership to an external durable runner. Stops this
     * tap's running-lease renewal and flushes its current projection, but keeps
     * `onEvent` available as an append-only live-observation path. Events
     * received after the handoff flush before this method's caller continues,
     * so a durable owner cannot publish terminal status ahead of an observed
     * event. Call it again when observation ends to flush any final event.
     *
     * A caller MUST have registered that durable owner before detaching: this
     * method intentionally writes no replacement status.
     */
    detach(): Promise<void>;
}
/**
 * The buffering core. Sequence-numbers every event, delivers it to `write`
 * (best-effort — a disconnected client never stops buffering), and flushes to
 * the store in coalesced batches. Drives both transports:
 *
 *   • {@link pumpBufferedTurn}     — when you OWN an `AsyncIterable` producer.
 *   • this tap (`onEvent`/`done`)  — when the producer owns iteration and only
 *     hands you a push callback (agent-runtime `handleChatTurn`'s `hooks.onEvent`
 *     + the finished body). Durability stays here in the shell; the engine needs
 *     no `TurnEventStore` seam.
 */
export declare function createBufferedTurnTap(opts: BufferedTurnOptions): BufferedTurnTap;
/** Define options to pump data from an asynchronous iterable source with buffered turn control */
export interface PumpBufferedTurnOptions extends BufferedTurnOptions {
    source: AsyncIterable<unknown>;
}
/**
 * Drive a turn to completion regardless of the live client, when you OWN the
 * producer as an `AsyncIterable`. A thin driver over {@link createBufferedTurnTap}.
 * Returns a promise that resolves when the turn finishes — hand it to
 * `ctx.waitUntil` so a disconnect can't kill the turn. Never rejects on
 * client-write failure; a source error marks the turn 'error' (after flushing
 * what was produced) and rethrows.
 */
export declare function pumpBufferedTurn(opts: PumpBufferedTurnOptions): Promise<void>;
/** Define options for replaying turn events with control over sequence, polling, and timeout */
export interface ReplayTurnEventsOptions {
    store: TurnEventStore;
    turnId: string;
    /** Replay strictly after this sequence number (0 = from the beginning). */
    fromSeq?: number;
    /** Poll cadence while the turn is still running. Default 500ms. */
    pollMs?: number;
    /** Give up following a 'running' turn after this long. Default 120s. */
    timeoutMs?: number;
}
/**
 * Yield buffered events after `fromSeq`, then keep polling while the turn is
 * still 'running' until it completes, errors, or times out. Terminates with a
 * final `{seq: -1, event: '{"type":"turn_status",...}'}` marker so clients
 * know why the replay ended.
 */
export declare function replayTurnEvents(opts: ReplayTurnEventsOptions): AsyncGenerator<BufferedTurnEvent>;
/**
 * Serialize a replayed row for the wire, stamping the buffer ordinal ONTO the
 * line so a reconnecting client can continue from `?fromSeq=<lastSeq>`.
 *
 * The seq lives on the {@link BufferedTurnEvent} row wrapper, not inside the
 * serialized event — `flush()` builds `{seq: ++seq, event: JSON.stringify(ev)}`.
 * A route that enqueues `row.event` alone therefore emits lines with no seq at
 * all, and every client cursor silently pins to 0: each reconnect refetches the
 * whole turn and re-applies every delta onto already-rendered state. This
 * restores the contract `web-react/chat-stream` already documents ("replayed
 * lines carry an extra `seq` — transparently ignored").
 *
 * The `{seq: -1}` `turn_status` sentinel is passed through unstamped: it is a
 * terminator, not a cursor position, and stamping it would move a client's
 * cursor to -1.
 *
 * Fail-soft by construction — a line that is not a JSON object passes through
 * verbatim. A stamping bug must degrade to today's behaviour, never break a
 * replay.
 */
export declare function stampReplaySeq(row: BufferedTurnEvent): string;
/** A bound D1 statement used by the turn store. */
export interface D1BoundForTurns {
    run(): Promise<unknown>;
    all<T = Record<string, unknown>>(): Promise<{
        results: T[];
    }>;
    first<T = Record<string, unknown>>(): Promise<T | null>;
}
/** Minimal structural D1 contract (Cloudflare `D1Database` satisfies it). */
export interface D1LikeForTurns {
    prepare(sql: string): {
        bind(...values: unknown[]): D1BoundForTurns;
    };
    /** D1's only atomic primitive. Retention refuses a driver without it rather
     *  than deleting events and status in separate, reorderable requests. */
    batch?(statements: D1BoundForTurns[]): Promise<unknown[]>;
}
/** Schema for the D1 store — append to the product's migrations. */
export declare const TURN_EVENTS_MIGRATION_SQL = "\nCREATE TABLE IF NOT EXISTS turn_events (\n  turnId TEXT NOT NULL,\n  seq INTEGER NOT NULL,\n  event TEXT NOT NULL,\n  PRIMARY KEY (turnId, seq)\n);\nCREATE TABLE IF NOT EXISTS turn_status (\n  turnId TEXT PRIMARY KEY,\n  status TEXT NOT NULL,\n  scopeId TEXT,\n  updatedAt TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS idx_turn_status_scope ON turn_status (scopeId, status);\nCREATE INDEX IF NOT EXISTS idx_turn_status_retention ON turn_status (status, updatedAt);\n";
/** For deployments whose `turn_status` table predates `scopeId`/`listRunning` —
 *  run once to add the column (the CREATE above already includes it for new
 *  deployments). SQLite ignores a duplicate-add error if already applied. */
export declare const TURN_STATUS_SCOPE_MIGRATION_SQL = "ALTER TABLE turn_status ADD COLUMN scopeId TEXT;";
/** For deployments that already have the turn tables, add the index used by
 *  terminal-turn retention without rerunning the table migration. */
export declare const TURN_STATUS_RETENTION_MIGRATION_SQL = "CREATE INDEX IF NOT EXISTS idx_turn_status_retention ON turn_status (status, updatedAt);";
export declare function createD1TurnEventStore(db: D1LikeForTurns, options?: TurnEventStoreOptions): TurnEventStore;
/** In-memory store for tests and keyless local dev. */
export declare function createMemoryTurnEventStore(options?: TurnEventStoreOptions): TurnEventStore;
