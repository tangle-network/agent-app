/**
 * Model failover — the answer to "one upstream hit a quota wall and the customer
 * got a Bad Gateway even though the router had abundant healthy capacity".
 *
 * This is deliberately NOT a health probe. Probing before every turn buys a
 * round-trip of latency on the happy path and still races the outage (a model
 * healthy at probe time can 502 a second later). Failover is REACTIVE: run the
 * preferred model, and on an upstream-outage signal move to the next model in
 * the chain. Zero added latency when the preferred model works.
 *
 * Two facts drive the design, both measured against a live box during the
 * 2026-07-25 Anthropic/DeepSeek outage:
 *
 * 1. An outage is NOT always a thrown error. The sandbox resolves with a
 *    payload — `{ success: false, errorCode: 'provider_inference_unavailable' }`
 *    — so a classifier that only inspects `catch` misses the customer-visible
 *    case entirely. `isUpstreamUnavailable` inspects resolved values too.
 * 2. Catalog membership is NOT liveness. The router's `/v1/models` still listed
 *    every dead model during the outage, so `validateChatModelId` admitted
 *    `claude-sonnet-4-6` while every call to it returned 502. Nothing upstream
 *    of the actual call can be trusted to tell you a model is serving.
 *
 * Substrate-free: the caller injects `run`, so this composes with a sandbox
 * turn, a router chat completion, or a test fake without importing any of them.
 */
/**
 * Error codes that mean "this model's upstream is unavailable — a different
 * model may still work". Deliberately excludes codes that would fail identically
 * on every model (bad request, auth, content filter): retrying those down a
 * chain burns latency and money to reach the same failure.
 */
export declare const UPSTREAM_UNAVAILABLE_CODES: readonly string[];
/** HTTP statuses that indicate an upstream capacity/availability problem. */
export declare const UPSTREAM_UNAVAILABLE_STATUSES: readonly number[];
/**
 * The HTTP status a message states in prose, or `undefined` when it states
 * none. Deliberately NOT "any three digits in the string" — an unanchored digit
 * scan would read a token count or a duration as a status.
 */
export declare function readHttpStatusHint(text: string): number | undefined;
/**
 * True when `signal` — a thrown error OR a resolved result payload — indicates
 * the model's upstream is unavailable and another model is worth trying.
 *
 * Checked in order of decreasing confidence: explicit code, HTTP status, then
 * message text. A resolved payload only counts as a failure when it carries an
 * explicit failure marker (`success: false`, or an `error`/`errorCode` field) —
 * a successful result is never misread as an outage.
 */
export declare function isUpstreamUnavailable(signal: unknown): boolean;
/** One model tried, and how it went. */
export interface ModelFailoverAttempt {
    model: string;
    ok: boolean;
    /** Why this model was abandoned. Absent when `ok`. */
    reason?: string;
}
/** The outcome of a failover run: the value plus the full attempt trail. */
export interface ModelFailoverResult<T> {
    value: T;
    /** The model that actually produced `value`. */
    model: string;
    attempts: ModelFailoverAttempt[];
    /** True when the preferred (first) model did not serve the request. */
    usedFallback: boolean;
}
/** Every model in the chain failed; carries the trail for logging. */
export declare class ModelFailoverExhaustedError extends Error {
    readonly attempts: ModelFailoverAttempt[];
    constructor(attempts: ModelFailoverAttempt[]);
}
/** Inputs to {@link runWithModelFailover}. */
export interface RunWithModelFailoverInput<T> {
    /** Preferred model first, then fallbacks in descending preference. */
    models: readonly string[];
    /** Executes one turn with the given model. */
    run: (model: string) => Promise<T>;
    /**
     * Classifies a resolved result as an upstream outage. Defaults to
     * {@link isUpstreamUnavailable}, which understands the sandbox's
     * `{ success: false, errorCode }` payload.
     */
    isUnavailableResult?: (result: T) => boolean;
    /** Classifies a thrown error. Defaults to {@link isUpstreamUnavailable}. */
    isUnavailableError?: (error: unknown) => boolean;
    /** Observability hook fired each time a model is abandoned. */
    onFallback?: (attempt: ModelFailoverAttempt, nextModel: string) => void;
}
/**
 * Run `run` against the first model in `models` that does not report an upstream
 * outage, falling through the chain in order.
 *
 * A non-outage failure (bad request, auth, content filter) is re-thrown
 * immediately rather than retried down the chain — those fail identically on
 * every model, so walking the chain would only multiply latency and spend.
 *
 * @throws ModelFailoverExhaustedError when every model reports an outage.
 */
export declare function runWithModelFailover<T>(input: RunWithModelFailoverInput<T>): Promise<ModelFailoverResult<T>>;
/**
 * Build a failover chain: the preferred model first, then `fallbacks`, with
 * duplicates removed so a model is never retried twice in one turn.
 */
export declare function buildModelChain(preferred: string, fallbacks: readonly string[]): string[];
