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

import {
  deriveExecutionId,
  handleChatTurn,
  type ChatTurnIdentity,
  type ChatTurnProducer,
} from '@tangle-network/agent-runtime/durable'
import { mentionInputToPart, toChatMessageParts, type ChatMessagePart } from '../chat-store/parts'
import {
  assistantRowIdForTurn,
  createAssistantDraftWriter,
  rowIdOf,
  storeSupportsDraftPersistence,
  type AssistantDraftStore,
  type AssistantDraftWriter,
  type DraftPersistenceTuning,
} from './draft-persistence'
import {
  createInteractionAnswerRoute,
  type InteractionAnswerRoute,
  type InteractionAnswerRouteOptions,
} from '../interactions/route'
import {
  coalesceDeltas,
  createBufferedTurnTap,
  normalizeClientTurnId,
  replayTurnEvents,
  resolveChatTurn,
  stampReplaySeq,
  type PersistedChatMessageForTurn,
  type TurnEventStore,
} from '../stream/index'
import type { ModelFailoverAttempt } from '../model-resolution/failover'
import { parseJsonObjectBody } from '../web/index'
import {
  assertPromptPartsWithinCap,
  ChatTurnInputError,
  parseChatTurnParts,
  parseFileMentions,
  type ChatTurnFilePartInput,
  type ChatTurnPartInput,
  type ChatTurnRequestPayload,
  type FileMention,
} from './wire'

// ── seams ───────────────────────────────────────────────────────────────────

/** Usage receipt persisted onto the assistant message (the flattened
 *  `step-finish` shape `/chat-store`'s columns mirror). */
export interface ChatTurnUsage {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  costUsd?: number
}

/** What the route persists — a structural subset of `/chat-store`'s
 *  `ChatStore`, so `createChatStore(db, tables)` satisfies it directly and a
 *  product with its own persistence adapts without importing drizzle. */
export interface ChatTurnMessageStore {
  listMessages(threadId: string): Promise<Array<{
    id: string
    role: 'user' | 'assistant' | 'system' | 'tool'
    content: string
    parts?: ChatMessagePart[] | null
  }>>
  appendMessage(input: {
    /** Caller-assigned row id. Honored by `/chat-store`'s `createChatStore`;
     *  a product store free to ignore it (the writer then adopts whatever id
     *  the insert returns). Set only by incremental persistence. */
    id?: string
    threadId: string
    role: 'user' | 'assistant'
    content: string
    parts?: ChatMessagePart[]
    model?: string | null
    requestedModel?: string | null
    servedModel?: string | null
    servedProvider?: string | null
    servedSource?: string | null
    inputTokens?: number | null
    outputTokens?: number | null
    reasoningTokens?: number | null
    cacheReadTokens?: number | null
    cacheWriteTokens?: number | null
    costUsd?: number | null
  }): Promise<unknown>
  /** Patch an existing row. Its PRESENCE is what enables incremental assistant
   *  persistence — a store without it keeps today's exact single-write-on-
   *  completion behavior, which is what makes this additive. */
  updateMessage?(id: string, patch: {
    content?: string
    parts?: ChatMessagePart[]
    model?: string | null
    requestedModel?: string | null
    servedModel?: string | null
    servedProvider?: string | null
    servedSource?: string | null
    inputTokens?: number | null
    outputTokens?: number | null
    reasoningTokens?: number | null
    cacheReadTokens?: number | null
    cacheWriteTokens?: number | null
    costUsd?: number | null
  }): Promise<unknown>
  /** Remove a row. Used to retract a draft assistant row for a turn that ended
   *  producing nothing, so the empty-turn case still leaves no row at all. */
  deleteMessage?(id: string): Promise<unknown>
}

/** `ChatTurnProducer` plus the persisted projection the assembly reads after
 *  drain. `createSandboxChatProducer` returns this; a router-lane producer
 *  may omit the optional members (finalText persists as a single text part). */
export interface ChatTurnRouteProducer extends ChatTurnProducer {
  assistantParts?(): Array<Record<string, unknown>>
  /** MID-STREAM snapshot of the same projection, safe to call while the turn
   *  is running: no dangling-tool terminalization, no pending-ask settlement
   *  (see `/stream`'s `draftAssistantParts`). Read by incremental persistence.
   *  A producer that omits it still drafts — the scalar text — but persists no
   *  parts until the turn completes. */
  draftParts?(): Array<Record<string, unknown>>
  usage?(): ChatTurnUsage
  /** The model that SERVED the turn. With failover wired this is the model that
   *  actually answered, which is not necessarily the one the caller preferred —
   *  read it after the stream drains, never before. */
  model?: string
  /** Model-failover attribution, when the producer supports it. Reported onto
   *  the usage/billing receipt so a downgrade is never silent. */
  modelFailover?(): ChatTurnModelFailover
  /** Requested-versus-served attribution reported by the sandbox sidecar.
   *  `echoReceived` distinguishes a missing echo from a partial echo. */
  modelAttribution?(): ChatTurnModelAttribution
}

/** Which model served, and what it took to get there. */
export interface ChatTurnModelFailover {
  /** The model that served the turn. */
  model?: string
  /** Every model tried, in order, with the reason each was abandoned. */
  attempts: ModelFailoverAttempt[]
  /** True when the preferred model did not serve. */
  usedFallback: boolean
}

/** Requested and effective model attribution for one sandbox turn. */
export interface ChatTurnModelAttribution {
  /** The model explicitly requested by the caller, before shell failover. */
  requestedModel?: string
  /** The model the downstream sandbox reports actually served the turn. */
  servedModel?: string
  /** The provider that served the turn, when echoed by the sandbox. */
  servedProvider?: string
  /** How the sandbox selected the served model. */
  servedSource?: 'request' | 'environment' | 'profile'
  /** True when a structurally valid effective-backend echo was observed. */
  echoReceived: boolean
}

/** Resolve authorization status and context for a chat turn including tenant and user identification */
export type ChatTurnAuthorization<TContext> =
  | {
      ok: true
      tenantId: string
      userId: string
      context: TContext
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
      insertUserMessage?: boolean
    }
  | { ok: false; response: Response }

