/**
 * `createChatTurnRoutes` — the assembled server chat vertical (issue #188
 * Phase 1). One factory composing the pieces every product re-wired by hand:
 *
 *   body parse/validate      → `/web` `parseJsonObjectBody` + `./wire`
 *   turn identity            → `/stream` `resolveChatTurn` + agent-runtime
 *                              `deriveExecutionId`
 *   producer                 → injected seam (sandbox lane via
 *                              `createSandboxChatProducer`; router lane is the
 *                              product's own `ChatTurnProducer`)
 *   turn engine              → agent-runtime `handleChatTurn` (verbatim)
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
 * Five optional product seams let a complex turn-orchestrator compose the
 * vertical instead of hand-rolling a generator — each omittable to the exact
 * behavior above: `turnLock` (single-flight acquire/release around the turn),
 * `contextGate` (pre-producer domain-readiness short-circuit), `beforeTurn`
 * (observe + augment the producer input), `lifecycle` (deterministic
 * start/complete/error telemetry), `heartbeat` (keepalive during silent
 * producer waits), plus `onRawEvent` (the raw producer events, for telemetry).
 * `handleChatTurn` stays the engine — the seams only wrap its input, its
 * producer stream, and its settle.
 */

import { deriveExecutionId, handleChatTurn } from '@tangle-network/agent-runtime'
import type { ChatTurnIdentity, ChatTurnProducer } from '@tangle-network/agent-runtime'
import { toChatMessageParts, type ChatMessagePart } from '../chat-store/parts'
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
  type PersistedChatMessageForTurn,
  type TurnEventStore,
} from '../stream/index'
import { parseJsonObjectBody } from '../web/index'
import {
  assertPromptPartsWithinCap,
  ChatTurnInputError,
  parseChatTurnParts,
  type ChatTurnFilePartInput,
  type ChatTurnPartInput,
  type ChatTurnRequestPayload,
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
    threadId: string
    role: 'user' | 'assistant'
    content: string
    parts?: ChatMessagePart[]
    model?: string | null
    inputTokens?: number | null
    outputTokens?: number | null
    reasoningTokens?: number | null
    cacheReadTokens?: number | null
    cacheWriteTokens?: number | null
    costUsd?: number | null
  }): Promise<unknown>
}

/** `ChatTurnProducer` plus the persisted projection the assembly reads after
 *  drain. `createSandboxChatProducer` returns this; a router-lane producer
 *  may omit the optional members (finalText persists as a single text part). */
export interface ChatTurnRouteProducer extends ChatTurnProducer {
  assistantParts?(): Array<Record<string, unknown>>
  usage?(): ChatTurnUsage
  model?: string
}

export type ChatTurnAuthorization<TContext> =
  | { ok: true; tenantId: string; userId: string; context: TContext }
  | { ok: false; response: Response }

export interface ChatTurnAuthorizeArgs {
  request: Request
  intent: 'turn' | 'replay'
  /** Parsed, validated POST body (turn intent only). */
  body?: ChatTurnRequestPayload
  /** The buffered turn id being replayed (replay intent only). */
  turnId?: string
}

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
}

/** One event as it crosses the route: the producer's own vocabulary, or an
 *  injected keepalive. Same shape the engine forwards verbatim. */
