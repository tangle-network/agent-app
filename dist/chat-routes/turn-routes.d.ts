/**
 * `createChatTurnRoutes` — the assembled server chat vertical (issue #188
 * Phase 1). One factory composing the pieces every product re-wired by hand:
 *
 *   body parse/validate      → `/web` `parseJsonObjectBody` + `./wire`
 *   turn identity            → `/stream` `resolveChatTurn` + agent-runtime `/durable`
 *                              `deriveExecutionId`
 *   producer                 → injected seam (sandbox lane via
 *                              `createSandboxChatProducer`; router lane is the
 *                              product's own `ChatTurnProducer`)
 *   turn engine              → agent-runtime `/durable` `handleChatTurn` (verbatim)
 *   durability               → `/stream` turn-buffer tap, wired BY DEFAULT
 *                              (tee + drain keeps the turn running after a
 *                              client drop; replay serves the buffered tail)
 *   persistence              → injected `/chat-store`-shaped store
 *                              (user row on send, assistant row on completion)
 *   interactions answer      → `/interactions` `createInteractionAnswerRoute`
 *
 * Handlers are web-standard `Request → Response` (Workers, Node 18+, Deno) —
 * no router import. Auth/access is one injected `authorize` seam, composable
 * with `/app-auth` guards but not coupled to them.
 *
 * Optional product seams let a complex turn-orchestrator compose the vertical
 * instead of hand-rolling a generator — each omittable to the exact behavior
 * above: `turnLock` (single-flight acquire/release around the turn),
 * `contextGate` (pre-producer domain-readiness short-circuit), `beforeTurn`
 * (observe + augment the producer input), `lifecycle` (deterministic
 * start/complete/error telemetry), `heartbeat` (keepalive during silent
 * producer waits), and `onRawEvent` (the raw producer events, for telemetry) —
 * plus the `authorize` result's `insertUserMessage` flag (suppress the user row
 * for a product-dispatched turn). `handleChatTurn` stays the engine — the seams
 * only wrap its input, its producer stream, and its settle.
 *
 * Seam stability: all of the above are STABLE and safe to depend on. They
 * graduated in #227 against the bar this package holds itself to — a seam is
 * provisional until two INDEPENDENT consumers exercise it, because one
 * consumer's shape is indistinguishable from that consumer's assumptions.
 * `turnLock` cleared it with `/turn-stream`'s shared DO adapter (#221);
 * `contextGate`, `beforeTurn`, `onRawEvent` and `insertUserMessage` each
 * cleared it with two product verticals reading them differently — and the
 * review found no leaked assumptions to fix, only `ChatRouteEvent` to export.
 *
 * They stay FLAT top-level options (not grouped under a `hooks` object): that
 * grouping would break every shipped consumer's call for no mechanism gain, and
 * this package's exports are additive-only. For the same reason `onRawEvent`
 * keeps its two-argument `(event, context)` signature rather than being
 * normalized to the single-args shape the other seams take.
 */
import { type ChatTurnIdentity, type ChatTurnProducer } from '@tangle-network/agent-runtime/durable';
import { type ChatMessagePart } from '../chat-store/parts';
import { type DraftPersistenceTuning } from './draft-persistence';
import { type InteractionAnswerRoute, type InteractionAnswerRouteOptions } from '../interactions/route';
import { type PersistedChatMessageForTurn, type TurnEventStore } from '../stream/index';
import type { ModelFailoverAttempt } from '../model-resolution/failover';
import { type ChatTurnPartInput, type ChatTurnRequestPayload } from './wire';
/** Usage receipt persisted onto the assistant message (the flattened
 *  `step-finish` shape `/chat-store`'s columns mirror). */
export interface ChatTurnUsage {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costUsd?: number;
}
/** What the route persists — a structural subset of `/chat-store`'s
 *  `ChatStore`, so `createChatStore(db, tables)` satisfies it directly and a
 *  product with its own persistence adapts without importing drizzle. */