/** Define arguments required to authorize a chat turn based on intent and request details */
export interface ChatTurnAuthorizeArgs {
  request: Request
  intent: 'turn' | 'replay' | 'running'
  /** Parsed, validated POST body (turn intent only). */
  body?: ChatTurnRequestPayload
  /** The buffered turn id being replayed (replay intent only). */
  turnId?: string
  /** The thread whose running turns are being discovered (running intent only). */
  threadId?: string
}

/** Trusted per-turn limits supplied by a server adapter, never by the body. */
export interface ChatTurnExecutionLimits {
  maxInputTokens?: number
  maxOutputTokens?: number
  maxReasoningTokens?: number
  maxToolTokens?: number
  maxToolCalls?: number
  maxProviderCostUsd?: number
}

/** Server-only context for one turn request. */
export interface ChatTurnRequestContext {
  waitUntil?(p: Promise<unknown>): void
  /** Abort this turn when its HTTP client disconnects. Browser callers omit it. */
  cancelOnDisconnect?: boolean
  /** Limits already authenticated by the server adapter. */
  executionLimits?: ChatTurnExecutionLimits
}

/** Define the arguments required to produce a chat turn with context and messaging details */
export interface ChatTurnProduceArgs<TContext> {
  request: Request
  body: ChatTurnRequestPayload
  identity: ChatTurnIdentity
  context: TContext
  /** The message to send: plain text, or parts when the client attached
   *  files (a text part is prepended from `content` when present). */
  prompt: string | ChatTurnPartInput[]
  /** Stable id for cross-process reconnect (`deriveExecutionId`). */
  executionId: string
  /** The turn-buffer id announced to the client for replay. */
  turnStreamId: string
  priorMessages: PersistedChatMessageForTurn[]
  /** Server-authenticated limits for this turn. Never copied from the body. */
  executionLimits?: ChatTurnExecutionLimits
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
  userMessageId?: string | null
}

/** One event as it crosses the route: the producer's own vocabulary, or an
 *  injected keepalive. Same shape the engine forwards verbatim.
 *
 *  Public because it IS the vocabulary of two seams — `onRawEvent`'s parameter
 *  and `heartbeat.event`'s return. Exported so a product can declare a
 *  standalone handler (`function onRawEvent(e: ChatRouteEvent, ctx: T)`) rather
 *  than depending on contextual typing from an inline object literal. */
export type ChatRouteEvent = { type: string; data?: Record<string, unknown> }

/** Best-effort human-readable cause from a terminal `error` /
 *  `session.run.failed` event's `data`. */
function failureReasonOf(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined
  const message = data.message ?? data.error ?? data.reason
  if (typeof message === 'string' && message.length > 0) return message
  return undefined
}

/** Keepalive emitted while the producer is quiet (long tool calls, first-token
 *  wait) so client watchdogs stay re-armed. One is emitted each time
 *  `intervalMs` elapses with no producer event; the window resets on every real
 *  event, so a chatty producer never triggers one. The product owns the event
 *  shape (`type` + `data`). Omit → no keepalives (today's behavior). */
export interface ChatTurnHeartbeat {
  intervalMs: number
  event(info: { elapsedMs: number; tick: number }): ChatRouteEvent
}

/** Patch a `beforeTurn` hook returns to augment the producer's input. Omitted
 *  fields keep the route-assembled value; the product's `produce` still owns
 *  the system prompt. */
export interface ChatTurnInputPatch {
  prompt?: string | ChatTurnPartInput[]
  priorMessages?: PersistedChatMessageForTurn[]
}

/** Pre-turn readiness verdict — proceed, or short-circuit with the product's
 *  own `Response` (e.g. a canned assistant reply asking for missing context).
 *  Distinct from `authorize`: this gates domain readiness, not access. */
export type ChatTurnGateResult =
  | { proceed: true }
  | { proceed: false; response: Response }

/** Single-flight lock verdict — acquired (with an opaque handle passed back to
 *  `release`), or already held (short-circuit with the product's 409-style
 *  `Response`). */
export type ChatTurnLockResult =
  | { acquired: true; handle?: unknown }
  | { acquired: false; response: Response }

/** Async acquire/release wrapped around the turn. `acquire` runs before any
 *  side effect; `release` runs once when the turn settles — including on a
 *  short-circuit or a throw. */
export interface ChatTurnLock<TContext> {
  acquire(args: ChatTurnProduceArgs<TContext>): ChatTurnLockResult | Promise<ChatTurnLockResult>
  release(handle: unknown): void | Promise<void>
}

interface ChatTurnLifecycleBase<TContext> {
  identity: ChatTurnIdentity
  executionId: string
  turnStreamId: string
  context: TContext
}
/** Define lifecycle start event with context and timestamp for a chat turn */
export interface ChatTurnLifecycleStart<TContext> extends ChatTurnLifecycleBase<TContext> {
  startedAt: number
}
/** Define the structure representing the completion state of a chat turn lifecycle with usage data */
export interface ChatTurnLifecycleComplete<TContext> extends ChatTurnLifecycleBase<TContext> {
  finalText: string
  usage: ChatTurnUsage
  durationMs: number
  /** The model that SERVED the turn — the fallback's id when failover moved it.
   *  `usage` is that model's, so telemetry that splits cost or quality by model
   *  must key on this and not on the requested one. */
  model?: string
  /** Requested-versus-served attribution. A difference is detectable from
   *  this receipt and from the persisted assistant row independently. */
  requestedModel?: string
  servedModel?: string
  servedProvider?: string
  servedSource?: 'request' | 'environment' | 'profile'
  /** Attribution for a downgrade: which models were tried and why each failed.
   *  `undefined` when the producer reports no failover support. */
  modelFailover?: ChatTurnModelFailover
  /** The durable `role:'assistant'` row this turn wrote, or `null` when it
   *  wrote none (an empty turn leaves no row — a draft started mid-stream is
   *  retracted). The detached lane surfaces the same id as
   *  `DetachedTurnResult.messageId`; one contract, two lanes. */
  assistantMessageId: string | null
  /** Set when `contextGate` answered this turn and the producer never ran.
   *
   *  Present so telemetry can tell "the model produced nothing" apart from "the
   *  model was never asked" — they look identical here (`finalText: ''`,
   *  empty `usage`) and mean opposite things. A gated turn writes no assistant
   *  row, so `assistantMessageId` is `null`, and the billing/persistence
   *  `onTurnComplete` is deliberately NOT fired for it. */
  gated?: true
}
/** Represent an error occurring during a chat turn lifecycle with context and duration information */
export interface ChatTurnLifecycleError<TContext> extends ChatTurnLifecycleBase<TContext> {
  error: unknown
  durationMs: number
}

