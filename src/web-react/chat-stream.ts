/**
 * Client-side chat-stream consumption — the NDJSON parse loop every agent
 * app's chat UI hand-rolls (and breaks). Normalizes the three line shapes the
 * agent-app chat routes emit:
 *
 *   {kind:'event', event:{type:'text'|'reasoning'|'tool_call'|'usage'|'notice'|'error', ...}}
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
import {
  isTurnIntentEvent,
  isTurnPhaseEvent,
  settleTurnResponse,
  TURN_INTENT_EVENT,
  TURN_PHASE_EVENT,
  type TurnIntentData,
  type TurnPhaseData,
} from '../chat-routes/turn-progress'

// The `/chat-routes` wire contract, re-exported for turn-body construction —
// `./chat-routes/wire` and `./chat-routes/file-index`'s response types are
// import-free and browser-safe by design.
export {
  chatTurnRequestInit,
  type ChatTurnFilePartInput,
  type ChatTurnPartInput,
  type ChatTurnRequestPayload,
  type ProducerTextEvent,
  type ProducerReasoningEvent,
  type ProducerToolCallEvent,
  type ProducerToolResultEvent,
  type ProducerUsageEvent,
  type ProducerNoticeEvent,
  type ProducerErrorEvent,
  type ProducerPassthroughEventType,
  type ProducerPassthroughEvent,
  type ProducerWireEvent,
  type FileMention,
  fileMentionsToParts,
  buildMentionPromptBlock,
  mediaTypeForMentionPath,
  mentionKindForPath,
  type ChatAttachmentKind,
  type ChatAttachmentInput,
  DISPATCH_REQUEST_MAX_BYTES,
  DISPATCH_STRUCTURAL_RESERVE_BYTES,
  DISPATCH_MAX_PARTS,
  DISPATCH_MAX_MEDIA_PARTS,
  base64WireLen,
} from '../chat-routes/wire'

export {
  buildTurnPhaseEvent,
  isTurnIntentEvent,
  isTurnPhaseEvent,
  settleTurnResponse,
  TURN_INTENT_EVENT,
  TURN_PHASE_EVENT,
  TURN_PROGRESS_FIRST,
  TURN_PROGRESS_HEADER,
  TURN_RESPONSE_EVENT,
  TURN_ROUTE_PHASE_MESSAGES,
  TURN_STREAM_LOST_CODE,
  type TurnIntentData,
  type TurnIntentEvent,
  type TurnPhaseData,
  type TurnPhaseEvent,
  type TurnResponseData,
  type TurnRoutePhase,
} from '../chat-routes/turn-progress'
export {
  type FileIndexResponse,
  type FileIndexReadyResponse,
  type FileIndexWarmingResponse,
} from '../chat-routes/file-index'

/** Define the structure for a chat tool call including optional ID, name, and arguments object */
export interface ChatStreamToolCall {
  toolCallId?: string
  toolName: string
  args: Record<string, unknown>
}

/** Describe the result of a chat stream tool including its outcome and optional metadata fields */
export interface ChatStreamToolResult {
  toolCallId?: string
  toolName?: string
  label?: string
  outcome: { ok: boolean; result?: unknown; code?: string; message?: string }
}

