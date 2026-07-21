/**
 * Client-side chat-stream consumption — the NDJSON parse loop every agent
 * app's chat UI hand-rolls (and breaks). Normalizes the three line shapes the
 * agent-app chat routes emit:
 *
 *   {kind:'event', event:{type:'text'|'reasoning'|'tool_call'|'usage', ...}}
 *   {kind:'tool_result', toolCallId, toolName, label, outcome}
 *   {type:'turn'|'metadata'|'error'|'turn_status', ...}          (route-level)
 *   {type:'interaction', data:{request}}                         (sidecar ask)
 *
 * Replayed lines carry an extra `seq` — transparently ignored. Works for
 * router-backed and sandbox-backed chats alike: anything producing these
 * lines (live pump, queued follow, resume replay) feeds the same callbacks.
 */

import {
  interactionFromWireRequest,
  parseInteractionCancel,
  parseInteractionRequest,
  type ChatInteraction,
  type InteractionCancelData,
} from './chat-interactions'
import {
  parsePlanSubmittedEvent,
  persistedPartToPlan,
  type ChatPlan,
} from '../plans/index'

// The `/chat-routes` wire contract, re-exported for turn-body construction —
// `./chat-routes/wire` and `./chat-routes/file-index`'s response types are
// import-free and browser-safe by design.
export {
  chatTurnRequestInit,
  type ChatTurnFilePartInput,
  type ChatTurnPartInput,
  type ChatTurnRequestPayload,
  type FileMention,
  fileMentionsToParts,
  buildMentionPromptBlock,
  mediaTypeForMentionPath,
} from '../chat-routes/wire'
export {
  type FileIndexResponse,
  type FileIndexReadyResponse,
  type FileIndexWarmingResponse,
} from '../chat-routes/file-index'

export interface ChatStreamToolCall {
  toolCallId?: string
  toolName: string
  args: Record<string, unknown>
}

export interface ChatStreamToolResult {
  toolCallId?: string
  toolName?: string
  label?: string
  outcome: { ok: boolean; result?: unknown; code?: string; message?: string }
}

export interface ChatStreamCallbacks {
  onTurnId?: (turnId: string) => void
  onText?: (delta: string) => void
  onReasoning?: (delta: string) => void
  onToolCall?: (call: ChatStreamToolCall) => void
  onToolResult?: (result: ChatStreamToolResult) => void
  onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void
  onMetadata?: (data: Record<string, unknown>) => void
  /** A loop-level error event (the turn failed server-side). Optional, but the
   *  error never vanishes: when omitted, the message is synthesized into the
   *  transcript via `onText` (rendered by ChatMessages as a text segment) and
   *  logged with `console.error`. */
  onErrorEvent?: (message: string) => void
  /** A sidecar interaction ask (kind: "question"/"plan"/…). The run is BLOCKED
   *  in the broker until the user answers; a pending ask is "waiting on the
   *  user", not "model working". Optional — a consumer that doesn't wire it
   *  parses the same stream unchanged. */
  onInteraction?: (interaction: ChatInteraction) => void
  /** A terminal withdrawal/timeout for a previously emitted interaction. */
  onInteractionCancel?: (cancel: InteractionCancelData) => void
  /** A durable-plan snapshot from any plan lifecycle event. */
  onPlan?: (plan: ChatPlan) => void
}

export interface ConsumeChatStreamResult {
  turnId: string | null
  /** True when any text/reasoning/tool activity was received. */
  receivedContent: boolean
}

