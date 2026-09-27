/**
 * Sandbox lane: bridge a raw sandbox event stream (`streamSandboxPrompt`) into
 * the `ChatTurnProducer` shape agent-runtime's `handleChatTurn` consumes AND
 * the client vocabulary `/web-react`'s `dispatchChatStreamLine` already parses
 * (`text` / `reasoning` / `tool_call` / `tool_result` / `usage` /
 * `notice` / structured `error` / `interaction`). Legal and tax each hand-rolled
 * this mapping differently;
 * this is that middle, composed from `/stream`'s normalizers — no new loop
 * logic, no SDK import (the event source is an injected `AsyncIterable`).
 *
 * Alongside the live mapping it accumulates the PERSISTED projection — the
 * `message.parts` rows `/chat-store` stores — via `normalizePersistedPart` /
 * `mergePersistedPart` / `finalizeAssistantParts`, plus the usage receipt from
 * `step-finish` parts. `createChatTurnRoutes` reads both after drain.
 */
import { type JsonRecord } from '../stream/index';
import { type EmptyTurnRetryInfo, type ModelFallbackInfo, type OpenModelStream } from './model-failover-stream';
import type { ChatTurnRouteProducer } from './turn-routes';
/** Outcome of a `promoteFilePart` attempt. `key`, when given, becomes the
 *  persisted part's row key (e.g. `attachment:<path>`) so repeat promotions
 *  of the same underlying file fold into one segment instead of appending;
 *  omitted, the default `getPartKey` keying applies.
 *
 *  On failure, `part` is an OPTIONAL substitute part to persist in place of
 *  the raw url-bearing one — this is how a product swaps in a transcript
 *  notice (gtm persists a `warning` notice part, never the transient url) for
 *  a failed promotion instead of baking a `data:`/sandbox-path url into the
 *  durable row. When `part` is present it is persisted (via the same
 *  `recordPersistedPart` path as a success, honoring the optional `key`);
 *  when absent, the existing raw-part fallback applies unchanged — so a
 *  caller that only returns `{ succeeded: false, reason }` keeps today's
 *  behavior verbatim. */