/** Define callbacks to handle events and data during a chat streaming session */
export interface ChatStreamCallbacks {
  onTurnId?: (turnId: string) => void
  /** The turn's current stage (`session.run.phase`), before its first output and between tool calls. */
  onPhase?: (phase: TurnPhaseData) => void
  /** The turn's intent line (`session.run.intent`): show it as a labeled status line until the first `onText`. */
  onIntent?: (intent: TurnIntentData) => void
  onText?: (delta: string) => void
  /** A responder of a turn addressed to several agents, announced before any
   *  output; every responder is announced up front, in mention order. Open one
   *  live block per responder. A responder that ended is announced again with
   *  its `state`; update its block by `id`. */
  onSpeaker?: (speaker: { id: string; name: string; handle?: string; state?: 'done' | 'failed' }) => void
  /** Fires before the callback of every event that carries `speaker` (the
   *  responder's agent id): responders answer at the same time, so the text,
   *  reasoning and tool events of several interleave and this says whose
   *  block each belongs to. A consumer that applies raw events reads
   *  `event.speaker` itself. */
  onSpeakerEvent?: (speaker: string) => void
  onReasoning?: (delta: string) => void
  /** The message's reasoning so far, when it started and when it ended, after every reasoning delta and once
   *  when thinking ends. Spread it onto `ReasoningRow`. `consumeChatStream` and `streamChatTurn` keep it;
   *  a consumer that calls `dispatchChatStreamLine` itself wraps its callbacks with `trackChatReasoning`. */
  onReasoningState?: (state: ChatReasoningState) => void
  onToolCall?: (call: ChatStreamToolCall) => void
  onToolResult?: (result: ChatStreamToolResult) => void
  onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void
  onNotice?: (notice: { id: string; noticeKind: 'warning' | 'auto-declined' | 'error'; text: string }) => void
  onMetadata?: (data: Record<string, unknown>) => void
  /** Structured detail from a loop-level error event. Fired alongside the
   *  legacy string-only `onErrorEvent` callback. */
  onErrorEventDetail?: (detail: {
    message: string
    code?: string
    details?: Record<string, unknown>
  }) => void
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

/**
 * One message's reasoning as the stream delivers it: the text so far, when the
 * model started reasoning and when it stopped. Its fields are `ReasoningRow`'s
 * props. Live state comes from `onReasoningState`; a saved message's comes from
 * `chatReasoningFromParts`.
 */
export interface ChatReasoningState {
  text: string
  /** Epoch ms of the first reasoning delta. Absent only on history saved without times. */
  startedAt?: number
  /** Epoch ms the reasoning ended: the answer's first text, an error, or the end of the turn. */
  endedAt?: number
  /** Reasoning deltas are still arriving and nothing has ended them yet. */
  thinking: boolean
}

/** Callbacks that keep the turn's reasoning state, plus the two moments only the transport knows. */
export type TrackedChatStreamCallbacks = ChatStreamCallbacks & {
  /** The turn's stream is over, or failed for good: thinking that is still open ends now. */
  end: () => void
  /** The stream will replay the turn from its first event (a resume from 0): the text is rebuilt from the
   *  replay, and the start time of the first delta is kept, so "Thought for N seconds" still counts from it. */
  replay: () => void
}

/** Callbacks `trackChatReasoning` returned, so `consumeChatStream` uses their state instead of starting another. */
const trackedCallbacks = new WeakSet<ChatStreamCallbacks>()

/**
 * Keep one turn's reasoning state from its stream: the first reasoning delta
 * starts the clock, the answer's first text, an error or `end()` stops it, and
 * every change reaches `callbacks.onReasoningState`. Reasoning that resumes
 * after a tool call or an answer continues the same state as a new paragraph,
 * the way a reload joins the turn's saved reasoning parts.
 *
 * It takes callbacks, not a stream, so it is the entry point for any
 * transport: `streamChatTurn` and `consumeChatStream` apply it themselves; an
 * app that dispatches lines one at a time (`dispatchChatStreamLine`) or reads
 * its own frames (a Durable Object's live parts, server-side events) wraps its
 * handlers with it, feeds `onReasoning` / `onText` / `onToolCall`, and calls
 * `end()` when its stream closes.
 */
export function trackChatReasoning(callbacks: ChatStreamCallbacks, now: () => number = Date.now): TrackedChatStreamCallbacks {
  let state: ChatReasoningState | null = null
  let paragraph = false
  // A replay rebuilds the text; the first delta's time survives it.
  let replayedFrom: number | undefined
  const publish = (next: ChatReasoningState) => {
    state = next
    callbacks.onReasoningState?.(next)
  }
  const stop = () => {
    if (state?.thinking) publish({ ...state, endedAt: now(), thinking: false })
  }
  const tracked: TrackedChatStreamCallbacks = {
    ...callbacks,
    onReasoning: (delta) => {
      callbacks.onReasoning?.(delta)
      if (!delta) return
      if (!state) {
        publish({ text: delta, startedAt: replayedFrom ?? now(), thinking: true })
      } else {
        const joined = (paragraph || !state.thinking) && state.text.trim()
          ? `${state.text.trimEnd()}\n\n${delta.trimStart()}`
          : state.text + delta
        publish({ text: joined, ...(state.startedAt !== undefined ? { startedAt: state.startedAt } : {}), thinking: true })
      }
      paragraph = false
    },
    onText: (delta) => {
      if (delta) stop()
      callbacks.onText?.(delta)
    },
    onToolCall: (call) => {
      // The model acted; any reasoning after this is its next thought.
      if (state) paragraph = true
      callbacks.onToolCall?.(call)
    },
    onErrorEventDetail: (detail) => {
      stop()
      callbacks.onErrorEventDetail?.(detail)
    },
    end: stop,
    replay: () => {
      replayedFrom = state?.startedAt ?? replayedFrom
      state = null
      paragraph = false
    },
  }
  trackedCallbacks.add(tracked)
  return tracked
}

/**
 * A saved message's reasoning, settled, from its persisted parts: every
 * `{ type: 'reasoning', text, time }` part joined in order, from the first
 * part's start to the last part's end. A reload shows it collapsed with how
 * long the model thought. Undefined when the message has no reasoning text.
 */
export function chatReasoningFromParts(parts: ReadonlyArray<unknown> | null | undefined): ChatReasoningState | undefined {
  const runs = (parts ?? []).filter((part): part is { text: string; time?: unknown } => {
    const record = part as Record<string, unknown> | null
    return record?.type === 'reasoning' && typeof record.text === 'string' && record.text.trim() !== ''
  })
  if (runs.length === 0) return undefined
  const times = runs.map((run) => (run.time && typeof run.time === 'object' ? run.time : {}) as { start?: unknown; end?: unknown })
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
  const starts = times.map((time) => time.start).filter(finite)
  const ends = times.map((time) => time.end).filter(finite)
  const startedAt = starts.length > 0 ? Math.min(...starts) : undefined
  const endedAt = ends.length > 0 ? Math.max(...ends) : undefined
  return {
    text: runs.map((run) => run.text.trim()).join('\n\n'),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt ? { endedAt } : {}),
    thinking: false,
  }
}

