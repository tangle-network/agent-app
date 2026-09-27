/**
 * Detached (autonomous) turn → live buffer bridge.
 *
 * The interactive lane (`createChatTurnRoutes`) already streams a user-typed
 * turn to the browser while it runs. An AUTONOMOUS turn — a mission step, a
 * queue job, an inbound-email review — runs detached (`dispatchPrompt`/
 * `streamPrompt` server-side so it survives no one watching) and, historically,
 * only persisted its FINAL message. A browser opening the session mid-run saw a
 * dead screen: the live tokens existed server-side but were never written to
 * the turn-event buffer the client re-attach path (`listRunning` + `/replay`)
 * reads.
 *
 * `runDetachedTurn` is that missing bridge, packaged. It taps the same buffer
 * the interactive lane uses (`createBufferedTurnTap`) with the same producer
 * mapping (`createSandboxChatProducer`), so an autonomous run is watchable
 * token-by-token exactly like an interactive one — while staying durable
 * (a durable driver re-invokes it after a crash; a turn that finished
 * server-side short-circuits instead of re-streaming). Products supply only the
 * domain seams: the raw sandbox event stream, the turn store, and the ids.
 *
 * This is app-shell mechanism (turn durability + live projection), not engine:
 * it owns no loop logic and imports no SDK — the event source is an injected
 * `AsyncIterable`.
 */
import type { ModelFailoverAttempt } from '../model-resolution/failover';
import { type TurnEventStore } from '../stream/index';
import { type AssistantDraftStore, type DraftPersistenceTuning } from './draft-persistence';
import { type SandboxChatProducerOptions } from './sandbox-producer';
import type { ChatTurnUsage } from './turn-routes';
/** The normalized structured message body (tool-call / file / plan / interaction
 *  parts) that `/chat-store` persists as the durable assistant row — the same
 *  shape `createSandboxChatProducer().assistantParts()` returns. */
export type DetachedTurnParts = Array<Record<string, unknown>>;
/** Authoritative final receipt for a turn that finished server-side, or whose
 *  live stream carried no usage (some harness paths only expose tokens via the
 *  completed-turn record, e.g. `box.findCompletedTurn(turnId)`). */