export type FilePartPromotionOutcome = {
    succeeded: true;
    part: Record<string, unknown>;
    key?: string;
} | {
    succeeded: false;
    reason: string;
    part?: Record<string, unknown>;
    key?: string;
};
/** Define options for producing sandbox chat events with rendering and interaction controls */
export interface SandboxChatProducerOptions {
    /** The raw sandbox event stream (e.g. `streamSandboxPrompt(...)`).
     *
     *  An ALREADY-OPEN stream is bound to one model and cannot be reopened, so
     *  this form can never fail over. Prefer {@link openEvents}; exactly one of
     *  the two is required. */
    events?: AsyncIterable<unknown>;
    /** Open the raw sandbox stream FOR A GIVEN MODEL — the failover-capable form
     *  of {@link events}. The callback receives the model to run and returns the
     *  same `AsyncIterable` `events` would have been (typically
     *  `streamSandboxPrompt(shell, box, prompt, { ...opts, model })`).
     *
     *  Wiring this turns failover ON with no further flag: whenever the resolved
     *  chain (`model` + {@link fallbackModels}) holds more than one entry, a model
     *  whose upstream is dead is abandoned BEFORE its first client-visible byte
     *  and the next one is tried. A one-entry chain opens exactly once — no extra
     *  call, no added latency, byte-identical to today.
     *
     *  Requires {@link model}: failover has to know which model it is running. */
    openEvents?: OpenModelStream;
    /** Recorded on the persisted assistant message. When failover moves the turn
     *  to another model, the producer's `model` reports the model that ACTUALLY
     *  served, not this preferred one — see {@link modelFailover}. */
    model?: string;
    /** Models to try, in order, when `model`'s upstream is dead. Product config,
     *  never a shell default: agent-app cannot know which ids are live, and a
     *  baked list would rot into exactly the stale-liveness bug this guards
     *  against. Empty/omitted → one attempt, today's behavior.
     *
     *  Pick these deliberately. A same-family fallback is NOT automatically safe:
     *  `gemini-2.5-flash` produced zero persisted deliverables in 2 of 3 measured
     *  runs on a med-legal filing flow where `gemini-2.5-pro` succeeded. That is
     *  why every fallback is surfaced (persisted `model`, a transcript notice, and
     *  `modelFailover()`) instead of being applied silently. */
    fallbackModels?: readonly string[];
    /** Opt out of failover while still using {@link openEvents}. `false` collapses
     *  the chain to `model` alone. */
    modelFailover?: false;
    /** Maximum time to open/start one model event source through its first event.
     *  Default 120 seconds. This is separate from provider first-output latency
     *  so cold sandbox startup is not mislabeled as an inference failure. */
    openTimeoutMs?: number;
    /** Hard deadline after the source's first lifecycle event for the first
     *  answer-bearing event. Default 60 seconds. Processing/lifecycle events do
     *  not extend it. */
    firstResponseTimeoutMs?: number;
    /** Forward `start`/`status`/`model-processing`/session lifecycle to the
     *  client as it arrives instead of after the commit point, so a product can
     *  show what a turn is waiting on. Default `false`. An abandoned model's
     *  progress then stays on the wire; its answer and receipt never do. */
    liveLifecycleEvents?: boolean;
    /** Fired when a model is abandoned mid-chain (telemetry/alerting). The user
     *  already sees a transcript notice; this is for the operator. */
    onModelFallback?: (info: ModelFallbackInfo) => void;
    /** Re-run the SAME model this many times when a turn completes with no
     *  assistant text at all. Default `0` (unchanged behavior). Requires
     *  {@link openEvents} — there is nothing to re-open on a fixed stream.
     *
     *  Distinct from {@link fallbackModels} on purpose: this never changes which
     *  model answers, so it carries none of the attribution risk a downgrade
     *  does. Measured on production 2026-07-27 through gtm-agent's profile, a
     *  completed-but-blank turn is a transient platform flake — 8 hard cases went
     *  7/8 delivered to 8/8 with one re-run, costing 1 extra turn in 9. */
    emptyTurnRetries?: number;
    /** Fired when a blank turn is discarded and the same model re-run. */
    onEmptyTurnRetry?: (info: EmptyTurnRetryInfo) => void;
    /** Which ask kinds the product renders a card for. Anything else is
     *  auto-declined (see `declineInteraction`) so the run never hangs in the
     *  broker waiting on a card no client will show. Default: question/plan.
     *  Products with per-turn plan mode can close over it without another option:
     *  `(kind) => kind === 'question' || (kind === 'plan' && planEnabled)`. */
    isRenderableInteraction?: (kind: string) => boolean;
    /** Resolve a non-renderable ask (wire `respondToSessionInteraction` with the
     *  session's sidecar connection). Without it, a failure notice is emitted and
     *  the run stays blocked until the broker times out. */
    declineInteraction?: (id: string) => Promise<void>;
    /** Opt-in eager promotion of harness-emitted `file` parts. Unset, a `file`
     *  part persists exactly as the harness sent it — a transient `url` (a
     *  `data:` URI or in-sandbox path) baked into the transcript, which is
     *  today's behavior and stays byte-identical if this is never wired. Set,
     *  EVERY `file` part (never `image`, never any other kind) is routed
     *  through this callback instead of `recordPersistedPart`'s default
     *  fallback — including a part with NEITHER `id` NOR `url` (gtm always
     *  attempts promotion; such a part simply fails "carries no url" and
     *  resolves through the same failure path as any other rejection, rather
     *  than being persisted raw and unpromoted) — so the product can durably
     *  write the bytes and swap in a path-bearing part before the raw url ever
     *  reaches the persisted transcript. Keyed per source-prefixed `id:<id>` /
     *  `url:<url>` (an `id` and a `url` sharing the same text must never collide
     *  onto one memo entry) and memoized by PROMISE (not result), so re-emitted
     *  snapshot events for the same part —
     *  the harness resends the whole part on every update, not just deltas —
     *  fold onto the one in-flight or settled attempt rather than promoting
     *  twice or racing two concurrent writes; a raw part with neither `id` nor
     *  `url` cannot be keyed, so it is invoked UN-memoized (once per event) —
     *  each occurrence is its own attempt. A rejecting promise is caught,
     *  logged via `log`, and treated as `succeeded: false`. On `succeeded:
     *  false` the outcome's optional `part` (a substitute — e.g. a warning
     *  notice — see {@link FilePartPromotionOutcome}) persists in its place when
     *  given; otherwise the raw part persists exactly as it does today — this
     *  seam only decides whether to call the promoter and what to do with its
     *  outcomes; the promotion mechanics (vault write, key derivation, notice
     *  construction) live in the caller's callback, not here. */
    promoteFilePart?: (raw: JsonRecord) => Promise<FilePartPromotionOutcome>;
    log?: (message: string, meta?: Record<string, unknown>) => void;
}
/** Create a sandbox chat producer that manages chat turn routing with logging and interaction rendering options */
export declare function createSandboxChatProducer(options: SandboxChatProducerOptions): ChatTurnRouteProducer;
