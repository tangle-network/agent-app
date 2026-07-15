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
  /** Pre-persist transform of the final text (e.g. `/redact`'s `redactPII`).
   *  Live stream is never altered. */
  transformFinalText?(text: string): string | Promise<string>
  /** Post-processing after a successful turn (billing, titles, audit). Errors
   *  are swallowed by the engine — they never fail a streamed turn. */
  onTurnComplete?(input: { identity: ChatTurnIdentity; finalText: string; context: TContext }): Promise<void>
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

    if (chatTurn.shouldInsertUserMessage) {
      await options.store.appendMessage({
        threadId: payload.threadId,
        role: 'user',
        content,
        parts: userPartsWithFiles(chatTurn.userParts, fileParts),
      })
    }

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

    let producer: ChatTurnRouteProducer | undefined
    let runFailed = false

    const result = handleChatTurn({
      identity,
      waitUntil: ctx?.waitUntil,
      log,
      hooks: {
        // The engine wants a synchronous producer; box resolution is async —
        // defer it into the generator's first pull.
        produce: () => ({
          stream: (async function* () {
            producer = await options.produce({
              request,
              body: payload,
              identity,
              context,
              prompt,
              executionId,
              turnStreamId,
              priorMessages: chatTurn.priorMessages,
            })
            for await (const event of producer.stream) yield event
          })(),
          finalText: () => producer?.finalText() ?? '',
        }),
        onEvent: async (event) => {
          if (event.type === 'session.run.failed' || event.type === 'error') runFailed = true
          await tap.onEvent(event)
          if (options.onEvent) await options.onEvent(event, context)
        },
        ...(options.transformFinalText ? { transformFinalText: options.transformFinalText } : {}),
        persistAssistantMessage: async ({ finalText }) => {
          // The typed boundary: stream-normalizer records → stored vocabulary
          // (validating projection owned by /chat-store — no cast here).
          const parts = producer?.assistantParts ? toChatMessageParts(producer.assistantParts()) : undefined
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
              onTurnComplete: ({ identity: turnIdentity, finalText }: { identity: ChatTurnIdentity; finalText: string }) =>
                options.onTurnComplete!({ identity: turnIdentity, finalText, context }),
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
      try {
        for (;;) {
          const { done } = await reader.read()
          if (done) break
        }
        await tap.done(runFailed ? 'error' : 'complete')
      } catch (err) {
        await tap.done('error')
        log('[chat-routes] turn drain failed', {
          turnId: turnStreamId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
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