export interface ChatTurnMessageStore {
    listMessages(threadId: string): Promise<Array<{
        id: string;
        role: 'user' | 'assistant' | 'system' | 'tool';
        content: string;
        parts?: ChatMessagePart[] | null;
    }>>;
    appendMessage(input: {
        /** Caller-assigned row id. Honored by `/chat-store`'s `createChatStore`;
         *  a product store free to ignore it (the writer then adopts whatever id
         *  the insert returns). Set only by incremental persistence. */
        id?: string;
        threadId: string;
        role: 'user' | 'assistant';
        content: string;
        parts?: ChatMessagePart[];
        model?: string | null;
        requestedModel?: string | null;
        servedModel?: string | null;
        servedProvider?: string | null;
        servedSource?: string | null;
        inputTokens?: number | null;
        outputTokens?: number | null;
        reasoningTokens?: number | null;
        cacheReadTokens?: number | null;
        cacheWriteTokens?: number | null;
        costUsd?: number | null;
    }): Promise<unknown>;
    /** Patch an existing row. Its PRESENCE is what enables incremental assistant
     *  persistence — a store without it keeps today's exact single-write-on-
     *  completion behavior, which is what makes this additive. */
    updateMessage?(id: string, patch: {
        content?: string;
        parts?: ChatMessagePart[];
        model?: string | null;
        requestedModel?: string | null;
        servedModel?: string | null;
        servedProvider?: string | null;
        servedSource?: string | null;
        inputTokens?: number | null;
        outputTokens?: number | null;
        reasoningTokens?: number | null;
        cacheReadTokens?: number | null;
        cacheWriteTokens?: number | null;
        costUsd?: number | null;
    }): Promise<unknown>;
    /** Remove a row. Used to retract a draft assistant row for a turn that ended
     *  producing nothing, so the empty-turn case still leaves no row at all. */
    deleteMessage?(id: string): Promise<unknown>;
}
/** `ChatTurnProducer` plus the persisted projection the assembly reads after
 *  drain. `createSandboxChatProducer` returns this; a router-lane producer
 *  may omit the optional members (finalText persists as a single text part). */
