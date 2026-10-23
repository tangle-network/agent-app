/** Public contracts for admission, execution, persistence and chat-route hooks. */
import type { NativeCompletionHandoffOptions, NativeTurnTimingFacts } from './native-turn-timing'
import type { ChatMessageValues } from '../chat-store/core'
import type { ChatTurnPrefetch, ChatTurnPrefetchIdentity } from './turn-prefetch'
import type { ChatTurnIdentity, ChatTurnProducer } from '@tangle-network/agent-runtime/durable'
import type { ChatMessagePart } from '../chat-store/parts'
import type { InteractionAnswerRoute, InteractionAnswerRouteOptions } from '../interactions/route'
import type { ModelFailoverAttempt } from '../model-resolution/failover'
import type { ModelPolicy } from '../policy-filters/index'
import type { PersistedChatMessageForTurn, TurnEventStore } from '../stream/index'
import type { D1LikeForTurns } from '../stream/turn-buffer'
import type { TurnStreamAuth, TurnStreamNamespaceLike } from '../turn-stream/adapters'
import type { TurnSpan, TurnSpanAttrs, TurnTrace, TurnTraceSink, TurnTraceSummary } from '../turn-trace/recorder'
import type { TurnRoutePhase } from './turn-progress'
import type { ChatTurnPartInput, ChatTurnRequestPayload } from './wire'
import type { RouterTurnProducerOptions } from './router-producer'
import type { HybridTurnProducerOptions } from './hybrid-producer'
import type { SandboxChatProducerOptions } from './sandbox-producer'
import type { ChatTurnCancelOptions, ChatTurnCancelRequest } from './cancellation'

/** The route supplies request tracing, cancellation and the admission fence.
 * Domain callbacks supply model, credentials, policy, tools and prompt data. */
export type ChatTurnRouterConfiguration = Omit<RouterTurnProducerOptions, 'trace' | 'traceId' | 'signal' | 'userMessage' | 'history'> & {
  userMessage?: RouterTurnProducerOptions['userMessage']
  history?: RouterTurnProducerOptions['history']
}
export type ChatTurnHybridConfiguration = Omit<HybridTurnProducerOptions, 'trace' | 'traceId' | 'signal' | 'userMessage' | 'history'> & {
  userMessage?: HybridTurnProducerOptions['userMessage']
  history?: HybridTurnProducerOptions['history']
}
export type ChatTurnRouterBackend = ChatTurnRouteProducer | ChatTurnRouterConfiguration | ChatTurnHybridConfiguration
export type ChatTurnSandboxBackend = ChatTurnRouteProducer | SandboxChatProducerOptions

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
  appendMessage(input: ChatMessageValues & {
    /** Caller-assigned row id. Honored by `/chat-store`'s `createChatStore`;
     *  a product store free to ignore it (the writer then adopts whatever id
     *  the insert returns). Set only by incremental persistence. */
    id?: string
    threadId: string
    role: 'user' | 'assistant'
  }): Promise<unknown>
  /** Patch an existing row. Its PRESENCE is what enables incremental assistant
   *  persistence — a store without it keeps today's exact single-write-on-
   *  completion behavior, which is what makes this additive. */
  updateMessage?(id: string, patch: Partial<ChatMessageValues>): Promise<unknown>
  /** Remove a row. Used to retract a draft assistant row for a turn that ended
   *  producing nothing, so the empty-turn case still leaves no row at all. */
  deleteMessage?(id: string): Promise<unknown>
}

/** `ChatTurnProducer` plus the persisted projection the assembly reads after
 *  drain. `createSandboxChatProducer` returns this; a router-lane producer
 *  may omit the optional members (finalText persists as a single text part). */