type ChatRouteEvent = { type: string; data?: Record<string, unknown> }

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
export interface ChatTurnLifecycleStart<TContext> extends ChatTurnLifecycleBase<TContext> {
  startedAt: number
}
export interface ChatTurnLifecycleComplete<TContext> extends ChatTurnLifecycleBase<TContext> {
  finalText: string
  usage: ChatTurnUsage
  durationMs: number
}
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
  /** Turn-event buffer (`createD1TurnEventStore(env.DB)` in production,
   *  `createMemoryTurnEventStore()` in tests). Wired by default — every turn
   *  is buffered and replayable. */
  turnStore: TurnEventStore
  /** Build the turn's event stream. Sandbox lane: `streamSandboxPrompt(...)`
   *  wrapped in `createSandboxChatProducer`. Router/openai-compat lane: the
   *  product's own producer. May be async (box resolution). */
  produce(args: ChatTurnProduceArgs<TContext>): ChatTurnRouteProducer | Promise<ChatTurnRouteProducer>
  /** Single-flight lock acquired before any side effect and released once when
   *  the turn settles (including short-circuit/throw). Omit → no lock. */
  turnLock?: ChatTurnLock<TContext>
  /** Pre-turn readiness gate that can short-circuit with a product `Response`
   *  before the producer runs (the user row is already persisted). Runs after
   *  `turnLock.acquire`, before `beforeTurn`. Omit → always proceed. */
  contextGate?(args: ChatTurnProduceArgs<TContext>): ChatTurnGateResult | Promise<ChatTurnGateResult>
  /** Observe the assembled producer input and optionally augment it (rewrite
   *  the prompt / prior messages) before the producer runs. Omit → no change. */
  beforeTurn?(args: ChatTurnProduceArgs<TContext>): ChatTurnInputPatch | void | Promise<ChatTurnInputPatch | void>
  /** Deterministic run telemetry (start / complete / error) with identity and
   *  timing. Omit → no telemetry. */
  lifecycle?: ChatTurnLifecycle<TContext>
  /** Keepalive injected while the producer is quiet. Omit → no keepalives. */
  heartbeat?: ChatTurnHeartbeat
  /** Observe each event the producer emits, before the engine frames it and
   *  before any heartbeat injection (the raw sidecar-producer events, for
   *  telemetry). Never alters the stream; errors are swallowed. Distinct from
   *  `onEvent`, which sees the engine-framed stream incl. lifecycle envelopes. */
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
  onTurnComplete?(input: {
    identity: ChatTurnIdentity
    finalText: string
    context: TContext
    failed: boolean
    failureReason?: string
  }): Promise<void>
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

export interface ChatTurnRoutes {
  /** POST — run one turn, streaming NDJSON. First line is
   *  `{type:'turn', turnId}` (the replay handle); the rest is the engine's
   *  event protocol. Pass the platform's `waitUntil` so the turn keeps
   *  running (and buffering) after a client disconnect. */
  turn(request: Request, ctx?: { waitUntil?(p: Promise<unknown>): void }): Promise<Response>
  /** GET — replay a buffered turn from `?fromSeq=` (0 = everything), then
   *  follow it live until it completes. */
  replay(request: Request, params: { turnId: string }): Promise<Response>
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
  turnId: string | undefined
}

function validateTurnBody(body: Record<string, unknown>, maxInlinePartBytes: number | undefined): ParsedTurnBody {
  const threadId = typeof body.threadId === 'string' ? body.threadId.trim() : ''
  if (!threadId) throw new ChatTurnInputError('Missing threadId')
  const rawContent = body.content ?? body.message ?? ''
  if (typeof rawContent !== 'string') throw new ChatTurnInputError('content must be a string')
  const content = rawContent.trim()
  const fileParts = parseChatTurnParts(body.parts)
  if (!content && fileParts.length === 0) {
    throw new ChatTurnInputError('Missing content (send text, parts, or both)')
  }
  assertPromptPartsWithinCap(fileParts, maxInlinePartBytes)
  let turnId: string | undefined
  try {
    turnId = normalizeClientTurnId(body.turnId)
  } catch (err) {
    throw new ChatTurnInputError(err instanceof Error ? err.message : 'Invalid turnId')
  }
  return {
    payload: { ...body, threadId, content } as ChatTurnRequestPayload,
    content,
    fileParts,
    turnId,
  }
}

/** File parts persist onto the user message verbatim — the wire shape is the
 *  persisted `ChatFilePart`/`ChatImagePart` vocabulary already. The typed
 *  projection is `/chat-store`'s (same boundary as the assistant hop). */
