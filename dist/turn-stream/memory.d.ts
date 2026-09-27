/**
 * In-process turn-stream harness: a fake namespace that routes `idFromName`
 * to REAL {@link TurnStreamDO} instances over an in-memory storage/socket
 * state. The adapters and the DO run their production code paths — only the
 * Cloudflare runtime (isolation, hibernation, real sockets) is simulated.
 *
 * For vitest composition tests and keyless local dev (the same role
 * `createMemoryTurnEventStore` plays for the D1 store). Not for production:
 * state is per-process and evaporates on restart.
 */
import { TurnStreamDO, type TurnStreamDOOptions, type TurnStreamDOState, type TurnStreamSocket } from './do';
import type { TurnStreamNamespaceLike } from './adapters';
/** A test-side viewer socket: records frames sent by the DO and lets the
 *  test drive the `sync` handshake. */
export interface MemoryTurnStreamSocket extends TurnStreamSocket {
    readonly frames: string[];
    readonly closed: boolean;
}
/** Define an in-memory channel for streaming turn-based data with viewer socket connection support */
export interface MemoryTurnStreamChannel {
    /** Attach a viewer socket to this channel (bypasses the HTTP 101 — the
     *  upgrade handshake is Cloudflare-runtime-only) and run its `sync`. */
    connect(input: {
        sessionId: string;
        scope: 'thread' | 'workspace';
        afterSeq?: number;
    }): Promise<MemoryTurnStreamSocket>;
    readonly instance: TurnStreamDO;
}
/** Provide an interface to manage channels and namespaces for memory-based turn stream testing */
export interface MemoryTurnStreamHarness {
    namespace: TurnStreamNamespaceLike;
    /** The channel (creating its DO instance if needed) for a channel key —
     *  e.g. `threadChannelKey(ws, thread)` — to connect test viewers. */
    channel(name: string): MemoryTurnStreamChannel;
}
/**
 * Build the harness. `createInstance` lets a product test run its own
 * `TurnStreamDO` subclass through the same wiring.
 */
export declare function createMemoryTurnStreamHarness(createInstance?: (state: TurnStreamDOState) => TurnStreamDO, _options?: TurnStreamDOOptions): MemoryTurnStreamHarness;