export interface ChatTurnRouteProducer extends ChatTurnProducer {
    assistantParts?(): Array<Record<string, unknown>>;
    /** MID-STREAM snapshot of the same projection, safe to call while the turn
     *  is running: no dangling-tool terminalization, no pending-ask settlement
     *  (see `/stream`'s `draftAssistantParts`). Read by incremental persistence.
     *  A producer that omits it still drafts — the scalar text — but persists no
     *  parts until the turn completes. */
    draftParts?(): Array<Record<string, unknown>>;
    usage?(): ChatTurnUsage;
    /** The model that SERVED the turn. With failover wired this is the model that
     *  actually answered, which is not necessarily the one the caller preferred —
     *  read it after the stream drains, never before. */
    model?: string;
    /** Model-failover attribution, when the producer supports it. Reported onto
     *  the usage/billing receipt so a downgrade is never silent. */
    modelFailover?(): ChatTurnModelFailover;
    /** Requested-versus-served attribution reported by the sandbox sidecar.
     *  `echoReceived` distinguishes a missing echo from a partial echo. */
    modelAttribution?(): ChatTurnModelAttribution;
}
/** Which model served, and what it took to get there. */
export interface ChatTurnModelFailover {
    /** The model that served the turn. */
    model?: string;
    /** Every model tried, in order, with the reason each was abandoned. */
    attempts: ModelFailoverAttempt[];
    /** True when the preferred model did not serve. */
    usedFallback: boolean;
}
/** Requested and effective model attribution for one sandbox turn. */
export interface ChatTurnModelAttribution {
    /** The model explicitly requested by the caller, before shell failover. */
    requestedModel?: string;
    /** The model the downstream sandbox reports actually served the turn. */
    servedModel?: string;
    /** The provider that served the turn, when echoed by the sandbox. */
    servedProvider?: string;
    /** How the sandbox selected the served model. */
    servedSource?: 'request' | 'environment' | 'profile';
    /** True when a structurally valid effective-backend echo was observed. */
    echoReceived: boolean;
}
/** Resolve authorization status and context for a chat turn including tenant and user identification */
export type ChatTurnAuthorization<TContext> = {
    ok: true;
    tenantId: string;
    userId: string;
    context: TContext;
    /** When `false`, skip the `role:'user'` message insert for this turn — for
     *  a product-dispatched / synthetic turn (e.g. a follow-up the product
     *  raised itself) that must not surface a new user row. Composes with —
     *  never overrides — the engine's retry-dedup: `authorize` runs before
     *  turn identity is resolved, so it cannot tell a retry from a fresh turn;
     *  a turn already deduped stays deduped. Omit / `true` → today's behavior.
     *
     *  Settled shape (#227). The validated case in both consumers is the same:
     *  a durable plan-approval follow-up re-entering an execution the decision
     *  route already enqueued — a decision, not a typed message, so it must
     *  not surface a user bubble. Suppressing the insert also propagates:
     *  `ChatTurnProduceArgs.userMessageId` is `null` for the rest of the turn
     *  when there is no row to reuse, so a seam anchoring to the user row must
     *  handle that arm rather than assume a string. */
    insertUserMessage?: boolean;
} | {
    ok: false;
    response: Response;
};
/** Define arguments required to authorize a chat turn based on intent and request details */
export interface ChatTurnAuthorizeArgs {
    request: Request;
    intent: 'turn' | 'replay' | 'running';
    /** Parsed, validated POST body (turn intent only). */
    body?: ChatTurnRequestPayload;
    /** The buffered turn id being replayed (replay intent only). */
    turnId?: string;
    /** The thread whose running turns are being discovered (running intent only). */
    threadId?: string;
}
/** Trusted per-turn limits supplied by a server adapter, never by the body. */
export interface ChatTurnExecutionLimits {
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxReasoningTokens?: number;
    maxToolTokens?: number;
    maxToolCalls?: number;
    maxProviderCostUsd?: number;
}
/** Server-only context for one turn request. */
export interface ChatTurnRequestContext {
    waitUntil?(p: Promise<unknown>): void;
    /** Abort this turn when its HTTP client disconnects. Browser callers omit it. */
    cancelOnDisconnect?: boolean;
    /** Limits already authenticated by the server adapter. */
    executionLimits?: ChatTurnExecutionLimits;
}
/** Define the arguments required to produce a chat turn with context and messaging details */
export interface ChatTurnProduceArgs<TContext> {
    request: Request;
    body: ChatTurnRequestPayload;
    identity: ChatTurnIdentity;
    context: TContext;
    /** The message to send: plain text, or parts when the client attached
     *  files (a text part is prepended from `content` when present). */
    prompt: string | ChatTurnPartInput[];
    /** Stable id for cross-process reconnect (`deriveExecutionId`). */
    executionId: string;
    /** The turn-buffer id announced to the client for replay. */
    turnStreamId: string;
    priorMessages: PersistedChatMessageForTurn[];
    /** Server-authenticated limits for this turn. Never copied from the body. */
    executionLimits?: ChatTurnExecutionLimits;
    /** The durable `role:'user'` row this turn is anchored to — the row the
     *  factory just inserted, or the one retry-dedup REUSED. Products anchor
     *  optimistic-bubble swaps, retry targeting, and stop-polling to it, and it
     *  is the only way to name a REUSED row (which `priorMessages` excludes).
     *
     *  Three states, all meaningful:
     *  - `undefined` — not resolved yet. `turnLock.acquire` is the one seam that
     *    sees this: it runs before any side effect by contract, so the row does
     *    not exist when it reads the args.
     *  - `null` — resolved, no row: `authorize` returned `insertUserMessage:
     *    false` on a turn with nothing to reuse, or the store's `appendMessage`
     *    resolved without a usable id.
     *  - a string — the row id, for `contextGate`, `beforeTurn`, and `produce`. */
    userMessageId?: string | null;
    /**
     * Transfer completion ownership to a product-owned durable runner. The
     * product MUST first register that runner durably, then await this callback
     * before dispatching native execution. Once it resolves, this route remains
     * a live event projector only: it no longer writes or settles the assistant
     * transcript, lifecycle hooks, lock, or replay-buffer status.
     *
     * Optional for source compatibility with synthetic producers. Every
     * `createChatTurnRoutes` invocation supplies it before `produce` runs.
     */
    handoffCompletion?: () => Promise<void>;
}
/** One event as it crosses the route: the producer's own vocabulary, or an
 *  injected keepalive. Same shape the engine forwards verbatim.
 *
 *  Public because it IS the vocabulary of two seams — `onRawEvent`'s parameter
 *  and `heartbeat.event`'s return. Exported so a product can declare a
 *  standalone handler (`function onRawEvent(e: ChatRouteEvent, ctx: T)`) rather
 *  than depending on contextual typing from an inline object literal. */
