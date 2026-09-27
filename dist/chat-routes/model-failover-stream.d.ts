/**
 * Model failover for a STREAMING turn.
 *
 * `/model-resolution`'s `runWithModelFailover` already owns the policy: walk a
 * chain, classify a resolved-or-thrown signal, re-throw a non-outage failure
 * immediately, and carry the attempt trail. This module does NOT re-implement
 * any of that — it composes it. What it adds is the one thing a whole-call
 * primitive cannot express, because a stream fails PARTWAY:
 *
 *   **A turn may only fail over before its first client-visible byte.**
 *
 * Once a text delta, tool call, or ask has reached the browser (and the
 * persisted transcript), restarting on another model would duplicate the
 * answer. So each attempt is probed: open the stream, pull events into a small
 * buffer, and decide at the first meaningful event whether this model is
 * serving. Committing replays the buffer and hands the live iterator through;
 * abandoning discards the buffer (those events describe the dead model's
 * session — including its `step-finish` usage, which must never be billed) and
 * lets `runWithModelFailover` walk to the next model.
 *
 * `liveLifecycleEvents` relaxes the buffer for progress only. `start`,
 * `status`, `model-processing`, and session lifecycle carry no answer and no
 * receipt, so a product may take them the moment they arrive and show what
 * the turn is waiting on. Measured 2026-09-11 on a warm production box:
 * OpenCode reports whole parts, so the buffer held every event for 16 s and
 * the product could show nothing through provisioning and agent startup. Off
 * by default: with it on, an abandoned model's progress stays in the stream.
 *
 * The classification itself is `isUpstreamUnavailable` verbatim, so this path
 * inherits the measured facts from the 2026-07-25 outage — above all that an
 * outage is NOT always a thrown error: the sandbox RESOLVES a terminal `error`
 * event carrying `{ errorCode: 'provider_inference_unavailable' }`, which a
 * classifier inspecting only `catch` misses entirely. That resolved shape is
 * the whole reason the breakage went unnoticed, so it is classified here first.
 *
 * Conservative by construction:
 * - A terminal failure that is NOT an outage (400, bad schema, content filter)
 *   COMMITS rather than failing over — it surfaces to the user exactly as it
 *   does today. Those fail identically on every model; walking the chain would
 *   only multiply latency and spend to reach the same error.
 * - A clean stream that produced nothing NEVER walks the chain. An empty answer
 *   is not evidence of a dead upstream, and a silent re-roll on another model is
 *   precisely the unattributable downgrade this work exists to prevent. Opt-in
 *   `emptyTurnRetries` re-runs the SAME model instead, which leaves attribution
 *   untouched — measured on production 2026-07-27, an empty turn is a transient
 *   platform flake that a same-model re-run recovers (8 hard cases: 7/8
 *   delivered on the first pass, 8/8 with one re-run, at a cost of 1 extra turn
 *   in 9). Default `0`, so the behavior is unchanged unless a product asks.
 * - A responsive chain of length 1 costs no extra call or latency and remains
 *   byte-identical to no failover. A silent chain is now deliberately bounded.
 */
import { ModelFailoverExhaustedError, type ModelFailoverAttempt } from '../model-resolution/failover';
/**
 * True when `event` puts content in front of the user (or in the persisted
 * transcript), making a restart on another model unsafe.
 *
 * Deliberately an allow-list of KNOWN-INERT types rather than a deny-list: an
 * unrecognized event commits. Getting this wrong in the safe direction costs a
 * missed failover; getting it wrong the other way duplicates a user's answer.
 */
export declare function isCommittingSandboxEvent(event: unknown): boolean;
/**
 * Condense an abandoned attempt's raw failure text into something safe to show
 * a customer in the transcript.
 *
 * Measured on the live router 2026-07-27 19:40 UTC: an edge 5xx arrives as
 * Cloudflare's full HTML error PAGE, so the verbatim reason began
 * `<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie"…` and the
 * fallback notice pasted 200 bytes of that markup into the answer the customer
 * reads. The cause is worth stating; the markup is not.
 *
 * Only the DISPLAY string is condensed. The full text stays on
 * `modelFailover.attempts[].reason` for the operator, so nothing is lost —
 * this narrows what the customer sees, never what telemetry records.
 */
export declare function summarizeFailoverReason(reason: string): string;
/** A terminal failure event, classified. `outage` decides failover vs surface. */
interface TerminalFailure {
    outage: boolean;
    reason: string;
    code?: string;
}
/**
 * Classify a terminal failure event. Returns `null` for any non-terminal event.
 *
 * The RESOLVED shape is checked first and deliberately: the sandbox reports an
 * upstream outage by resolving `{ success: false, errorCode:
 * 'provider_inference_unavailable' }` inside a terminal `error` event's `data`,
 * never by throwing. Both `data` and the whole record are offered to
 * `isUpstreamUnavailable` so a payload nested either way is caught.
 */
/**
 * Progress the consumer may see before the commit point: it names no model
 * output and carries no billing receipt, so streaming it live cannot duplicate
 * an answer or bill an abandoned attempt. `warning` and every
 * `message.part.updated` (including `step-start`/`step-finish`) stay buffered.
 */