/** Deterministic run telemetry: `onTurnStart` fires before the producer runs;
 *  exactly one of `onTurnComplete` / `onTurnError` fires after the turn
 *  settles, always after `onTurnStart`. Failure is derived from the turn's own
 *  `error` / `session.run.failed` events (or a drain throw), not the engine's
 *  lifecycle envelope. Hook errors are swallowed — telemetry never fails a
 *  turn. */
export interface ChatTurnLifecycle<TContext> {
  onTurnStart?(info: ChatTurnLifecycleStart<TContext>): void | Promise<void>
  onTurnComplete?(info: ChatTurnLifecycleComplete<TContext>): void | Promise<void>
  onTurnError?(info: ChatTurnLifecycleError<TContext>): void | Promise<void>
}

/** What a settled turn reports to `onTurnComplete` — the product's
 *  post-processing seam (billing, titles, audit). */
export interface ChatTurnCompleteInput<TContext> {
  identity: ChatTurnIdentity
  finalText: string
  context: TContext
  failed: boolean
  failureReason?: string
  /** The model that SERVED this turn. With failover wired it may differ from
   *  the requested one, so a product that bills or scores per model MUST read
   *  it here rather than assuming the model it asked for. */
  model?: string
  /** Requested-versus-served attribution. A difference is detectable from
   *  this receipt and from the persisted assistant row independently. */
  requestedModel?: string
  servedModel?: string
  servedProvider?: string
  servedSource?: 'request' | 'environment' | 'profile'
  /** Present when the producer supports failover: the full attempt trail, and
   *  `usedFallback` — the flag that makes a silent downgrade impossible. */
  modelFailover?: ChatTurnModelFailover
  /** The durable `role:'assistant'` row this turn wrote, or `null` when it
   *  wrote none (an empty turn leaves no row).
   *
   *  Populated even when `failed` is true — a terminal error event still
   *  persists whatever partial answer arrived, and that pairing is exactly
   *  what lets a product render an error row against a REAL message instead of
   *  hunting for the newest row in the thread. The detached lane surfaces the
   *  same id as `DetachedTurnResult.messageId`. */
  assistantMessageId: string | null
}

/** Define options to configure chat turn routes including authorization, storage, and event buffering */
export interface CreateChatTurnRoutesOptions<TContext = void> {
  /** Names the product in `deriveExecutionId` so retries land on the same
   *  substrate execution. */
  projectId: string
  /** Authenticate + authorize the caller for a turn or a replay. The only
   *  product-supplied access step: session auth, thread/workspace access,
   *  seat/balance gates, rate limits all live here. */
  authorize(args: ChatTurnAuthorizeArgs): Promise<ChatTurnAuthorization<TContext>>
  /** Thread/message persistence (`/chat-store`'s store or a product adapter). */
  store: ChatTurnMessageStore
  /** Turn-event buffer (`createD1TurnEventStore(env.DB)` or `/turn-stream`'s
   *  `createDurableObjectTurnEventStore(env.TURN_STREAM_DO)` in production,
   *  `createMemoryTurnEventStore()` in tests). Wired by default — every turn
   *  is buffered and replayable. */
  turnStore: TurnEventStore
  /** Build the turn's event stream. Sandbox lane: `streamSandboxPrompt(...)`
   *  wrapped in `createSandboxChatProducer`. Router/openai-compat lane: the
   *  product's own producer. May be async (box resolution). */
  produce(args: ChatTurnProduceArgs<TContext>): ChatTurnRouteProducer | Promise<ChatTurnRouteProducer>
  /** Single-flight lock acquired before any side effect and released once when
   *  the turn settles (including short-circuit/throw). `/turn-stream`'s
   *  `createDurableTurnLock` is the shared DO-backed implementation. Omit →
   *  no lock. */
  turnLock?: ChatTurnLock<TContext>
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
   *  - Always returning `{proceed:true}` is supported, not a misuse: the seam
   *    doubles as the one place that runs after the user row exists and before
   *    the producer, which is where per-turn analytics and readiness
   *    precomputation belong. A gate that never gates is a valid consumer. */
  contextGate?(args: ChatTurnProduceArgs<TContext>): ChatTurnGateResult | Promise<ChatTurnGateResult>
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
  beforeTurn?(args: ChatTurnProduceArgs<TContext>): ChatTurnInputPatch | void | Promise<ChatTurnInputPatch | void>
  /** Deterministic run telemetry (start / complete / error) with identity and
   *  timing. Omit → no telemetry. */
  lifecycle?: ChatTurnLifecycle<TContext>
  /** Keepalive injected while the producer is quiet. Omit → no keepalives. */
  heartbeat?: ChatTurnHeartbeat
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
  onRawEvent?(event: ChatRouteEvent, context: TContext): void | Promise<void>
  /** Pre-persist transform of the final text (e.g. `/redact`'s `redactPII`).
   *  Live stream is never altered. */
  transformFinalText?(text: string): string | Promise<string>
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
  incrementalPersistence?: false | DraftPersistenceTuning
  /** Deterministic durable row id for this turn's assistant message. Default
   *  `assistant:<executionId>` — already stable across retries because
   *  `deriveExecutionId` is. Override only if the product's message ids have a
   *  format constraint; it MUST stay deterministic per turn or a re-entered
   *  turn will duplicate its row instead of converging. */
  draftMessageId?(args: { identity: ChatTurnIdentity; executionId: string; threadId: string }): string
  /** Post-processing after a turn settles (billing, titles, audit). Fires with
   *  `failed:true` + `failureReason` when the turn carried a terminal error
   *  event (model 402 / rate-limit / server error) instead of a clean
   *  completion, so products skip the deduct and render an error row rather
   *  than billing an empty turn and marking it done. A turn that THROWS never
   *  reaches this hook (the engine skips it on a producer throw). Errors are
   *  swallowed by the engine — they never fail a streamed turn. */
  onTurnComplete?(input: ChatTurnCompleteInput<TContext>): Promise<void>
  /** Per-event side channel (product broadcast). The turn-buffer tap is
   *  already wired; this runs in addition. */
  onEvent?(event: { type: string; data?: Record<string, unknown> }, context: TContext): void | Promise<void>
  /** Trace flush handed to `waitUntil` (OTLP export). */
  traceFlush?(context: TContext): Promise<void>
  /** Compose the interaction-answer endpoints (`/interactions`). Omit when the
   *  product has no sidecar ask channel. */
  interactions?: InteractionAnswerRouteOptions
  /** Byte budget for inline prompt parts. Default `INLINE_PARTS_MAX_BYTES`. */
  maxInlinePartBytes?: number
  /** Per-flush coalescer for the turn buffer. Default `coalesceDeltas` (this
   *  assembly streams the client vocabulary's `{type:'text'|'reasoning',
   *  text}` lines, which it merges). A producer streaming raw
   *  `message.part.updated` events passes `coalesceChatStreamEvents`. */
  coalesceTurnEvents?: (events: unknown[]) => unknown[]
  replay?: { pollMs?: number; timeoutMs?: number }
  log?: (message: string, meta?: Record<string, unknown>) => void
}