export type ChatRouteEvent = {
    type: string;
    data?: Record<string, unknown>;
};
/** Keepalive emitted while the producer is quiet (long tool calls, first-token
 *  wait) so client watchdogs stay re-armed. One is emitted each time
 *  `intervalMs` elapses with no producer event; the window resets on every real
 *  event, so a chatty producer never triggers one. The product owns the event
 *  shape (`type` + `data`). Omit → no keepalives (today's behavior). */
export interface ChatTurnHeartbeat {
    intervalMs: number;
    event(info: {
        elapsedMs: number;
        tick: number;
    }): ChatRouteEvent;
}
/** Patch a `beforeTurn` hook returns to augment the producer's input. Omitted
 *  fields keep the route-assembled value; the product's `produce` still owns
 *  the system prompt. */
export interface ChatTurnInputPatch {
    prompt?: string | ChatTurnPartInput[];
    priorMessages?: PersistedChatMessageForTurn[];
}
/** Pre-turn readiness verdict — proceed, short-circuit, or hand off to a
 *  product-owned durable turn. Distinct from `authorize`: this gates domain
 *  readiness, not access. */
export type ChatTurnGateResult = {
    proceed: true;
} | {
    proceed: false;
    response: Response;
}
/** The product has accepted the turn and owns execution and lifecycle after
 *  the route releases its lock. */
 | {
    proceed: 'handoff';
    response: Response;
};
/** Single-flight lock verdict — acquired (with an opaque handle passed back to
 *  `release`), or already held (short-circuit with the product's 409-style
 *  `Response`). */
export type ChatTurnLockResult = {
    acquired: true;
    handle?: unknown;
} | {
    acquired: false;
    response: Response;
};
/** Async acquire/release wrapped around the turn. `acquire` runs before any
 *  side effect; `release` runs once when the turn settles — including on a
 *  short-circuit or a throw. */
export interface ChatTurnLock<TContext> {
    acquire(args: ChatTurnProduceArgs<TContext>): ChatTurnLockResult | Promise<ChatTurnLockResult>;
    release(handle: unknown): void | Promise<void>;
}
interface ChatTurnLifecycleBase<TContext> {
    identity: ChatTurnIdentity;
    executionId: string;
    turnStreamId: string;
    context: TContext;
}
/** Define lifecycle start event with context and timestamp for a chat turn */
export interface ChatTurnLifecycleStart<TContext> extends ChatTurnLifecycleBase<TContext> {
    startedAt: number;
}
/** Define the structure representing the completion state of a chat turn lifecycle with usage data */
export interface ChatTurnLifecycleComplete<TContext> extends ChatTurnLifecycleBase<TContext> {
    finalText: string;
    usage: ChatTurnUsage;
    durationMs: number;
    /** The model that SERVED the turn — the fallback's id when failover moved it.
     *  `usage` is that model's, so telemetry that splits cost or quality by model
     *  must key on this and not on the requested one. */
    model?: string;
    /** Requested-versus-served attribution. A difference is detectable from
     *  this receipt and from the persisted assistant row independently. */
    requestedModel?: string;
    servedModel?: string;
    servedProvider?: string;
    servedSource?: 'request' | 'environment' | 'profile';
    /** Attribution for a downgrade: which models were tried and why each failed.
     *  `undefined` when the producer reports no failover support. */
    modelFailover?: ChatTurnModelFailover;
    /** The durable `role:'assistant'` row this turn wrote, or `null` when it
     *  wrote none (an empty turn leaves no row — a draft started mid-stream is
     *  retracted). The detached lane surfaces the same id as
     *  `DetachedTurnResult.messageId`; one contract, two lanes. */
    assistantMessageId: string | null;
    /** Set when `contextGate` answered this turn and the producer never ran.
     *
     *  Present so telemetry can tell "the model produced nothing" apart from "the
     *  model was never asked" — they look identical here (`finalText: ''`,
     *  empty `usage`) and mean opposite things. A gated turn writes no assistant
     *  row, so `assistantMessageId` is `null`, and the billing/persistence
     *  `onTurnComplete` is deliberately NOT fired for it. */
    gated?: true;
}
/** Represent an error occurring during a chat turn lifecycle with context and duration information */
export interface ChatTurnLifecycleError<TContext> extends ChatTurnLifecycleBase<TContext> {
    error: unknown;
    durationMs: number;
}
/** Deterministic run telemetry: `onTurnStart` fires before the producer runs;
 *  exactly one of `onTurnComplete` / `onTurnError` fires after the turn
 *  settles, always after `onTurnStart`. Failure is derived from the turn's own
 *  `error` / `session.run.failed` events (or a drain throw), not the engine's
 *  lifecycle envelope. Hook errors are swallowed — telemetry never fails a
 *  turn. */
