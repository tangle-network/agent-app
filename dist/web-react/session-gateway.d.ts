/**
 * Browser adapter for the Sandbox session gateway.
 *
 * The Sandbox SDK owns the WebSocket, reconnect, replay, cursor persistence,
 * and raw event delivery. This module only composes that client with a
 * product-owned grant endpoint and decodes the gateway's event envelope.
 *
 * Keep this entry separate from `web-react`: `@tangle-network/sandbox` is an
 * optional peer, and the dynamic import keeps it out of apps without a
 * sandbox-backed session.
 */
/** A short-lived, read-only grant for one session's gateway stream. */
export interface SessionStreamGrant {
    /** `wss://…/session`, resolved by the product server. */
    url: string;
    /** Read-only JWT. A browser must never receive a Sandbox API key. */
    token: string;
    /** Browser-facing session channel selected by the product. */
    sessionId: string;
    /** Unix seconds, as expected by the SDK token refresher. */
    expiresAt: number;
}
/** Common soft-miss reasons a product grant route may report. */
export type SessionGrantUnavailableReason = 'sandbox-absent' | 'sandbox-not-running' | 'session-absent' | 'gateway-unreachable' | 'mint-failed';
/** The grant endpoint response accepted by {@link parseSessionStreamGrant}. */
export type SessionStreamGrantResponse = ({
    available: true;
} & SessionStreamGrant) | {
    available: false;
    reason?: SessionGrantUnavailableReason;
};
/** A decoded event from the raw Sandbox gateway payload. */
export interface GatewayTurnEvent {
    type: string;
    data?: Record<string, unknown>;
}
/** Event types that terminate a Sandbox execution. */
export declare const GATEWAY_TERMINAL_EVENT_TYPES: ReadonlySet<string>;
/** Gateway bookkeeping events that are not turn feedback. */
export declare const GATEWAY_TRANSPORT_NOTICE_TYPES: ReadonlySet<string>;
/** Report whether a decoded event ends the execution. */
export declare function isTerminalGatewayEvent(type: string): boolean;
/** Report whether a decoded event is gateway bookkeeping. */
export declare function isGatewayTransportNotice(type: string): boolean;
/**
 * Decode one raw `onAgentEvent` payload into the event shape a turn reducer
 * consumes. The gateway carries both message-lane and run/stream envelopes.
 */
export declare function gatewayFrameToTurnEvent(raw: unknown): GatewayTurnEvent | null;
/** Parse a grant response. Invalid or unavailable responses are soft misses. */
export declare function parseSessionStreamGrant(body: unknown): SessionStreamGrant | null;
/** Options for a product-owned grant fetcher. */
export interface SessionStreamGrantFetcherOptions {
    /** Endpoint URL, or a function that receives the product scope id. */
    url: string | ((scopeId: string) => string);
    scopeId: string;
    /** Injectable for tests or a product-specific fetch wrapper. */
    fetchImpl?: typeof fetch;
    /** For example, `{ credentials: 'include' }` on a cross-origin endpoint. */
    requestInit?: RequestInit;
}
/**
 * Build a grant fetcher that never throws. A grant route is an optional live
 * lane, so auth misses, network failures, and malformed bodies fall back to
 * the product's durable lane.
 */
export declare function createSessionStreamGrantFetcher(options: SessionStreamGrantFetcherOptions): (signal: AbortSignal) => Promise<SessionStreamGrant | null>;
/** Minimal structural surface of the SDK session gateway client. */
export interface SessionGatewayClientLike {
    connect(): void;
    disconnect(): void;
    replay(since: number): void | Promise<void>;
    clearReplayState(): void;
}
/** Structural replay storage accepted by the SDK client. */
export interface ReplayCursorStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}
/** Subset of the SDK client configuration used by this adapter. */
export interface SessionGatewayClientConfigLike {
    url: string;
    token: string;
    sessionId: string;
    autoReconnect?: boolean;
    enableReplayPersistence?: boolean;
    replayStorage?: ReplayCursorStorage;
    onTokenRefresh?: () => Promise<{
        token: string;
        expiresAt: number;
    }>;
    handlers?: {
        onAgentEvent?: (channel: string, data: unknown, sequenceId?: number) => void;
        onBackpressureWarning?: (dropped: number, since: number, totalDropped?: number) => void;
        onTokenExpired?: () => void;
        onError?: (message: string, code?: string) => void;
    };
}
/** Injectable SDK-client constructor, used for tests and alternate transports. */
export type SessionGatewayClientFactory = (config: SessionGatewayClientConfigLike) => SessionGatewayClientLike | Promise<SessionGatewayClientLike>;
/** Callbacks driven by one live gateway attachment. */
export interface SessionGatewayLiveViewHandlers {
    signal: AbortSignal;
    /** Every non-duplicate, non-transport event. */
    onEvent: (event: GatewayTurnEvent) => void;
    /** Called after the first real turn event, not a gateway notice. */
    onFirstTurnEvent?: () => void;
    /** Called for each terminal turn event. */
    onTerminal?: () => void;
    /** Called when an attached lane becomes unusable. */
    onUnusable?: (reason: string) => void;
}
/** A handle that stops one gateway attachment. */
export interface SessionGatewayLiveViewAttachment {
    close(): void;
}
/** Structural connector returned by {@link createSessionGatewayLane}. */
export type SessionGatewayLiveViewConnector = (handlers: SessionGatewayLiveViewHandlers) => Promise<SessionGatewayLiveViewAttachment | null>;
/** Options for {@link createSessionGatewayLane}. */
export interface SessionGatewayLaneOptions {
    /** Mint a grant. `null` is a soft miss with no attachable live stream. */
    fetchGrant(signal: AbortSignal): Promise<SessionStreamGrant | null>;
    /** Replay cursor storage. Defaults to `window.localStorage`; `null` disables it. */
    replayStorage?: ReplayCursorStorage | null;
    /** Override the SDK client constructor for tests or another compatible client. */
    createClient?: SessionGatewayClientFactory;
    /** Maximum sequence ids retained for duplicate suppression. */
    appliedSeqCap?: number;
}
/** Default bound on applied sequence ids retained by one attachment. */
export declare const APPLIED_SEQ_CAP = 100000;
/**
 * Build a browser-direct Sandbox live-view connector.
 *
 * The caller supplies a product-authenticated grant fetcher and owns the
 * transcript reducer. A missing grant returns `null`, allowing a durable
 * replay lane to take over without changing the turn.
 */
export declare function createSessionGatewayLane(options: SessionGatewayLaneOptions): SessionGatewayLiveViewConnector;