export declare function isLiveLifecycleEvent(event: unknown): boolean;
export declare function classifyTerminalFailure(event: unknown): TerminalFailure | null;
/** Open the raw turn stream for one specific model. */
export type OpenModelStream = (args: {
    model: string;
    /** 1 for the preferred model, 2 for the first fallback, and so on. */
    attempt: number;
    /** Aborted when this attempt times out, is abandoned, or finishes. Forward
     *  this to `streamSandboxPrompt(..., { signal })` so a blocked transport is
     *  cancelled immediately rather than only receiving iterator.return(). */
    signal: AbortSignal;
}) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
/** Fired when a model is abandoned and the next one is about to be tried. */
export interface ModelFallbackInfo {
    from: string;
    to: string;
    reason: string;
}
/** Define inputs for streaming a turn across a model failover chain */
export interface ModelFailoverStreamOptions {
    /** Preferred model first, then fallbacks in descending preference. */
    models: readonly string[];
    open: OpenModelStream;
    /**
     * Maximum time to open/start one model's event source, including its first
     * iterator pull. Default 120 seconds, matching the sandbox provisioning
     * ceiling so cold infrastructure startup is bounded independently from
     * provider inference.
     */
    openTimeoutMs?: number;
    /**
     * Hard deadline from the source's first lifecycle event to its first
     * answer-bearing event. Default 60 seconds. Processing/lifecycle events do
     * not commit the attempt and do not extend this deadline.
     */
    firstResponseTimeoutMs?: number;
    /** Override the commit-point rule. Default {@link isCommittingSandboxEvent}. */
    isCommitting?: (event: unknown) => boolean;
    /**
     * Stream {@link isLiveLifecycleEvent} progress to the consumer as it arrives
     * instead of holding it until the attempt commits. Default `false`, which
     * keeps an abandoned model's events entirely off the wire. With it on, such
     * an event is never replayed from the buffer, and one from an abandoned
     * attempt stays in the stream — it describes the sandbox, not the answer.
     */
    liveLifecycleEvents?: boolean;
    onFallback?: (info: ModelFallbackInfo) => void;
    /**
     * How many times to RE-RUN THE SAME MODEL when a turn completes having
     * produced no assistant text at all. Default `0` — byte-identical to no
     * retry.
     *
     * This is deliberately not a chain walk. Falling over to a different model
     * on an empty answer is the unattributable downgrade this module refuses to
     * do; re-running the SAME model changes nothing about attribution, because
     * the model that serves is the model that was asked for.
     *
     * Bounded by the same commit rule as failover: only a turn whose ONLY
     * committing event is a terminal receipt with no text is retried, so nothing
     * that reached the user can ever be produced twice.
     */
    emptyTurnRetries?: number;
    /** Fired when an empty turn is discarded and the same model re-run. */
    onEmptyTurnRetry?: (info: EmptyTurnRetryInfo) => void;
    log?: (message: string, meta?: Record<string, unknown>) => void;
}
/** One same-model re-run of a turn that completed with no assistant text. */
export interface EmptyTurnRetryInfo {
    model: string;
    /** 1 for the first re-run. */
    retry: number;
    /** How many re-runs remain after this one. */
    remaining: number;
}
/** The failover-wrapped stream plus the attribution every consumer needs. */
export interface ModelFailoverStreamHandle {
    events: AsyncGenerator<unknown, void, unknown>;
    /** The model that actually served. `undefined` until the first pull resolves it. */
    servingModel(): string | undefined;
    /** Every model tried, in order, with the reason each was abandoned. */
    attempts(): ModelFailoverAttempt[];
    /** True when the preferred model did not serve — the attributability signal. */
    usedFallback(): boolean;
}
/** Default ceiling for opening/starting one source through its first event. */
export declare const DEFAULT_MODEL_STREAM_OPEN_TIMEOUT_MS = 120000;
/** Default ceiling for the first answer-bearing event after the source's first event. */
export declare const DEFAULT_MODEL_FIRST_RESPONSE_TIMEOUT_MS = 60000;
/** Structured timeout codes surfaced by the producer on final exhaustion. */
export type ModelAttemptTimeoutCode = 'model_stream_open_timeout' | 'provider_first_response_timeout';
/** Every configured model was exhausted and the final one timed out. */
export declare class ModelFailoverTimeoutError extends ModelFailoverExhaustedError {
    readonly code: ModelAttemptTimeoutCode;
    readonly model: string;
    readonly timeoutMs: number;
    constructor(input: {
        attempts: ModelFailoverAttempt[];
        code: ModelAttemptTimeoutCode;
        model: string;
        timeoutMs: number;
    });
}
/**
 * Hard ceiling on same-model re-runs. A turn that comes back blank three times
 * running is not a flake this can retry away, and each pass costs a full
 * sandbox turn — so the budget is capped rather than trusted.
 */
export declare const MAX_EMPTY_TURN_RETRIES = 3;
/**
 * Coerce the caller's budget to a finite, bounded, non-negative integer.
 *
 * `Math.trunc(NaN)` is `NaN` and `retry >= NaN` is false for every `retry`, so
 * a naive clamp turns a bad config value into a loop that opens sandbox streams
 * until the worker dies. `Infinity` has the same shape. Both resolve to `0` —
 * an unusable budget disables the retry rather than running unbounded.
 */
export declare function resolveEmptyTurnRetries(value: number | undefined): number;
/**
 * Wrap `open` in reactive model failover, streaming from the first model in
 * `models` that reaches its commit point.
 *
 * Zero added latency on the happy path: the preferred model is opened first and,
 * the moment it emits anything meaningful, its events flow straight through.
 *
 * @throws ModelFailoverTimeoutError when the final model times out,
 *         ModelFailoverExhaustedError when every model's upstream is down, and
 *         re-throws a non-outage error from the FIRST model without walking the
 *         chain (the latter behaviors are inherited from
 *         `runWithModelFailover`).
 */
export declare function streamWithModelFailover(options: ModelFailoverStreamOptions): ModelFailoverStreamHandle;
export {};