/** Represent the result of consuming a chat stream including turn ID and content reception status */
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
  if (evt.type !== 'speaker' && typeof evt.speaker === 'string') cb.onSpeakerEvent?.(evt.speaker)

  switch (evt.type) {
    case 'turn':
      if (typeof evt.turnId === 'string') turnId = evt.turnId
      break
    case TURN_PHASE_EVENT:
      if (isTurnPhaseEvent(evt)) cb.onPhase?.(evt.data)
      break
    case TURN_INTENT_EVENT:
      if (isTurnIntentEvent(evt)) cb.onIntent?.(evt.data)
      break
    case 'text':
      if (typeof evt.text === 'string') {
        cb.onText?.(evt.text)
        receivedContent = true
      }
      break
    case 'speaker':
      if (typeof evt.id === 'string' && typeof evt.name === 'string') {
        cb.onSpeaker?.({
          id: evt.id, name: evt.name,
          ...(typeof evt.handle === 'string' ? { handle: evt.handle } : {}),
          ...(evt.state === 'done' || evt.state === 'failed' ? { state: evt.state } : {}),
        })
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
    case 'notice': {
      if (
        typeof evt.id === 'string' &&
        (evt.noticeKind === 'warning' || evt.noticeKind === 'auto-declined' || evt.noticeKind === 'error') &&
        typeof evt.text === 'string'
      ) {
        cb.onNotice?.({ id: evt.id, noticeKind: evt.noticeKind, text: evt.text })
        receivedContent = true
      }
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
      const data = evt.data as {
        message?: string
        code?: string
        details?: Record<string, unknown>
      } | undefined
      const message = String(data?.message ?? evt.details ?? evt.error ?? 'Unknown stream error')
      cb.onErrorEventDetail?.({
        message,
        ...(typeof data?.code === 'string' ? { code: data.code } : {}),
        ...(data?.details && typeof data.details === 'object' ? { details: data.details } : {}),
      })
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
  // Callbacks already tracked (by `streamChatTurn`, across a resume) keep their state; otherwise this
  // stream owns one and settles it when the stream closes or fails.
  const owned = !trackedCallbacks.has(cb) && cb.onReasoningState ? trackChatReasoning(cb) : null
  const callbacks = owned ?? cb

  const handle = (line: string) => {
    const r = dispatchChatStreamLine(line, callbacks)
    if (r.turnId) {
      turnId = r.turnId
      cb.onTurnId?.(r.turnId)
    }
    if (r.receivedContent) receivedContent = true
  }

  try {
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
  } finally {
    owned?.end()
  }
  return { turnId, receivedContent }
}

/** Define options for managing and resuming streaming chat interactions with callbacks */
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
  // A progress-first response answers refusals in-stream; settle it into the response it stands for.
  const res = await settleTurnResponse(await opts.start(), (phase) => opts.callbacks.onPhase?.(phase))
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string }
    throw new Error(err.error ?? `HTTP ${res.status}`)
  }
  // Headers arrive before the body, so a reset before the marker still has a
  // replay id. The body marker remains authoritative when it arrives.
  let turnId: string | null = res.headers.get('x-turn-id')?.trim() || null
  const withTurnId: ChatStreamCallbacks = {
    ...opts.callbacks,
    onTurnId: (id) => {
      turnId = id
      opts.callbacks.onTurnId?.(id)
    },
  }
  // One reasoning state for the whole turn, across a resume, so a reconnect
  // neither duplicates the reasoning nor restarts its clock.
  const tracked = opts.callbacks.onReasoningState ? trackChatReasoning(withTurnId) : null
  const cb = tracked ?? withTurnId
  try {
    try {
      return await consumeChatStream(res.body, cb)
    } catch (transportErr) {
      if (!turnId || !opts.resume) throw transportErr
      opts.onResetForResume?.()
      tracked?.replay()
      const resumed = await opts.resume(turnId, 0)
      if (!resumed.ok || !resumed.body) throw transportErr
      return await consumeChatStream(resumed.body, cb)
    }
  } finally {
    tracked?.end()
  }
}