export interface ChatTurnLifecycle<TContext> {
    onTurnStart?(info: ChatTurnLifecycleStart<TContext>): void | Promise<void>;
    onTurnComplete?(info: ChatTurnLifecycleComplete<TContext>): void | Promise<void>;
    onTurnError?(info: ChatTurnLifecycleError<TContext>): void | Promise<void>;
}
/** What a settled turn reports to `onTurnComplete` — the product's
 *  post-processing seam (billing, titles, audit). */
export interface ChatTurnCompleteInput<TContext> {
    identity: ChatTurnIdentity;
    finalText: string;
    context: TContext;
    failed: boolean;
    failureReason?: string;
    /** The model that SERVED this turn. With failover wired it may differ from
     *  the requested one, so a product that bills or scores per model MUST read
     *  it here rather than assuming the model it asked for. */
    model?: string;
    /** Requested-versus-served attribution. A difference is detectable from
     *  this receipt and from the persisted assistant row independently. */
    requestedModel?: string;
    servedModel?: string;
    servedProvider?: string;
    servedSource?: 'request' | 'environment' | 'profile';
    /** Present when the producer supports failover: the full attempt trail, and
     *  `usedFallback` — the flag that makes a silent downgrade impossible. */
    modelFailover?: ChatTurnModelFailover;
    /** The durable `role:'assistant'` row this turn wrote, or `null` when it
     *  wrote none (an empty turn leaves no row).
     *
     *  Populated even when `failed` is true — a terminal error event still
     *  persists whatever partial answer arrived, and that pairing is exactly
     *  what lets a product render an error row against a REAL message instead of
     *  hunting for the newest row in the thread. The detached lane surfaces the
     *  same id as `DetachedTurnResult.messageId`. */
    assistantMessageId: string | null;
}
/** Define options to configure chat turn routes including authorization, storage, and event buffering */
export interface CreateChatTurnRoutesOptions<TContext = void> {
    /** Names the product in `deriveExecutionId` so retries land on the same
     *  substrate execution. */
    projectId: string;
    /** Authenticate + authorize the caller for a turn or a replay. The only
     *  product-supplied access step: session auth, thread/workspace access,
     *  seat/balance gates, rate limits all live here. */
    authorize(args: ChatTurnAuthorizeArgs): Promise<ChatTurnAuthorization<TContext>>;
    /** Thread/message persistence (`/chat-store`'s store or a product adapter). */
    store: ChatTurnMessageStore;
    /** Turn-event buffer (`createD1TurnEventStore(env.DB)` or `/turn-stream`'s
     *  `createDurableObjectTurnEventStore(env.TURN_STREAM_DO)` in production,
     *  `createMemoryTurnEventStore()` in tests). Wired by default — every turn
     *  is buffered and replayable. */
    turnStore: TurnEventStore;
    /** Build the turn's event stream. Sandbox lane: `streamSandboxPrompt(...)`
     *  wrapped in `createSandboxChatProducer`. Router/openai-compat lane: the
     *  product's own producer. May be async (box resolution). */
    produce(args: ChatTurnProduceArgs<TContext>): ChatTurnRouteProducer | Promise<ChatTurnRouteProducer>;
    /** Single-flight lock acquired before any side effect and released once when
     *  the turn settles (including short-circuit/throw). `/turn-stream`'s
     *  `createDurableTurnLock` is the shared DO-backed implementation. Omit →
     *  no lock. */
    turnLock?: ChatTurnLock<TContext>;
    /** Pre-turn readiness gate that can short-circuit with a product `Response`
     *  before the producer runs (the user row is already persisted). Runs after
     *  `turnLock.acquire`, before `beforeTurn`. Omit → always proceed.
     *
     *  Settled shape (#227). What a consumer may depend on:
     *  - `args.userMessageId` is RESOLVED here — a string, or `null` when the
     *    insert was suppressed with nothing to reuse. (`turnLock.acquire` is the
     *    only seam that sees it `undefined`.)
     *  - `{proceed:false}` releases the lock and returns the product's `Response`
     *    verbatim: `beforeTurn` and `produce` never run, no assistant row is
     *    written, and the user row already inserted is KEPT — a real user turn
     *    whose assistant side is the gate's own response.
     *  - `{proceed:'handoff'}` releases the route-acquired lock, returns the
     *    product's accepted `Response`, and transfers execution and lifecycle
     *    ownership to the product's durable owner. The route runs no producer
     *    or lifecycle hook.
     *  - Always returning `{proceed:true}` is supported, not a misuse: the seam
     *    doubles as the one place that runs after the user row exists and before
     *    the producer, which is where per-turn analytics and readiness
     *    precomputation belong. A gate that never gates is a valid consumer. */
    contextGate?(args: ChatTurnProduceArgs<TContext>): ChatTurnGateResult | Promise<ChatTurnGateResult>;
    /** Observe the assembled producer input and optionally augment it (rewrite
     *  the prompt / prior messages) before the producer runs. Omit → no change.
     *
     *  Settled shape (#227). BOTH return arms are contract:
     *  - a `ChatTurnInputPatch` shallow-merges over the route-assembled args, so
     *    an omitted field keeps the route's value;
     *  - `void` means "no patch" — and mutating `args.context` in place is the
     *    supported way to thread request-scoped state forward to `produce` /
     *    `lifecycle` / `onTurnComplete`, which all receive the same object.
     *
     *  A throw propagates (the turn fails with the lock released). It runs BEFORE
     *  `lifecycle.onTurnStart`, so a throw here fires no terminal lifecycle hook —
     *  the span never opened. Telemetry for a failure in this seam belongs in the
     *  seam, not in `lifecycle`. */
    beforeTurn?(args: ChatTurnProduceArgs<TContext>): ChatTurnInputPatch | void | Promise<ChatTurnInputPatch | void>;
    /** Deterministic run telemetry (start / complete / error) with identity and
     *  timing. Omit → no telemetry. */
    lifecycle?: ChatTurnLifecycle<TContext>;
    /** Keepalive injected while the producer is quiet. Omit → no keepalives. */
    heartbeat?: ChatTurnHeartbeat;
    /** Observe each event the producer emits, before the engine frames it and
     *  before any heartbeat injection (the raw sidecar-producer events, for
     *  telemetry). Never alters the stream; errors are swallowed. Distinct from
     *  `onEvent`, which sees the engine-framed stream incl. lifecycle envelopes.
     *
     *  Settled shape (#227). What a consumer may depend on:
     *  - it sees EXACTLY the producer's own events — no engine lifecycle
     *    envelopes, and no injected keepalives (`heartbeat` wraps the stream
     *    downstream of this tap, so a synthetic event never reaches a trace);
     *  - a throw is caught and logged, never surfaced: a broken telemetry sink
     *    cannot fail a turn or truncate the client's stream;
     *  - it is an OBSERVER — the return value is ignored, and the event object
     *    continues downstream. Mutating it mutates the stream; don't.
     *
     *  Takes `(event, context)` rather than one args object, matching both
     *  shipped consumers; see the module header on why it stays that way. */
    onRawEvent?(event: ChatRouteEvent, context: TContext): void | Promise<void>;
    /** Pre-persist transform of the final text (e.g. `/redact`'s `redactPII`).
     *  Live stream is never altered. */
    transformFinalText?(text: string): string | Promise<string>;
    /** Incremental persistence of the assistant row WHILE the turn streams
     *  (`./draft-persistence`), so a viewer arriving mid-run is served from
     *  durable storage instead of the streaming gateway's hot event buffer.
     *
     *  This is what lets the gateway keep that hot buffer SHORT at scale: its
     *  Redis footprint is one sorted set per session refreshed on every push, so
     *  memory grows LINEARLY with `ttl x concurrent sessions`. Stretching the
     *  TTL to cover late viewers buys memory proportional to the increase and
     *  still serves nothing past the new horizon. The buffer stays a reconnect
     *  window; durable storage — kept at most one cadence interval stale by this
     *  option — is the history tier.
     *
     *  Enabled by DEFAULT whenever `store.updateMessage` exists (every
     *  `/chat-store` consumer); a store without it keeps today's exact
     *  single-write behavior. Pass `false` to opt out, or an object to tune the
     *  cadence. Wiring it against a store that cannot patch rows throws at route
     *  construction rather than silently no-op'ing. */
    incrementalPersistence?: false | DraftPersistenceTuning;
    /** Deterministic durable row id for this turn's assistant message. Default
     *  `assistant:<executionId>` — already stable across retries because
     *  `deriveExecutionId` is. Override only if the product's message ids have a
     *  format constraint; it MUST stay deterministic per turn or a re-entered
     *  turn will duplicate its row instead of converging. */
    draftMessageId?(args: {
        identity: ChatTurnIdentity;
        executionId: string;
        threadId: string;
    }): string;
    /** Post-processing after a turn settles (billing, titles, audit). Fires with
     *  `failed:true` + `failureReason` when the turn carried a terminal error
     *  event (model 402 / rate-limit / server error) instead of a clean
     *  completion, so products skip the deduct and render an error row rather
     *  than billing an empty turn and marking it done. A turn that THROWS never
     *  reaches this hook (the engine skips it on a producer throw). Errors are
     *  swallowed by the engine — they never fail a streamed turn. */
    onTurnComplete?(input: ChatTurnCompleteInput<TContext>): Promise<void>;
    /** Per-event side channel (product broadcast). The turn-buffer tap is
     *  already wired; this runs in addition. */
    onEvent?(event: {
        type: string;
        data?: Record<string, unknown>;
    }, context: TContext): void | Promise<void>;
    /** Trace flush handed to `waitUntil` (OTLP export). */
    traceFlush?(context: TContext): Promise<void>;
    /** Compose the interaction-answer endpoints (`/interactions`). Omit when the
     *  product has no sidecar ask channel. */
    interactions?: InteractionAnswerRouteOptions;
    /** Byte budget for inline prompt parts. Default `INLINE_PARTS_MAX_BYTES`. */
    maxInlinePartBytes?: number;
    /** Per-flush coalescer for the turn buffer. Default `coalesceDeltas` (this
     *  assembly streams the client vocabulary's `{type:'text'|'reasoning',
     *  text}` lines, which it merges). A producer streaming raw
     *  `message.part.updated` events passes `coalesceChatStreamEvents`. */
    coalesceTurnEvents?: (events: unknown[]) => unknown[];
    replay?: {
        pollMs?: number;
        timeoutMs?: number;
    };
    log?: (message: string, meta?: Record<string, unknown>) => void;
}
/** Define routes to run, replay, and list running chat turns with streaming and reconnect support */
export interface ChatTurnRoutes {
    /** POST — run one turn, streaming NDJSON. First line is
     *  `{type:'turn', turnId}` (the replay handle); the rest is the engine's
     *  event protocol. Pass the platform's `waitUntil` so the turn keeps
     *  running (and buffering) after a client disconnect. */
    turn(request: Request, ctx?: ChatTurnRequestContext): Promise<Response>;
    /** GET — replay a buffered turn from `?fromSeq=` (0 = everything), then
     *  follow it live until it completes. */
    replay(request: Request, params: {
        turnId: string;
    }): Promise<Response>;
    /** GET `?threadId=` — the reconnect-discovery endpoint: the turn ids still
     *  running on a thread, so a client that reloaded mid-turn can re-attach to
     *  the live stream via {@link replay} instead of losing it. Returns `[]` when
     *  the turn store cannot enumerate running turns (`listRunning` unimplemented). */
    running(request: Request): Promise<Response>;
    /** list/answer endpoints from `/interactions`; null when not configured. */
    interactions: InteractionAnswerRoute | null;
}
/** Build chat turn routes to handle and validate incoming chat requests with optional logging */
export declare function createChatTurnRoutes<TContext = void>(options: CreateChatTurnRoutesOptions<TContext>): ChatTurnRoutes;
export {};