function userPartsWithFiles(
  userParts: Array<Record<string, unknown>>,
  fileParts: ChatTurnFilePartInput[],
): ChatMessagePart[] {
  return toChatMessageParts([...userParts, ...fileParts.map((part) => ({ ...part }))])
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

export function createChatTurnRoutes<TContext = void>(
  options: CreateChatTurnRoutesOptions<TContext>,
): ChatTurnRoutes {
  const log = options.log ?? ((message, meta) => console.error(message, meta ?? ''))

  async function turn(request: Request, ctx?: { waitUntil?(p: Promise<unknown>): void }): Promise<Response> {
    const [rawBody, badBody] = await parseJsonObjectBody(request)
    if (badBody) return badBody

    let parsed: ParsedTurnBody
    try {
      parsed = validateTurnBody(rawBody, options.maxInlinePartBytes)
    } catch (err) {
      if (err instanceof ChatTurnInputError) return errorResponse(err)
      throw err
    }
    const { payload, content, fileParts, turnId } = parsed

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
    const chatTurn = resolveChatTurn({ existingMessages, userContent: content, turnId })

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

    // The producer input every pre-turn seam reads (and `beforeTurn` may
    // rewrite). Mutated in place before the producer's deferred first pull.
    let produceArgs: ChatTurnProduceArgs<TContext> = {
      request,
      body: payload,
      identity,
      context,
      prompt,
      executionId,
      turnStreamId,
      priorMessages: chatTurn.priorMessages,
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
    let runFailed = false
    // Data of the event that marked the run failed — handed to `onTurnError`
    // when no drain throw supplies a richer cause.
    let lastFailureData: Record<string, unknown> | undefined
    let turnStartedAtMs = 0
    let turnStarted = false
    let lifecycleSettled = false

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
          await lifecycle.onTurnComplete?.({
            identity, executionId, turnStreamId, context, durationMs,
            finalText: producer?.finalText() ?? '',
            usage: producer?.usage?.() ?? {},
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
      if (chatTurn.shouldInsertUserMessage) {
        await options.store.appendMessage({
          threadId: payload.threadId,
          role: 'user',
          content,
          parts: userPartsWithFiles(chatTurn.userParts, fileParts),
        })
      }

      // Domain-readiness gate: may short-circuit with the product's own
      // response before the producer runs. The user row above is kept (a real
      // user turn); the gate's response is the assistant side of it.
      if (options.contextGate) {
        const gate = await options.contextGate(produceArgs)
        if (!gate.proceed) {
          await releaseLock()
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
            if (options.onEvent) await options.onEvent(event, context)
          },
          ...(options.transformFinalText ? { transformFinalText: options.transformFinalText } : {}),
          persistAssistantMessage: async ({ finalText }) => {
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
            if (!finalText.trim() && (!parts || parts.length === 0)) return
            const usage = producer?.usage?.() ?? {}
            await options.store.appendMessage({
              threadId: payload.threadId,
              role: 'assistant',
              content: finalText,
              ...(parts && parts.length > 0 ? { parts } : {}),
              ...(producer?.model ? { model: producer.model } : {}),
              ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
              ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
              ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
              ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
              ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
              ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
            })
          },
          ...(options.onTurnComplete
            ? {
                // Wired into the engine's completion hook, which fires only when
                // the stream ended without throwing. A terminal error EVENT
                // (not a throw) still lands here — so surface `runFailed` so the
                // product skips billing an errored turn instead of marking it
                // complete with empty text.
                onTurnComplete: ({ identity: turnIdentity, finalText }: { identity: ChatTurnIdentity; finalText: string }) =>
                  options.onTurnComplete!({
                    identity: turnIdentity,
                    finalText,
                    context,
                    failed: runFailed,
                    ...(runFailed ? { failureReason: failureReasonOf(lastFailureData) } : {}),
                  }),
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
        controller.enqueue(encoder.encode(`${value.event}\n`))
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

  return {
    turn,
    replay,
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