/** Define routes to run, replay, and list running chat turns with streaming and reconnect support */
export interface ChatTurnRoutes {
  /** POST — run one turn, streaming NDJSON. First line is
   *  `{type:'turn', turnId}` (the replay handle); the rest is the engine's
   *  event protocol. Pass the platform's `waitUntil` so the turn keeps
   *  running (and buffering) after a client disconnect. */
  turn(request: Request, ctx?: ChatTurnRequestContext): Promise<Response>
  /** GET — replay a buffered turn from `?fromSeq=` (0 = everything), then
   *  follow it live until it completes. */
  replay(request: Request, params: { turnId: string }): Promise<Response>
  /** GET `?threadId=` — the reconnect-discovery endpoint: the turn ids still
   *  running on a thread, so a client that reloaded mid-turn can re-attach to
   *  the live stream via {@link replay} instead of losing it. Returns `[]` when
   *  the turn store cannot enumerate running turns (`listRunning` unimplemented). */
  running(request: Request): Promise<Response>
  /** list/answer endpoints from `/interactions`; null when not configured. */
  interactions: InteractionAnswerRoute | null
}

// ── body validation ────────────────────────────────────────────────────────

function errorResponse(err: ChatTurnInputError): Response {
  return Response.json({ code: err.code, error: err.message }, { status: err.status })
}

interface ParsedTurnBody {
  payload: ChatTurnRequestPayload
  content: string
  fileParts: ChatTurnFilePartInput[]
  mentions: FileMention[]
  turnId: string | undefined
}

function validateTurnBody(body: Record<string, unknown>, maxInlinePartBytes: number | undefined): ParsedTurnBody {
  const threadId = typeof body.threadId === 'string' ? body.threadId.trim() : ''
  if (!threadId) throw new ChatTurnInputError('Missing threadId')
  const rawContent = body.content ?? body.message ?? ''
  if (typeof rawContent !== 'string') throw new ChatTurnInputError('content must be a string')
  const content = rawContent.trim()
  const fileParts = parseChatTurnParts(body.parts)
  // Path references, not bytes — validated for traversal/charset/count, never
  // counted against the inline-parts byte budget below.
  const mentions = parseFileMentions(body.mentions)
  // A mention is a turn's whole payload often enough to count: "@chart.png"
  // with no prose is a real ask, and the pointer block the mentions produce is
  // prompt content the model reads.
  const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0
  if (!content && fileParts.length === 0 && mentions.length === 0 && !hasAttachments) {
    throw new ChatTurnInputError('Missing content (send text, parts, mentions, attachments, or any combination)')
  }
  assertPromptPartsWithinCap(fileParts, maxInlinePartBytes)
  let turnId: string | undefined
  try {
    turnId = normalizeClientTurnId(body.turnId)
  } catch (err) {
    throw new ChatTurnInputError(err instanceof Error ? err.message : 'Invalid turnId')
  }
  return {
    // The VALIDATED, deduped mention list replaces the raw one on the payload,
    // so every downstream seam (`authorize`, `contextGate`, `beforeTurn`,
    // `produce`) reads checked paths and never the request's own.
    payload: { ...body, threadId, content, mentions } as ChatTurnRequestPayload,
    content,
    fileParts,
    mentions,
    turnId,
  }
}

/** File parts persist onto the user message verbatim — the wire shape is the
 *  persisted `ChatFilePart`/`ChatImagePart` vocabulary already. Mentions get
 *  the one mapping step their own vocabulary needs. The typed projection is
 *  `/chat-store`'s (same boundary as the assistant hop).
 *
 *  Mentions persist as parts rather than being folded into the prompt because
 *  the prompt is not readable back: a retry rebuilds the turn from the stored
 *  row, and a transcript draws its pills from it. Turning them INTO prompt
 *  text stays the product's job — only the product knows how to resolve a
 *  workspace-relative path to an in-box one (`fileMentionsToParts`'
 *  `resolvePath` seam), so the route never dispatches them itself. */
function userPartsWithFiles(
  userParts: Array<Record<string, unknown>>,
  fileParts: ChatTurnFilePartInput[],
  mentions: FileMention[],
): ChatMessagePart[] {
  return toChatMessageParts([
    ...userParts,
    ...fileParts.map((part) => ({ ...part })),
    ...mentions.map((mention) => ({ ...mentionInputToPart(mention) })),
  ])
}

// ── producer-stream wrappers (heartbeat + raw tap) ───────────────────────────

/** Fire `onRawEvent` for each producer event, before the engine frames it.
 *  Best-effort — a telemetry throw is logged, never propagated. */
async function* tapRawEvents(
  source: AsyncIterable<ChatRouteEvent>,
  onRawEvent: (event: ChatRouteEvent) => void | Promise<void>,
  log: (message: string, meta?: Record<string, unknown>) => void,
): AsyncGenerator<ChatRouteEvent, void, unknown> {
  for await (const event of source) {
    try {
      await onRawEvent(event)
    } catch (err) {
      log('[chat-routes] onRawEvent failed', { error: err instanceof Error ? err.message : String(err) })
    }
    yield event
  }
}

/** Inject a keepalive whenever `intervalMs` elapses with no source event. The
 *  silent window (elapsed + tick) resets on every real event, so a producer
 *  that keeps emitting never triggers a heartbeat. Closes the source on early
 *  return, matching a `for await` over it. */