/** Parse one NDJSON line into the callbacks. Exposed for tests. */
export function dispatchChatStreamLine(line: string, cb: ChatStreamCallbacks): {
  turnId?: string
  receivedContent: boolean
} {
  let receivedContent = false
  let turnId: string | undefined
  if (!line.trim()) return { receivedContent }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(line) as Record<string, unknown>
  } catch {
    return { receivedContent } // tolerate a torn line
  }

  if (parsed.kind === 'tool_result') {
    cb.onToolResult?.({
      toolCallId: parsed.toolCallId as string | undefined,
      toolName: parsed.toolName as string | undefined,
      label: parsed.label as string | undefined,
      outcome: (parsed.outcome ?? parsed.result) as ChatStreamToolResult['outcome'],
    })
    return { receivedContent: true }
  }

  const evt = (parsed.kind === 'event' ? parsed.event : parsed) as Record<string, unknown>
  if (!evt || typeof evt !== 'object') return { receivedContent }

  switch (evt.type) {
    case 'turn':
      if (typeof evt.turnId === 'string') turnId = evt.turnId
      break
    case 'text':
      if (typeof evt.text === 'string') {
        cb.onText?.(evt.text)
        receivedContent = true
      }
      break
    case 'reasoning':
      if (typeof evt.text === 'string') {
        cb.onReasoning?.(evt.text)
        receivedContent = true
      }
      break
    case 'tool_call': {
      const call = (evt.call ?? evt) as Record<string, unknown>
      cb.onToolCall?.({
        toolCallId: (call.toolCallId ?? call.id) as string | undefined,
        toolName: String(call.toolName ?? call.name ?? 'unknown'),
        args: (call.args ?? {}) as Record<string, unknown>,
      })
      receivedContent = true
      break
    }
    case 'tool_result':
      cb.onToolResult?.({
        toolCallId: evt.toolCallId as string | undefined,
        toolName: evt.toolName as string | undefined,
        label: evt.label as string | undefined,
        outcome: (evt.outcome ?? evt.result) as ChatStreamToolResult['outcome'],
      })
      receivedContent = true
      break
    case 'usage': {
      const u = evt.usage as { promptTokens?: number; completionTokens?: number } | undefined
      if (u) cb.onUsage?.({ promptTokens: u.promptTokens ?? 0, completionTokens: u.completionTokens ?? 0 })
      break
    }
    case 'metadata':
      cb.onMetadata?.((evt.data ?? {}) as Record<string, unknown>)
      break
    case 'interaction': {
      // The run is now BLOCKED in the sidecar broker until this ask is
      // answered, withdrawn, or times out. Validate the shape and surface the
      // parsed ChatInteraction; a malformed ask is logged and skipped rather
      // than half-surfaced.
      const parsed = parseInteractionRequest(evt.data as Record<string, unknown> | undefined)
      if (parsed.succeeded) {
        cb.onInteraction?.(interactionFromWireRequest(parsed.value))
        receivedContent = true
      } else {
        console.error('[chat-stream] dropping malformed interaction line:', parsed.error)
      }
      break
    }
    case 'interaction.cancel': {
      const cancelled = parseInteractionCancel(evt.data as Record<string, unknown> | undefined)
      if (cancelled.succeeded) {
        cb.onInteractionCancel?.(cancelled.value)
        receivedContent = true
      } else {
        console.error('[chat-stream] dropping malformed interaction.cancel line:', cancelled.error)
      }
      break
    }
    case 'error': {
      // The sandbox lane sends the reason as `{ type: 'error', data: { message } }`
      // (mirrored by `session.run.failed`); older/edge lanes use a top-level
      // `details`/`error`. Read `data.message` FIRST so a real failure surfaces
      // to the operator instead of the useless "Unknown stream error".
      const data = evt.data as { message?: string } | undefined
      const message = String(data?.message ?? evt.details ?? evt.error ?? 'Unknown stream error')
      if (cb.onErrorEvent) {
        cb.onErrorEvent(message)
      } else {
        // Fail loud when the consumer wired no onErrorEvent: a turn that fails
        // server-side must not end as a silent empty answer. Synthesize the
        // error into the transcript through the text channel (it lands as a
        // text segment ChatMessages renders) and log it — the app that forgot
        // the callback still shows the user an error row.
        console.error('[chat-stream] unhandled stream error event:', message)
        cb.onText?.(`\n\nThe agent hit an error and this turn stopped: ${message}`)
        receivedContent = true
      }
      break
    }
    default: {
      if (typeof evt.type === 'string' && evt.type.startsWith('plan.')) {
        const submitted = parsePlanSubmittedEvent(evt)
        const planRecord = (
          (evt.data as Record<string, unknown> | undefined)?.plan ??
          (evt.properties as Record<string, unknown> | undefined)?.plan
        ) as Record<string, unknown> | undefined
        const plan = submitted.succeeded
          ? submitted.value
          : planRecord ? persistedPartToPlan({ type: 'plan', ...planRecord }) : null
        if (plan) {
          cb.onPlan?.(plan)
          receivedContent = true
        } else {
          console.error('[chat-stream] dropping malformed durable plan line:', evt.type)
        }
      }
      break // turn_status and unknown line types are non-content
    }
  }
  return { turnId, receivedContent }
}

/** Drain one NDJSON body into the callbacks. Throws on transport failure
 *  (caller decides whether to resume). */
export async function consumeChatStream(
  body: ReadableStream<Uint8Array>,
  cb: ChatStreamCallbacks,
): Promise<ConsumeChatStreamResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let turnId: string | null = null
  let receivedContent = false

  const handle = (line: string) => {
    const r = dispatchChatStreamLine(line, cb)
    if (r.turnId) {
      turnId = r.turnId
      cb.onTurnId?.(r.turnId)
    }
    if (r.receivedContent) receivedContent = true
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      if (buffer.trim()) handle(buffer)
      break
    }
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) handle(line)
  }
  return { turnId, receivedContent }
}

export interface StreamChatOptions {
  /** Start the turn (POST the chat request); must return a streaming Response. */
  start: () => Promise<Response>
  /** Re-attach to a turn after a transport drop (GET the resume route). */
  resume?: (turnId: string, fromSeq: number) => Promise<Response>
  callbacks: ChatStreamCallbacks
  /** Called before a resume replays from 0 so the UI can reset accumulated
   *  turn state (text, reasoning, tool chips). */
  onResetForResume?: () => void
}

/**
 * Run one chat turn with automatic single-shot resume: if the transport drops
 * mid-turn and the server announced a turnId, reset and replay the buffered
 * turn. Server-side the turn keeps running either way (queued runner).
 */
export async function streamChatTurn(opts: StreamChatOptions): Promise<ConsumeChatStreamResult> {
  const res = await opts.start()
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string }
    throw new Error(err.error ?? `HTTP ${res.status}`)
  }
  let turnId: string | null = null
  const cb: ChatStreamCallbacks = {
    ...opts.callbacks,
    onTurnId: (id) => {
      turnId = id
      opts.callbacks.onTurnId?.(id)
    },
  }
  try {
    return await consumeChatStream(res.body, cb)
  } catch (transportErr) {
    if (!turnId || !opts.resume) throw transportErr
    opts.onResetForResume?.()
    const resumed = await opts.resume(turnId, 0)
    if (!resumed.ok || !resumed.body) throw transportErr
    return await consumeChatStream(resumed.body, cb)
  }
}