export interface ChatTurnRouteProducer extends ChatTurnProducer {
  /** Pending resource retirement after stream termination. The route tracks it
   *  with the request's waitUntil, including when admission refuses an early
   *  Router call. Cleanup must handle and report its own failures. */
  cleanup?: Promise<void>
  /** Actual backend result/done was observed; transport EOF/error alone is not completion. */
  terminalObserved?(): boolean
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
      /** Omit for existing callers; a full execution authorization may name its intent explicitly. */
      intent?: 'turn'
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
  | {
      ok: true
      /** Identity/access for this operation only; it cannot start a turn. */
      intent: 'replay' | 'running' | 'cancel'
      tenantId: string
      userId: string
    }
  | { ok: false; response: Response }

/** Define arguments required to authorize a chat turn based on intent and request details */
export interface ChatTurnAuthorizeArgs {
  request: Request
  /** This request's bound host continuation, when supplied to turn(request, ctx). */
  waitUntil?: ChatTurnRequestContext['waitUntil']
  intent: 'turn' | 'replay' | 'running' | 'cancel'
  /** Parsed, validated POST body for a turn or cancellation. */
  body?: ChatTurnRequestPayload | ChatTurnCancelRequest
  /** The buffered turn id being replayed (replay intent only). */
  turnId?: string
  /** The thread whose running turns are being discovered (running intent only). */
  threadId?: string
  /** The turn's trace (turn intent only). A product records its own child spans (a billing read, a workspace check) so the
   *  admission wait is named by step; the route already records `admission.authorize` around the whole call. */
  trace?: TurnTrace
  /** The `admission.authorize` span (turn intent only): the parent for those child spans, so they nest under it. */
  span?: TurnSpan
  /** Turn intent with the route's `prefetch` option set: call it as soon as the caller's identity is verified, before
   *  the rest of the checks, so the prefetch reads beside them (see `./turn-prefetch`). */
  identified?(identity: ChatTurnPrefetchIdentity): void
}

/** What `prepareTurn` receives: the admitted turn, before the conversation loads. */
export interface ChatTurnPrepareArgs<TContext> {
  request: Request
  /** This request's bound host continuation, when supplied to turn(request, ctx). */
  waitUntil?: ChatTurnRequestContext['waitUntil']
  /** Parsed, validated POST body. */
  body: ChatTurnRequestPayload
  tenantId: string
  userId: string
  threadId: string
  /** The context `authorize` returned; mutate it in place to finish it. */
  context: TContext
  /** Name the stage this work is in. On a progress-first stream it reaches the
   *  client as a `session.run.phase` event; otherwise it is a no-op. */
  progress(phase: string, message: string): void
}

/** `prepareTurn`'s verdict: proceed, or answer with the product's response. */
export type ChatTurnPrepareResult = { ok: true } | { ok: false; response: Response }

/** What `afterAuthorize` receives: the admitted turn, before the conversation loads and before any lock, read or write. */
export interface ChatTurnAfterAuthorizeArgs<TContext> {
  request: Request
  /** This request's bound host continuation, when supplied to turn(request, ctx). */
  waitUntil?: ChatTurnRequestContext['waitUntil']
  /** Parsed, validated POST body. */
  body: ChatTurnRequestPayload
  tenantId: string
  userId: string
  threadId: string
  /** The context `authorize` returned. Keep what the seam starts on it: `prepareTurn`, every later seam and `produce` receive the same object. */
  context: TContext
  /** The turn's trace, for the spans of the work the seam starts. */
  trace: TurnTrace
}

/** Frees what `afterAuthorize` started, for a turn that ends before `produce` takes it. */
export type ChatTurnAfterAuthorizeRelease<TResource = unknown> = (() => void | Promise<void>) | {
  /** Acquisition must clean up any partial resource when it rejects. */
  resource: Promise<TResource>
  /** Called once when this turn ends, including a refusal before acquisition resolves. */
  dispose(resource: TResource): void | Promise<void>
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
export interface ChatTurnProduceArgs<TContext, TResource = unknown> {
  request: Request
  /** The opaque resource afterAuthorize started; the route disposes it at this turn's end. */
  earlyResource?: Promise<TResource>
  /** This request's bound host continuation, when supplied to turn(request, ctx). */
  waitUntil?: ChatTurnRequestContext['waitUntil']
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
  /** The turn's intent line (`intentLine`), or null when it was off, slow or
   *  failed. Never rejects. A product puts it in the harness turn's context so
   *  the agent knows what the founder was told it would do. */
  intentLine?: Promise<string | null>
  /** Server-authenticated limits for this turn. Never copied from the body. */
  executionLimits?: ChatTurnExecutionLimits
  /**
   * The turn's trace (`@tangle-network/agent-app/turn-trace`), bound to this turn's execution id. Pass it to the
   * Router engine (`trace`), `streamSandboxPrompt` and `ensureWorkspaceSandbox` so the turn's model calls, tool
   * calls and box claim are recorded under it; its `traceId` is what those calls send as `x-tangle-trace-id`.
   * The route records admission and persistence itself. Optional for source compatibility with synthetic
   * producers; every `createChatTurnRoutes` invocation supplies it.
   */
  trace?: TurnTrace
  /** The durable `role:'user'` row this turn is anchored to — the row the
   *  factory just inserted, or the one retry-dedup REUSED. Products anchor
   *  optimistic-bubble swaps, retry targeting, and stop-polling to it, and it
   *  is the only way to name a REUSED row (which `priorMessages` excludes).
   *
   *  Three states, all meaningful:
   *  - `undefined` — a new row is not inserted yet. The dispatch-first policy
   *    and `turnLock.acquire` see this for a fresh turn; a reused row's id is
   *    already available from the history read, without another query.
   *  - `null` — resolved, no row: `authorize` returned `insertUserMessage:
   *    false` on a turn with nothing to reuse, or the store's `appendMessage`
   *    resolved without a usable id.
   *  - a string — the row id, including a reused row before dispatch policy;
   *    also supplied to `contextGate`, `beforeTurn`, and `produce`. */
  userMessageId?: string | null
  /** True when this turn's own insert created `userMessageId`, so no earlier
   *  attempt can have answered it; false when retry-dedup reused the row or no
   *  row was written. A gate that refuses an already-answered retry can skip
   *  its read when this is true. Already false for a reused row at backend
   *  selection and lock acquisition; undefined for a fresh row until insertion. */
  userMessageInserted?: boolean
  /**
   * Transfer completion ownership to a product-owned durable runner. The
   * product MUST register that runner durably, then await this callback before
   * dispatching native execution. When timing transfer is used, persist the initial
   * timingFacts snapshot on the existing admission before registering that runner.
   * A callback rejection after registration retains durable ownership. Once it
   * resolves, this route remains a live event projector only: it no longer writes or settles the assistant
   * transcript, lifecycle hooks, lock, or replay-buffer status.
   *
   * Optional for source compatibility with synthetic producers. Every
   * `createChatTurnRoutes` invocation supplies it before `produce` runs.
   */
  handoffCompletion?: (options?: NativeCompletionHandoffOptions) => Promise<void>
  /** Serializable observations only; snapshots never predict events after handoff. */
  timingFacts?: () => NativeTurnTimingFacts
  /** What the route's `prefetch` read for this turn's admitted identity; set only when `prefetch` is configured. */
  prefetched?: Promise<unknown>
  /** Set for a fresh Router backend, which starts before the lock. Resolves to the final args (with
   *  `userMessageId`, after `contextGate` and `beforeTurn`) once the admission chain commits, or rejects with
   *  `TurnAdmissionRefusedError` when the turn is refused. Start the model call at once; write nothing durable,
   *  and read nothing `beforeTurn` adds to `context`, until it resolves. */
  admitted?: Promise<ChatTurnProduceArgs<TContext, TResource>>
  /** Effective execution signal: product Stop/supersession, opted-in durable Stop/control loss,
   *  and optional request-disconnect cancellation.
   *  A fresh Router backend also aborts on admission refusal or when the route stops reading it.
   *  Pass it to producer I/O; Router/Sandbox option data binds it automatically.
   *  Early Router handoff waits for `admitted`. */
  admissionSignal?: AbortSignal
}

/** One event as it crosses the route: the producer's own vocabulary, or an
 *  injected keepalive. Same shape the engine forwards verbatim.
 *
 *  Public because it IS the vocabulary of two seams — `onRawEvent`'s parameter
 *  and `heartbeat.event`'s return. Exported so a product can declare a
 *  standalone handler (`function onRawEvent(e: ChatRouteEvent, ctx: T)`) rather
 *  than depending on contextual typing from an inline object literal. */
export type ChatRouteEvent = { type: string; data?: Record<string, unknown> }

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

/** Pre-turn readiness verdict — proceed, short-circuit, or hand off to a
 *  product-owned durable turn. Distinct from `authorize`: this gates domain
 *  readiness, not access. */
export type ChatTurnGateResult =
  | { proceed: true }
  | { proceed: false; response: Response }
  /** The product has accepted the turn and owns execution and lifecycle after
   *  the route releases its lock. */
  | { proceed: 'handoff'; response: Response }

/** Single-flight lock verdict — acquired (with an opaque handle passed back to
 *  `release`), or already held (short-circuit with the product's 409-style
 *  `Response`). */
export interface ChatTurnCancellation {
  signal: AbortSignal
  /** Close this owner's observation; never release the durable lock or claim remote work stopped. */
  close(): void | Promise<void>
}

export type ChatTurnLockResult =
  | { acquired: true; handle?: unknown; cancellation?: ChatTurnCancellation }
  | { acquired: false; response: Response }

/** Async acquire/release wrapped around the turn. `acquire` runs before any
 *  side effect; `release` runs once when the turn settles — including on a
 *  short-circuit or a throw. */
export interface ChatTurnLock<TContext, TResource = unknown> {
  acquire(args: ChatTurnProduceArgs<TContext, TResource>): ChatTurnLockResult | Promise<ChatTurnLockResult>
  release(handle: unknown): void | Promise<void>
  /** Bring up whatever `acquire` will talk to, as soon as the turn is admitted
   *  and while `prepareTurn` and the history read run. Never awaited; a failure
   *  is logged and the turn goes on to `acquire` as usual. */
  warm?(target: { tenantId: string; userId: string; threadId: string; context: TContext }): void | Promise<void>
}

interface ChatTurnLifecycleBase<TContext> {
  identity: ChatTurnIdentity
  executionId: string
  turnStreamId: string
  context: TContext
}
/** When the turn's first visible word streamed, measured from `onTurnStart`. Absent when no word streamed. */
interface ChatTurnLifecycleTiming {
  /** Request receipt to onTurnStart; add to firstVisibleMs for request-origin latency. */
  admissionMs?: number
  /** First reasoning, tool activity or answer output, measured from onTurnStart. */
  firstVisibleMs?: number
  firstTextMs?: number
  /** Where the turn's wall time went: its share inside named spans and the time per kind of span. */
  trace?: TurnTraceSummary
}
/** Define lifecycle start event with context and timestamp for a chat turn */
export interface ChatTurnLifecycleStart<TContext> extends ChatTurnLifecycleBase<TContext> {
  startedAt: number
  /** Request receipt on the server clock. */
  requestReceivedAt: number
  admissionMs: number
}
/** Define the structure representing the completion state of a chat turn lifecycle with usage data */
export interface ChatTurnLifecycleComplete<TContext> extends ChatTurnLifecycleBase<TContext>, ChatTurnLifecycleTiming {
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
export interface ChatTurnLifecycleError<TContext> extends ChatTurnLifecycleBase<TContext>, ChatTurnLifecycleTiming {
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
  /** Follow-up work for a turn that ended cleanly: it runs with `onTurnComplete`'s own info once the assistant row is
   *  persisted, the lifecycle hooks have fired and the thread's lock is released, under `waitUntil` where the host has
   *  one. The member's next send never waits for it, so work that only decorates the answer (a model-written
   *  checklist, a title, an index) belongs here and not in the producer's stream, where it holds the lock and the
   *  stream open. It does not run for a failed, gated or handed-off turn. The turn's trace has ended; a product that
   *  wants this work traced starts its own. A throw is logged and never reaches the member. */
  afterSettle?(info: ChatTurnLifecycleComplete<TContext>): void | Promise<void>
}

/** What a settled turn reports to `onTurnComplete` — the product's
 *  post-processing seam (billing, titles, audit). */
export interface ChatTurnCompleteInput<TContext> {
  identity: ChatTurnIdentity
  finalText: string
  context: TContext
  failed: boolean
  /** Final producer receipt, when it reports usage; absent counts remain unknown. */
  usage?: ChatTurnUsage
  failureReason?: string
  /** Typed reason of a failed turn, when its terminal error event names one. */
  failureCode?: string
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

/** Where a finished turn's trace goes, and the host's labels for its root span. Metadata only: never content. */
export interface ChatTurnTraceOptions<TContext> {
  /** Default: `createIntelligenceTurnTraceSink({ project: projectId })`, which reads the Sandbox product key from the environment. */
  sink?: TurnTraceSink
  /** Labels for the root span, e.g. the workspace id. Called once per exported turn. */
  labels?(info: { identity: ChatTurnIdentity; executionId: string; context: TContext }): TurnSpanAttrs
}

/** Define options to configure chat turn routes including authorization, storage, and event buffering */
export interface CreateChatTurnRoutesOptions<TContext = void, TResource = unknown> {
  /** Names the product in `deriveExecutionId` so retries land on the same
   *  substrate execution. */
  projectId: string
  /** Authenticate + authorize the caller for a turn or a replay. The only
   *  product-supplied access step: session auth, thread/workspace access,
   *  seat/balance gates, rate limits all live here. */
  authorize(args: ChatTurnAuthorizeArgs): Promise<ChatTurnAuthorization<TContext>>
  /** Resolve the exact authenticated stop target. Without this capability,
   *  cancel returns 405 before parsing or authorization. */
  cancel?: ChatTurnCancelOptions<TContext>
  /** Read the turn's prompt inputs (profile, knowledge, catalogs) while `authorize` finishes: started when `authorize`
   *  calls `args.identified`, or once it allows the turn. Read only: no writes, nothing paid or external beyond what
   *  the verified identity allows. `produce` receives the result as `args.prefetched` only for an allowed turn of that
   *  identity; a refusal aborts `args.signal` and drops it. Omit → nothing is prefetched. */
  prefetch?: ChatTurnPrefetch
  /** Finish the turn's context after `authorize` has admitted the caller and
   *  before the conversation loads or the lock is taken: resolve the profile,
   *  the model, anything that reads or writes product state. Keep `authorize`
   *  to admission (identity, access, rate limits, input checks) so a refusal
   *  stays fast and no write ever runs for a caller who is not admitted; on a
   *  progress-first stream this work runs inside the stream and can name its
   *  stages through `progress`. A refusal here is answered like a held lock:
   *  a plain response without the progress header, a `turn.response` event
   *  with it. Omit → nothing to prepare. */
  prepareTurn?(args: ChatTurnPrepareArgs<TContext>): ChatTurnPrepareResult | Promise<ChatTurnPrepareResult>
  /** Start the work this turn will need, the moment `authorize` and `modelPolicy` have admitted it, so that work overlaps
   *  `prepareTurn`, the history read, the lock, the history recheck and the user-row insert instead of following them: the
   *  workspace box, the keys a producer mints, a session ensure. Return `{resource, dispose}` to hand the route an
   *  opaque acquisition promise: `produce` receives it as `args.earlyResource`, and the route disposes the value once
   *  when the turn ends, including a refusal before acquisition resolves. Acquisition owns partial-failure cleanup.
   *
   *  Admission has not finished, so the seam must start only work that the turn's refusal leaves harmless: a held lock
   *  (409), a changed history, a gate's answer or a throw all end the turn without `produce`, and the work already
   *  started runs on. Start nothing a second request for the same thread could not safely repeat, and nothing that
   *  writes product state.
   *
   *  Not awaited, and it must return synchronously: start the work and return, never wait for it. It may return a
   *  legacy release function; the route calls it once, only if the turn ends without `produce` (the chain above, or a throw before the
   *  engine took the turn), so a product frees credentials or leases the unused work holds. Once `produce` runs, the
   *  work belongs to `produce` and the route never calls the release. A throw is logged and the turn goes on without
   *  the early work. Omit → nothing starts early. */
  afterAuthorize?(args: ChatTurnAfterAuthorizeArgs<TContext>): void | ChatTurnAfterAuthorizeRelease<TResource>
  /** Product admission policy over the model a turn NAMES. When the request
   *  body carries a `model`, it is checked here — after `authorize`, before
   *  the conversation loads, the lock is taken, or any row is written — and a
   *  refusal answers 403 with the policy's reason. Fail-closed: a named model
   *  carrying no policy metadata is refused.
   *
   *  This is half the enforcement. A body without `model` resolves to a
   *  product default inside `produce`, which this seam never sees — enforce
   *  that half at execution with `createSandboxChatProducer`'s `modelPolicy`
   *  (or `runWithModelFailover`'s `policy` on a custom producer), which also
   *  covers every fallback the turn could fail over to. Wire the SAME policy
   *  object to both. Omit → no policy check (today's behavior). */
  modelPolicy?: ModelPolicy
  /** Thread/message persistence (`/chat-store`'s store or a product adapter). */
  store: ChatTurnMessageStore
  /** Turn-event buffer (`createD1TurnEventStore(env.DB)` or `/turn-stream`'s
   *  `createDurableObjectTurnEventStore(env.TURN_STREAM_DO)` in production,
   *  `createMemoryTurnEventStore()` in tests). Wired by default — every turn
   *  is buffered and replayable. */
  turnStore: TurnEventStore | {
    db: D1LikeForTurns
    lock: { namespace: TurnStreamNamespaceLike; auth: TurnStreamAuth }
  }
  /** Build the turn stream after admission, or declare its execution backends.
   * Router calls start before the lock by default, after authorize has verified
   * identity/access. The model service enforces spend before paying a provider.
   * Output stays buffered until admission commits; a refusal cancels the call.
   * Return Router/Hybrid producer options to bind tracing, cancellation and
   * tool admission automatically. A custom Router producer must pass
   * admissionSignal and await admitted before tools or durable effects.
   * beforeTurn cannot patch a Router prompt already sent.
   *
   * when selects the Router backend (default true); false selects sandbox,
   * which always starts after admission. A function also starts after admission.
   * Reused user rows always finish admission before either backend starts. */
  produce: ((args: ChatTurnProduceArgs<TContext, TResource>) => ChatTurnRouteProducer | Promise<ChatTurnRouteProducer>) | {
    router(args: ChatTurnProduceArgs<TContext, TResource>): ChatTurnRouterBackend | Promise<ChatTurnRouterBackend>
    when?(args: ChatTurnProduceArgs<TContext, TResource>): boolean
    sandbox?(args: ChatTurnProduceArgs<TContext, TResource>): ChatTurnSandboxBackend | Promise<ChatTurnSandboxBackend>
  }
  /** Single-flight lock acquired before durable effects and released once when
   *  the turn settles (including short-circuit/throw). `/turn-stream`'s
   *  `createDurableTurnLock` is the shared DO-backed implementation. Omit →
   *  no lock. */
  turnLock?: ChatTurnLock<TContext, TResource>
  /** Pre-turn readiness gate that can short-circuit with a product `Response`
   *  before the producer runs (the user row is already persisted). Runs after
   *  `turnLock.acquire`, before `beforeTurn`. Omit → always proceed.
   *
   *  Settled shape (#227). What a consumer may depend on:
   *  - `args.userMessageId` is RESOLVED here — a string, or `null` when the
   *    insert was suppressed with nothing to reuse. (`turnLock.acquire` is the
   *    only seam that sees it `undefined`.)
   *  - `{proceed:false}` releases the lock and returns the product's `Response`
   *    verbatim: `beforeTurn` and an ordinary/Sandbox producer never run; an
   *    early Router call is cancelled and discarded. No assistant row is
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
  contextGate?(args: ChatTurnProduceArgs<TContext, TResource>): ChatTurnGateResult | Promise<ChatTurnGateResult>
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
  beforeTurn?(
    args: ChatTurnProduceArgs<TContext, TResource>,
    /** `span` is the `admission.before_turn` span: the parent for a product's own child spans. */
    seam?: { span: TurnSpan },
  ): ChatTurnInputPatch | void | Promise<ChatTurnInputPatch | void>
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
  /**
   * Where each finished turn's trace goes. On by default: omit it and every turn goes to Tangle Intelligence under
   * `projectId` (`createIntelligenceTurnTraceSink`); pass `{ sink, labels }` to send it elsewhere or label it.
   * The route always records the turn's trace (`ChatTurnProduceArgs.trace`), reports its summary to `lifecycle`, and
   * writes one `agent_app_turn_trace` log line per turn (first text, coverage, time per kind); this sends the spans on.
   * The sink runs under `waitUntil` after the lifecycle hooks and after the turn lock is released, and its failure never
   * fails a turn. A turn handed to a durable owner (`handoffCompletion`) is exported when this request's live
   * projection ends, failed only when the projection saw an error. `false` is the only opt-out, and
   * `agent-app-signoff defaults` fails it until the app's `signoff.config.mjs` gives the reason.
   */
  turnTrace?: ChatTurnTraceOptions<TContext> | false
  /** Compose the interaction-answer endpoints (`/interactions`). Omit when the
   *  product has no sidecar ask channel. */
  interactions?: InteractionAnswerRouteOptions
  /** Text for the route's own stages on a progress-first stream (`./turn-progress`).
   *  Omitted stages keep `TURN_ROUTE_PHASE_MESSAGES`. */
  progressMessages?: Partial<Record<TurnRoutePhase, string>>
  /** Write and stream the turn's intent line ({@link ChatTurnIntentLine}). Omit → no line. */
  intentLine?: ChatTurnIntentLine<TContext>
  log?: (message: string, meta?: Record<string, unknown>) => void
}

/** What `intentLine.generate` receives: the admitted turn's message and the thread's last few turns. */
export interface ChatTurnIntentLineArgs<TContext> {
  content: string
  /** The thread's last turns before this one, oldest first (at most {@link INTENT_LINE_HISTORY_MESSAGES}). */
  history: ReadonlyArray<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string }>
  tenantId: string
  userId: string
  threadId: string
  context: TContext
  /** Aborted when the line is no longer wanted (its deadline passed). */
  signal: AbortSignal
}

/**
 * The intent line: one plain sentence, written by a fast model call the moment
 * a turn is admitted, saying what the agent is about to do. It reaches a
 * progress-first client as a {@link TURN_INTENT_EVENT} while the harness boots,
 * and the turn's first answer text replaces it. It narrates intent and must
 * never answer or act. It fails open: a line later than `timeoutMs`, an error,
 * or an empty answer shows nothing.
 */
export interface ChatTurnIntentLine<TContext> {
  generate(args: ChatTurnIntentLineArgs<TContext>): Promise<string | null>
  /** Longest wait for the line. Default {@link INTENT_LINE_TIMEOUT_MS}. */
  timeoutMs?: number
}

/** A line slower than this shows nothing. */
export const INTENT_LINE_TIMEOUT_MS = 1_500
/** Turns of the thread the line is written from. */
export const INTENT_LINE_HISTORY_MESSAGES = 6
/** Longest line kept; anything longer is cut. */
export const INTENT_LINE_MAX_CHARS = 240

/** Define routes to run, replay, and list running chat turns with streaming and reconnect support */
export interface ChatTurnRoutes {
  /** POST — run one turn, streaming NDJSON. First line is
   *  `{type:'turn', turnId}` (the replay handle); the rest is the engine's
   *  event protocol. Pass the platform's `waitUntil` so the turn keeps
   *  running (and buffering) after a client disconnect. A request with
   *  `TURN_PROGRESS_HEADER` gets a progress-first stream once it is
   *  authorized (`./turn-progress`). */
  turn(request: Request, ctx?: ChatTurnRequestContext): Promise<Response>
  /** POST — stop the exact authorized execution; unavailable unless configured. */
  cancel(request: Request): Promise<Response>
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