async function* withStreamHeartbeat(
  source: AsyncIterable<ChatRouteEvent>,
  intervalMs: number,
  makeEvent: (info: { elapsedMs: number; tick: number }) => ChatRouteEvent,
): AsyncGenerator<ChatRouteEvent, void, unknown> {
  const iterator = source[Symbol.asyncIterator]()
  try {
    let pending = iterator.next()
    let windowStart = Date.now()
    let tick = 0
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined
      let winner: 'event' | 'heartbeat'
      try {
        const heartbeat = new Promise<'heartbeat'>((resolve) => {
          timer = setTimeout(() => resolve('heartbeat'), intervalMs)
        })
        winner = await Promise.race([pending.then(() => 'event' as const), heartbeat])
      } finally {
        // Clear the pending timer on EVERY exit — including a `pending`
        // rejection — so a rejected source never orphans a setTimeout that
        // keeps the runtime alive for up to `intervalMs`.
        if (timer !== undefined) clearTimeout(timer)
      }
      if (winner === 'heartbeat') {
        tick += 1
        yield makeEvent({ elapsedMs: Date.now() - windowStart, tick })
        continue
      }
      const result = await pending
      if (result.done) return
      yield result.value
      pending = iterator.next()
      windowStart = Date.now()
      tick = 0
    }
  } finally {
    await iterator.return?.()
  }
}

// ── the factory ────────────────────────────────────────────────────────────