export interface DetachedTurnFinal {
    text?: string;
    usage?: ChatTurnUsage;
    /** The structured parts to persist when this receipt is more complete than
     *  the live stream (cached, finished server-side, or a fast stream that
     *  delivered scalar text before its message-part events). Omitted when the
     *  record only carries a usage receipt. */
    parts?: DetachedTurnParts;
}
/** Define options for managing and projecting a detached turn event stream in a session */
export interface DetachedTurnOptions {
    store: TurnEventStore;
    turnId: string;
    /** Thread/session id — recorded as the buffer scope so a browser opening the
     *  session mid-run rediscovers this turn via `listRunning(scopeId)` after it
     *  has lost the turnId. */
    scopeId: string;
    /** The raw sandbox event stream for this turn (e.g. `streamSandboxPrompt`).
     *  Ownership of the box, prompt, tooling, and attachments stays with the
     *  caller — this only projects the stream.
     *
     *  An already-open stream is bound to one model and cannot fail over. Prefer
     *  {@link openEvents}; exactly one of the two is required. */
    events?: AsyncIterable<unknown>;
    /** Open the raw sandbox stream FOR A GIVEN MODEL — the failover-capable form
     *  of {@link events}. Wiring it turns failover on with no further flag
     *  whenever {@link fallbackModels} is non-empty. Requires {@link model}.
     *
     *  An autonomous run is the case that most needs this: nobody is watching to
     *  notice a dead upstream and retry by hand, so without failover the mission
     *  step or queue job simply fails. Forwarded to the producer. */
    openEvents?: SandboxChatProducerOptions['openEvents'];
    /** Models to try, in order, when `model`'s upstream is dead. Product config —
     *  see the producer's note on why a same-family fallback is not automatically
     *  safe and why every fallback is surfaced. */
    fallbackModels?: SandboxChatProducerOptions['fallbackModels'];
    /** Opt out of failover while still using {@link openEvents}. */
    modelFailover?: false;
    /** Maximum time to open/start one model event source through its first event.
     *  Forwarded to the producer; default 120 seconds. */
    openTimeoutMs?: SandboxChatProducerOptions['openTimeoutMs'];
    /** Hard deadline after the source's first lifecycle event for the first
     *  answer-bearing event. Forwarded to the producer; default 60 seconds. */
    firstResponseTimeoutMs?: SandboxChatProducerOptions['firstResponseTimeoutMs'];
    /** Fired when a model is abandoned mid-chain (telemetry/alerting). */
    onModelFallback?: SandboxChatProducerOptions['onModelFallback'];
    /** The PREFERRED model. Recorded on the persisted assistant message + usage
     *  receipt — unless failover moved the turn, in which case the model that
     *  actually served is recorded instead and surfaced on the result. */
    model?: string;
    /** Per-flush buffer coalescer. Default `coalesceDeltas`. */
    coalesce?: (events: unknown[]) => unknown[];
    /** Which ask kinds the product renders a card for; anything else is
     *  auto-declined via {@link declineInteraction}. Forwarded to the producer. */
    isRenderableInteraction?: SandboxChatProducerOptions['isRenderableInteraction'];
    /** Resolve a non-renderable ask so the run never hangs in the broker. An
     *  autonomous turn has NO human watching to answer an ask, so a caller that
     *  omits this risks the run blocking until the broker times out — wire it for
     *  any unattended run. Forwarded to the producer. */
    declineInteraction?: SandboxChatProducerOptions['declineInteraction'];
    /** Opt-in eager promotion of harness-emitted `file` parts. Forwarded to the
     *  producer (see its docs). */
    promoteFilePart?: SandboxChatProducerOptions['promoteFilePart'];
    /** Authoritative final receipt, consulted whenever a re-invoke finds a prior
     *  buffer: (a) an already-`complete` turn returns it as the cached result,
     *  (b) a `running` turn (crash mid-run) uses it to detect a run that finished
     *  server-side, and (c) a clean run whose stream carried no usage or only
     *  scalar text falls back to it. For Sandbox runs, use
     *  `readCompletedSandboxTurn` so the exact completed session message
     *  restores tool/file parts as well as text. */
    completedResult?: () => Promise<DetachedTurnFinal | null | undefined>;
    /** Clear the prior partial buffer for `turnId` before a genuine re-stream.
     *  A crash mid-run leaves buffered rows at seqs 1..N with status `running`;
     *  re-streaming restarts the tap's seq at 0 and would duplicate/interleave
     *  rows. Wire this (delete `turnId`'s buffered events) so a retry is clean.
     *  A re-stream over an existing `running` buffer requires this operation to
     *  succeed. Missing or failed reset leaves the existing stream untouched. */
    resetBuffer?: (turnId: string) => Promise<void>;
    /** Own the durable assistant row for this turn instead of returning the body
     *  for the caller to insert — and keep it in step with the stream.
     *
     *  An autonomous run is exactly the case a late viewer hits: nobody is
     *  watching when it starts, so by the time a browser opens the session the
     *  streaming gateway's hot event buffer may already have expired it. Keeping
     *  that buffer short is what makes it affordable at scale (its Redis
     *  footprint is linear in `ttl x concurrent sessions`), so the durable row —
     *  written incrementally here — is what serves the late viewer.
     *
     *  WIRING THIS TRANSFERS ROW OWNERSHIP: the returned {@link
     *  DetachedTurnResult.messageId} names the row this call wrote (draft rows
     *  during the stream, authoritative values at the end, retraction when the
     *  turn produced nothing). The caller must NOT insert its own assistant row
     *  for the turn. Omit the seam and nothing changes — the result is returned
     *  and the caller persists it exactly as today.
     *
     *  Idempotency reuses the turn's own identity: the row id defaults to
     *  `assistant:<turnId>`, so a durable driver re-invoking after a crash
     *  patches the same row instead of duplicating parts. */
    persist?: DraftPersistenceTuning & {
        store: AssistantDraftStore;
        threadId: string;
        /** Deterministic row id. Default `assistant:<turnId>`. */
        messageId?: string;
        /** Pre-persist text transform (`/redact`), applied to drafts AND the final
         *  write — parity with the interactive lane's `transformFinalText`. */
        transformText?: (text: string) => string | Promise<string>;
    };
    log?: (message: string, meta?: Record<string, unknown>) => void;
}
/** Describe the result of a detached turn including state, text, parts, usage, and optional error or cache flag */
export interface DetachedTurnResult {
    /** `completed` — clean drain: persist + bill. `failed` — a terminal error
     *  event, including the producer's structured `sandbox.stream_failed` event
     *  when the raw sandbox stream throws: skip billing, render an error row. */
    state: 'completed' | 'failed';
    text: string;
    /** The structured assistant body to persist (tool calls, file/plan/interaction
     *  parts). Empty array when the run produced none. */
    parts: DetachedTurnParts;
    usage: ChatTurnUsage;
    /** Present when `state === 'failed'`. */
    error?: string;
    /** True when a prior buffer meant this call returned a cached/finished result
     *  WITHOUT re-streaming (durable-driver retry after a crash). */
    cached: boolean;
    /** The durable assistant row this call wrote, when `persist` was wired.
     *  `null` when the turn produced nothing and the row was retracted. Absent
     *  when the caller owns persistence (today's behavior). */
    messageId?: string | null;
    /** The model that SERVED the turn — the fallback's id when failover moved it.
     *  A caller that bills or scores per model must read this, not the model it
     *  requested. */
    model?: string;
    /** The caller's explicit model request, before shell failover. */
    requestedModel?: string;
    /** The effective model echoed by the downstream sandbox. */
    servedModel?: string;
    /** The effective provider echoed by the downstream sandbox. */
    servedProvider?: string;
    /** How the downstream sandbox selected the effective model. */
    servedSource?: 'request' | 'environment' | 'profile';
    /** True when the preferred model did not serve. Makes an autonomous
     *  downgrade — which no human watched happen — attributable after the fact. */
    usedModelFallback?: boolean;
    /** Every model tried, in order, with the reason each was abandoned. */
    modelAttempts?: ModelFailoverAttempt[];
}
/**
 * Stream a detached turn into the live turn-event buffer, durably.
 *
 * - Idempotent: an already-`complete` turn returns the cached result without
 *   re-streaming (a second event sequence would collide with the buffered one).
 * - Crash-safe: a `running` turn (a prior attempt crashed mid-tap) consults
 *   `completedResult` to detect a run that finished server-side; only a run that
 *   genuinely did not complete is re-streamed, and then over a `resetBuffer`-
 *   cleared buffer so seqs don't corrupt.
 * - Marks the turn `running` under `scopeId` so a mid-run browser finds it.
 * - Settles `complete`/`error` so the client stops tailing and billing/render
 *   can branch on `state`.
 */
export declare function runDetachedTurn(opts: DetachedTurnOptions): Promise<DetachedTurnResult>;