/** Build chat turn routes to handle and validate incoming chat requests with optional logging */
export function createChatTurnRoutes<TContext = void>(
  options: CreateChatTurnRoutesOptions<TContext>,
): ChatTurnRoutes {
  const log = options.log ?? ((message, meta) => console.error(message, meta ?? ''))

  // Incremental persistence is on whenever the store can patch a row. An
  // EXPLICIT opt-in against a store that cannot is a wiring bug, so it fails
  // here — at construction — instead of silently degrading every turn.
  const draftStore: AssistantDraftStore = options.store
  if (options.incrementalPersistence && !storeSupportsDraftPersistence(draftStore)) {
    throw new Error(
      'incrementalPersistence requires a store with updateMessage() — `/chat-store`\'s createChatStore has it; a product store must implement it or omit the option',
    )
  }
  const draftTuning: DraftPersistenceTuning | null =
    options.incrementalPersistence === false || !storeSupportsDraftPersistence(draftStore)
      ? null
      : (options.incrementalPersistence ?? {})

  async function turn(request: Request, ctx?: ChatTurnRequestContext): Promise<Response> {
    const [rawBody, badBody] = await parseJsonObjectBody(request)
    if (badBody) return badBody

    let parsed: ParsedTurnBody
    try {
      parsed = validateTurnBody(rawBody, options.maxInlinePartBytes)
    } catch (err) {
      if (err instanceof ChatTurnInputError) return errorResponse(err)
      throw err
    }
    const { payload, content, fileParts, mentions, turnId } = parsed

    const auth = await options.authorize({ request, intent: 'turn', body: payload })
    if (!auth.ok) return auth.response
    const { tenantId, userId, context } = auth

    // Turn identity: reuse the just-persisted user row on a retry (same
    // turnId or identical trailing content) instead of double-inserting.
    const existingMessages = (await options.store.listMessages(payload.threadId)).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      parts: (m.parts ?? null) as PersistedChatMessageForTurn['parts'],
    }))
    // An assistant row already trailing the thread is either this turn's
    // in-flight draft (retry — walk past it) or a settled answer (a genuine
    // repeat — new turn). The turn buffer's running index is the discriminator;
    // it is only consulted in the one case that can be ambiguous, so the common
    // path costs nothing.
    let hasRunningTurn = false
    if (draftTuning && existingMessages.at(-1)?.role === 'assistant') {
      try {
        hasRunningTurn = ((await options.turnStore.listRunning?.(payload.threadId)) ?? []).length > 0
      } catch (err) {
        log('[chat-routes] listRunning probe failed; treating the thread as idle', {
          threadId: payload.threadId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    const chatTurn = resolveChatTurn({ existingMessages, userContent: content, turnId, hasRunningTurn })

    const identity: ChatTurnIdentity = {
      tenantId,
      sessionId: payload.threadId,
      userId,
      turnIndex: chatTurn.turnIndex,
    }
    const executionId = deriveExecutionId({
      projectId: options.projectId,
      sessionId: payload.threadId,
      turnIndex: chatTurn.turnIndex,
    })
    const turnStreamId = crypto.randomUUID()

    const prompt: string | ChatTurnPartInput[] =
      fileParts.length === 0
        ? content
        : content
          ? [{ type: 'text', text: content }, ...fileParts]
          : [...fileParts]

    // The producer input every pre-turn seam reads. Replaced — never mutated
    // in place — as later steps resolve more of it (`userMessageId` after the
    // insert, `beforeTurn`'s patch after that), so a seam that captured the
    // object never sees it change underneath. `produce` reads the last
    // version because the engine defers its first pull.
    let produceArgs: ChatTurnProduceArgs<TContext> = {
      request,
      body: payload,
      identity,
      context,
      prompt,
      executionId,
      turnStreamId,
      priorMessages: chatTurn.priorMessages,
      ...(ctx?.executionLimits ? { executionLimits: ctx.executionLimits } : {}),
    }

    // Single-flight lock: acquire before any side effect. `release` runs
    // exactly once — in the drain's `finally` on a normal turn, or right here
    // on a short-circuit / throw.
    let lockAcquired = false
    let lockHandle: unknown
    let lockReleased = false
    const releaseLock = async (): Promise<void> => {
      if (!lockAcquired || lockReleased) return
      lockReleased = true
      try {
        await options.turnLock!.release(lockHandle)
      } catch (err) {
        log('[chat-routes] turnLock.release failed', {
          turnId: turnStreamId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (options.turnLock) {
      const acquired = await options.turnLock.acquire(produceArgs)
      if (!acquired.acquired) return acquired.response
      lockAcquired = true
      lockHandle = acquired.handle
    }

    // Turn state, hoisted so the pre-stream `catch` can settle the lifecycle
    // (fire `onTurnError`, close the span) even when a seam throws
    // synchronously before the drain — the drain would otherwise be the only
    // path that runs the terminal hook.
    let producer: ChatTurnRouteProducer | undefined
    let draft: AssistantDraftWriter | undefined
    // Set once persistence settles; `undefined` means it never ran.
    let assistantMessageId: string | null | undefined
    /** The assistant row this turn ended with. Falls back to the draft writer
     *  so a turn whose producer THREW — skipping `persistAssistantMessage`
     *  entirely — still names the partial row it left behind. */
    const assistantRowId = (): string | null => assistantMessageId ?? draft?.rowId() ?? null
    let runFailed = false
    // Data of the event that marked the run failed — handed to `onTurnError`
    // when no drain throw supplies a richer cause.
    let lastFailureData: Record<string, unknown> | undefined
    let turnStartedAtMs = 0
    let turnStarted = false
    let lifecycleSettled = false
    // Set when `contextGate` answered the turn without running the producer.
    let gatedTurn = false

    // Exactly one terminal lifecycle hook, after the turn settles (idempotent).
    // Failure is this route's own verdict (`runFailed` from error/failed
    // events, or a drain/sync throw), not the engine's envelope.
    const fireTerminalLifecycle = async (failed: boolean, terminalError: unknown): Promise<void> => {
      if (lifecycleSettled) return
      lifecycleSettled = true
      const lifecycle = options.lifecycle
      if (!lifecycle) return
      const durationMs = Date.now() - turnStartedAtMs
      try {
        if (failed) {
          await lifecycle.onTurnError?.({
            identity, executionId, turnStreamId, context, durationMs,
            error: terminalError ?? lastFailureData ?? new Error('chat turn failed'),
          })
        } else {
          const failoverInfo = producer?.modelFailover?.()
          const attribution = producer?.modelAttribution?.()
          await lifecycle.onTurnComplete?.({
            identity, executionId, turnStreamId, context, durationMs,
            finalText: producer?.finalText() ?? '',
            usage: producer?.usage?.() ?? {},
            assistantMessageId: assistantRowId(),
            ...(gatedTurn ? { gated: true } : {}),
            ...(producer?.model ? { model: producer.model } : {}),
            ...(attribution?.requestedModel ? { requestedModel: attribution.requestedModel } : {}),
            ...(attribution?.servedModel ? { servedModel: attribution.servedModel } : {}),
            ...(attribution?.servedProvider ? { servedProvider: attribution.servedProvider } : {}),
            ...(attribution?.servedSource ? { servedSource: attribution.servedSource } : {}),
            ...(failoverInfo ? { modelFailover: failoverInfo } : {}),
          })
        }
      } catch (err) {
        log('[chat-routes] lifecycle terminal hook failed', {
          turnId: turnStreamId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    try {
      // The product (via `authorize`) may suppress the user-row insert for a
      // dispatched/synthetic turn. AND-composition: it can only subtract, never
      // resurrect a turn the engine already deduped as a retry.
      const insertUserMessage = chatTurn.shouldInsertUserMessage && (auth.insertUserMessage ?? true)
      // Name the row this turn is anchored to. Insert and reuse are mutually
      // exclusive (`shouldInsertUserMessage` is false exactly when a reusable
      // row was found), so one source or the other — never both, never a
      // guess. Products used to re-derive this by decorating the store and
      // falling back to the newest row, which mis-resolves under sub-second
      // same-thread turns.
      let userMessageId: string | null = chatTurn.reusedUserMessageId ?? null
      if (insertUserMessage) {
        userMessageId = rowIdOf(
          await options.store.appendMessage({
            threadId: payload.threadId,
            role: 'user',
            content,
            parts: userPartsWithFiles(chatTurn.userParts, fileParts, mentions),
          }),
        )
      }
      produceArgs = { ...produceArgs, userMessageId }

      // Domain-readiness gate: may short-circuit with the product's own
      // response before the producer runs. The user row above is kept (a real
      // user turn); the gate's response is the assistant side of it.
      if (options.contextGate) {
        const gate = await options.contextGate(produceArgs)
        if (!gate.proceed) {
          await releaseLock()
          // A gated turn is still a TURN, and until now it was the one answer
          // path that fired no lifecycle hook at all — `turnStarted` is set
          // further down, so an early return here left telemetry with no record
          // that anything happened. A product whose gate answers everything
          // therefore looks IDLE rather than broken, which is indistinguishable
          // from healthy on every dashboard.
          //
          // Only the LIFECYCLE hooks fire (telemetry, errors swallowed); the
          // billing/persistence `onTurnComplete` deliberately does not, because
          // no model ran and no assistant row was written. `gated` marks the
          // completion so a consumer counts it without mistaking it for a model
          // turn that produced nothing.
          gatedTurn = true
          turnStartedAtMs = Date.now()
          if (options.lifecycle?.onTurnStart) {
            try {
              await options.lifecycle.onTurnStart({
                identity, executionId, turnStreamId, context, startedAt: turnStartedAtMs,
              })
            } catch (err) {
              log('[chat-routes] lifecycle.onTurnStart failed', {
                turnId: turnStreamId,
                error: err instanceof Error ? err.message : String(err),
              })
            }
          }
          await fireTerminalLifecycle(false, undefined)
          return gate.response
        }
      }

      // Observe + optionally augment the assembled producer input.
      if (options.beforeTurn) {
        const patch = await options.beforeTurn(produceArgs)
        if (patch) produceArgs = { ...produceArgs, ...patch }
      }

      // Durability tap: every engine event buffers (coalesced) so a dropped
      // client replays the tail. Live delivery rides the Response body, not the
      // tap, so `write` is intentionally absent.
      const tap = createBufferedTurnTap({
        store: options.turnStore,
        turnId: turnStreamId,
        scopeId: payload.threadId,
        coalesce: options.coalesceTurnEvents ?? coalesceDeltas,
      })
      const turnMarker = { type: 'turn', turnId: turnStreamId }
      await tap.onEvent(turnMarker)

      // Durable projection: the turn buffer above serves LIVE reconnect; this
      // keeps the persisted transcript at most one cadence interval behind, so
      // a viewer arriving after the buffer's (deliberately short) hot window
      // reads the in-flight answer from storage instead of an empty thread.
      // Row identity is the turn's own `executionId`, so a re-entered turn
      // patches the row a previous attempt started instead of duplicating it.
      if (draftTuning) {
        draft = createAssistantDraftWriter({
          ...draftTuning,
          store: draftStore,
          threadId: payload.threadId,
          messageId: options.draftMessageId
            ? options.draftMessageId({ identity, executionId, threadId: payload.threadId })
            : assistantRowIdForTurn(executionId),
          snapshot: () => {
            if (!producer) return null
            return {
              content: producer.finalText(),
              ...(producer.draftParts ? { parts: producer.draftParts() } : {}),
              ...(producer.usage ? { usage: producer.usage() } : {}),
              ...(producer.model ? { model: producer.model } : {}),
            }
          },
          ...(options.transformFinalText ? { transformText: options.transformFinalText } : {}),
          log,
        })
      }

      turnStartedAtMs = Date.now()
      turnStarted = true
      if (options.lifecycle?.onTurnStart) {
        try {
          await options.lifecycle.onTurnStart({
            identity, executionId, turnStreamId, context, startedAt: turnStartedAtMs,
          })
        } catch (err) {
          log('[chat-routes] lifecycle.onTurnStart failed', {
            turnId: turnStreamId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      const result = handleChatTurn({
        identity,
        waitUntil: ctx?.waitUntil,
        log,
        hooks: {
          // The engine wants a synchronous producer; box resolution is async —
          // defer it into the generator's first pull.
          produce: () => ({
            stream: (async function* () {
              producer = await options.produce(produceArgs)
              let source: AsyncIterable<ChatRouteEvent> = producer.stream
              if (ctx?.cancelOnDisconnect) {
                source = abortOnSignal(source, request.signal)
              }
              if (options.onRawEvent) {
                source = tapRawEvents(source, (event) => options.onRawEvent!(event, context), log)
              }
              if (options.heartbeat) {
                source = withStreamHeartbeat(source, options.heartbeat.intervalMs, options.heartbeat.event)
              }
              for await (const event of source) yield event
            })(),
            finalText: () => producer?.finalText() ?? '',
          }),
          onEvent: async (event) => {
            if (event.type === 'session.run.failed' || event.type === 'error') {
              runFailed = true
              lastFailureData = event.data
            }
            await tap.onEvent(event)
            // Synchronous bookkeeping; the write it may start is fire-and-
            // forget, so store latency never back-pressures the live stream.
            draft?.notify(event)
            if (options.onEvent) await options.onEvent(event, context)
          },
          ...(options.transformFinalText ? { transformFinalText: options.transformFinalText } : {}),
          persistAssistantMessage: async ({ finalText }) => {
            if (ctx?.cancelOnDisconnect && request.signal.aborted) {
              await draft?.discard()
              assistantMessageId = null
              return
            }
            // The typed boundary: stream-normalizer records → stored vocabulary
            // (validating projection owned by /chat-store — no cast here). The
            // scalar `finalText` arrives already transformed by the engine; the
            // producer's text PARTS are raw, so the same transform must run over
            // each text segment before persistence or a redaction (legal PII)
            // leaks at rest through message.parts.
            const rawParts = producer?.assistantParts ? producer.assistantParts() : undefined
            const projected =
              rawParts && options.transformFinalText
                ? await Promise.all(
                    rawParts.map(async (part) =>
                      String((part as { type?: unknown }).type ?? '') === 'text'
                        ? { ...part, text: await options.transformFinalText!(String((part as { text?: unknown }).text ?? '')) }
                        : part,
                    ),
                  )
                : rawParts
            const parts = projected ? toChatMessageParts(projected) : undefined
            if (!finalText.trim() && (!parts || parts.length === 0)) {
              // Empty turn: today this leaves no assistant row at all, so a
              // draft row started earlier is retracted, not left behind.
              await draft?.discard()
              // Read the writer rather than assuming `null`: `discard` is a
              // no-op on a store without `deleteMessage` (drafting needs only
              // `updateMessage`), and there the draft row genuinely survives.
              assistantMessageId = draft?.rowId() ?? null
              return
            }
            const usage = producer?.usage?.() ?? {}
            const attribution = producer?.modelAttribution?.()
            const values = {
              content: finalText,
              ...(parts && parts.length > 0 ? { parts } : {}),
              ...(producer?.model ? { model: producer.model } : {}),
              ...(attribution?.requestedModel ? { requestedModel: attribution.requestedModel } : {}),
              ...(attribution?.servedModel ? { servedModel: attribution.servedModel } : {}),
              ...(attribution?.servedProvider ? { servedProvider: attribution.servedProvider } : {}),
              ...(attribution?.servedSource ? { servedSource: attribution.servedSource } : {}),
              ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
              ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
              ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
              ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
              ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
              ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
            }
            // ONE row per turn either way. With drafting, `finalize` settles
            // any in-flight draft and then insert-or-patches the same
            // deterministic id — so the row this turn ends with is identical to
            // the one the single-write path produces. Without it, today's
            // append is untouched.
            if (draft) {
              await draft.finalize(values)
              assistantMessageId = draft.rowId() ?? null
              return
            }
            assistantMessageId = rowIdOf(
              await options.store.appendMessage({
                threadId: payload.threadId,
                role: 'assistant',
                ...values,
              }),
            )
          },
          ...(options.onTurnComplete
            ? {
                // Wired into the engine's completion hook, which fires only when
                // the stream ended without throwing. A terminal error EVENT
                // (not a throw) still lands here — so surface `runFailed` so the
                // product skips billing an errored turn instead of marking it
                // complete with empty text.
                onTurnComplete: ({ identity: turnIdentity, finalText }: { identity: ChatTurnIdentity; finalText: string }) => {
                  // Read AFTER the drain, so the model reported to billing is
                  // the one that actually served — a fallback included.
                  const failoverInfo = producer?.modelFailover?.()
                  const attribution = producer?.modelAttribution?.()
                  return options.onTurnComplete!({
                    identity: turnIdentity,
                    finalText,
                    context,
                    failed: runFailed,
                    assistantMessageId: assistantRowId(),
                    ...(runFailed ? { failureReason: failureReasonOf(lastFailureData) } : {}),
                    ...(producer?.model ? { model: producer.model } : {}),
                    ...(attribution?.requestedModel ? { requestedModel: attribution.requestedModel } : {}),
                    ...(attribution?.servedModel ? { servedModel: attribution.servedModel } : {}),
                    ...(attribution?.servedProvider ? { servedProvider: attribution.servedProvider } : {}),
                    ...(attribution?.servedSource ? { servedSource: attribution.servedSource } : {}),
                    ...(failoverInfo ? { modelFailover: failoverInfo } : {}),
                  })
                },
              }
            : {}),
          ...(options.traceFlush ? { traceFlush: () => options.traceFlush!(context) } : {}),
        },
      })

      // Tee: one branch to the live client, one drained under waitUntil so the
      // turn (and its buffering via onEvent) runs to completion after a client
      // drop — the engine body executes as it is pulled.
      const [clientBody, drainBody] = result.body.tee()
      const drained = (async () => {
        const reader = drainBody.getReader()
        let drainError: unknown
        try {
          for (;;) {
            const { done } = await reader.read()
            if (done) break
          }
        } catch (err) {
          drainError = err
          log('[chat-routes] turn drain failed', {
            turnId: turnStreamId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        const failed = runFailed || drainError !== undefined
        // Settle any in-flight draft INSIDE the waitUntil-tracked drain. On the
        // path where the producer throws, `persistAssistantMessage` never runs
        // to close the writer, and an unawaited write would race the isolate's
        // teardown — leaving a torn row instead of a clean partial one for a
        // re-entered turn to adopt.
        if (ctx?.cancelOnDisconnect && request.signal.aborted) {
          await draft?.discard()
        } else {
          await draft?.close()
        }
        try {
          await tap.done(failed ? 'error' : 'complete')
        } catch (err) {
          log('[chat-routes] turn buffer finalize failed', {
            turnId: turnStreamId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        await fireTerminalLifecycle(failed, drainError)
        await releaseLock()
      })()
      if (ctx?.waitUntil) ctx.waitUntil(drained)
      else void drained.catch(() => {})

      // Announce the replay handle before the engine's first event.
      const encoder = new TextEncoder()
      const marker = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`${JSON.stringify(turnMarker)}\n`))
          controller.close()
        },
      })
      const body = concatStreams([marker, clientBody])

      return new Response(body, {
        headers: {
          'Content-Type': result.contentType,
          'Cache-Control': 'no-cache',
        },
      })
    } catch (err) {
      // A throw before the turn began streaming (user-insert, gate, beforeTurn,
      // lifecycle-start, tap setup, engine construction, tee). If the turn had
      // already started, settle the lifecycle with `onTurnError` (close the
      // span) — the drain never ran to do it. Then release the lock, propagate.
      if (turnStarted) await fireTerminalLifecycle(true, err)
      await releaseLock()
      throw err
    }
  }

  async function replay(request: Request, params: { turnId: string }): Promise<Response> {
    const turnId = params.turnId?.trim()
    if (!turnId) return Response.json({ error: 'Missing turnId' }, { status: 400 })
    const auth = await options.authorize({ request, intent: 'replay', turnId })
    if (!auth.ok) return auth.response

    const fromSeqRaw = new URL(request.url).searchParams.get('fromSeq')
    const fromSeq = fromSeqRaw ? Math.max(0, Math.trunc(Number(fromSeqRaw)) || 0) : 0

    const encoder = new TextEncoder()
    const events = replayTurnEvents({
      store: options.turnStore,
      turnId,
      fromSeq,
      ...(options.replay?.pollMs !== undefined ? { pollMs: options.replay.pollMs } : {}),
      ...(options.replay?.timeoutMs !== undefined ? { timeoutMs: options.replay.timeoutMs } : {}),
    })
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await events.next()
        if (done) {
          controller.close()
          return
        }
        // Stamp the buffer ordinal so a reconnecting client resumes from
        // `?fromSeq=<lastSeq>` instead of refetching the turn from 0 and
        // re-applying every delta onto already-rendered state.
        controller.enqueue(encoder.encode(`${stampReplaySeq(value)}\n`))
      },
      cancel() {
        void events.return(undefined)
      },
    })
    return new Response(body, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
      },
    })
  }

  async function running(request: Request): Promise<Response> {
    const threadId = new URL(request.url).searchParams.get('threadId')?.trim()
    if (!threadId) return Response.json({ error: 'Missing threadId' }, { status: 400 })
    const auth = await options.authorize({ request, intent: 'running', threadId })
    if (!auth.ok) return auth.response
    // `listRunning` is optional on the store; a store that cannot enumerate
    // running turns simply reports none — the client falls back to the persisted
    // transcript, never to a hang.
    const ids = (await options.turnStore.listRunning?.(threadId)) ?? []
    return Response.json({ running: ids })
  }

  return {
    turn,
    replay,
    running,
    interactions: options.interactions ? createInteractionAnswerRoute(options.interactions) : null,
  }
}

/** Sequential concat of byte streams (marker line, then the engine body). */
function concatStreams(streams: ReadableStream<Uint8Array>[]): ReadableStream<Uint8Array> {
  let index = 0
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (!reader) {
          const next = streams[index++]
          if (!next) {
            controller.close()
            return
          }
          reader = next.getReader()
        }
        const { done, value } = await reader.read()
        if (done) {
          reader = null
          continue
        }
        controller.enqueue(value)
        return
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason)
      for (const stream of streams.slice(index)) await stream.cancel(reason)
    },
  })
}

/**
 * Stop a producer pull as soon as an opted-in caller disconnects.
 * `AsyncIterator.return()` alone cannot interrupt a pending `next()` call, so
 * race each pull with the request signal and close the source in `finally`.
 */
async function* abortOnSignal<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T, void, unknown> {
  const iterator = source[Symbol.asyncIterator]()
  try {
    for (;;) {
      const next = await nextWithAbort(iterator, signal)
      if (next.done) return
      yield next.value
    }
  } finally {
    await closeIteratorAfterAbort(iterator)
  }
}

function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted) return Promise.reject(new Error('chat turn cancelled'))
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('chat turn cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    Promise.resolve()
      .then(() => iterator.next())
      .then(
        (result) => {
          if (settled) return
          settled = true
          cleanup()
          resolve(result)
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          cleanup()
          reject(error)
        },
      )
  })
}

const ABORT_CLEANUP_TIMEOUT_MS = 50

async function closeIteratorAfterAbort<T>(iterator: AsyncIterator<T>): Promise<void> {
  let closing: PromiseLike<unknown> | undefined
  try {
    const result = iterator.return?.()
    if (result) closing = Promise.resolve(result)
  } catch {
    return
  }
  if (!closing) return
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve(closing).catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, ABORT_CLEANUP_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
