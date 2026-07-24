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

import {
  cancelStatusFor,
  interactionPartKey,
  interactionToPersistedPart,
  isRenderableInteractionKind,
  noticePart,
  noticePartKey,
  parseInteractionCancel,
  parseInteractionRequest,
} from '../interactions/contract'
import {
  parsePlanSubmittedEvent,
  planToPersistedPart,
} from '../plans/index'
import {
  asRecord,
  asString,
  finalizeAssistantParts,
  finalizePendingInteractionParts,
  getPartKey,
  mergePersistedPart,
  normalizePersistedPart,
  normalizeToolEvent,
  terminalizeDanglingAssistantToolUpdates,
  type JsonRecord,
  type StreamEvent,
} from '../stream/index'
import type { ChatTurnRouteProducer, ChatTurnUsage } from './turn-routes'
import type { ProducerWireEvent } from './wire'

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
export type FilePartPromotionOutcome =
  | { succeeded: true; part: Record<string, unknown>; key?: string }
  | { succeeded: false; reason: string; part?: Record<string, unknown>; key?: string }

/** Define options for producing sandbox chat events with rendering and interaction controls */
export interface SandboxChatProducerOptions {
  /** The raw sandbox event stream (e.g. `streamSandboxPrompt(...)`). */
  events: AsyncIterable<unknown>
  /** Recorded on the persisted assistant message. */
  model?: string
  /** Which ask kinds the product renders a card for. Anything else is
   *  auto-declined (see `declineInteraction`) so the run never hangs in the
   *  broker waiting on a card no client will show. Default: question/plan.
   *  Products with per-turn plan mode can close over it without another option:
   *  `(kind) => kind === 'question' || (kind === 'plan' && planEnabled)`. */
  isRenderableInteraction?: (kind: string) => boolean
  /** Resolve a non-renderable ask (wire `respondToSessionInteraction` with the
   *  session's sidecar connection). Without it, a failure notice is emitted and
   *  the run stays blocked until the broker times out. */
  declineInteraction?: (id: string) => Promise<void>
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
  promoteFilePart?: (raw: JsonRecord) => Promise<FilePartPromotionOutcome>
  log?: (message: string, meta?: Record<string, unknown>) => void
}

interface TextTracker {
  /** Full accumulated text per part key, to derive suffix deltas from
   *  snapshot-only harness events. */
  seen: Map<string, string>
}

/** Delta to emit for one text/reasoning part update: prefer the harness's
 *  explicit delta; otherwise diff the snapshot against what was already
 *  emitted for that part (snapshot-only harnesses re-send the whole text). */
function textDelta(tracker: TextTracker, key: string, part: JsonRecord, rawDelta: unknown): string {
  const explicit = typeof rawDelta === 'string' ? rawDelta : undefined
  const previous = tracker.seen.get(key) ?? ''
  if (explicit !== undefined) {
    tracker.seen.set(key, previous + explicit)
    return explicit
  }
  const snapshot = asString(part.text) ?? asString(part.content) ?? ''
  if (!snapshot) return ''
  if (snapshot.startsWith(previous)) {
    tracker.seen.set(key, snapshot)
    return snapshot.slice(previous.length)
  }
  // The snapshot replaced the text outright — emit it whole; the persisted
  // projection stays correct because finalText is authoritative at finalize.
  tracker.seen.set(key, snapshot)
  return snapshot
}

function usageFromStepFinish(part: JsonRecord, usage: ChatTurnUsage): void {
  const tokens = asRecord(part.tokens)
  if (tokens) {
    const cache = asRecord(tokens.cache)
    const add = (current: number | undefined, value: unknown): number | undefined => {
      const n = Number(value)
      if (!Number.isFinite(n)) return current
      return (current ?? 0) + n
    }
    usage.inputTokens = add(usage.inputTokens, tokens.input)
    usage.outputTokens = add(usage.outputTokens, tokens.output)
    usage.reasoningTokens = add(usage.reasoningTokens, tokens.reasoning)
    if (cache) {
      usage.cacheReadTokens = add(usage.cacheReadTokens, cache.read)
      usage.cacheWriteTokens = add(usage.cacheWriteTokens, cache.write)
    }
  }
  const cost = Number(part.cost)
  if (Number.isFinite(cost)) usage.costUsd = (usage.costUsd ?? 0) + cost
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** Parse authoritative usage from a terminal sandbox `result` or `done`. */
function extractReportedTurnUsage(data: JsonRecord | null | undefined): ChatTurnUsage | null {
  const tokenUsage = asRecord(data?.tokenUsage)
  if (!tokenUsage) return null

  const inputTokens = toFiniteNumber(tokenUsage.inputTokens)
  const outputTokens = toFiniteNumber(tokenUsage.outputTokens)
  if (inputTokens === null || outputTokens === null) return null

  const reported: ChatTurnUsage = { inputTokens, outputTokens }
  const reasoningTokens = toFiniteNumber(tokenUsage.reasoningTokens)
  if (reasoningTokens !== null) reported.reasoningTokens = reasoningTokens
  const cacheReadTokens = toFiniteNumber(tokenUsage.cacheReadInputTokens)
  if (cacheReadTokens !== null) reported.cacheReadTokens = cacheReadTokens
  const cacheWriteTokens = toFiniteNumber(tokenUsage.cacheCreationInputTokens)
  if (cacheWriteTokens !== null) reported.cacheWriteTokens = cacheWriteTokens
  const costUsd = toFiniteNumber(data?.totalCostUsd) ?? toFiniteNumber(tokenUsage.cost)
  if (costUsd !== null) reported.costUsd = costUsd
  return reported
}

function applyTerminalUsage(reported: ChatTurnUsage, usage: ChatTurnUsage): void {
  usage.inputTokens = reported.inputTokens
  usage.outputTokens = reported.outputTokens
  if (reported.reasoningTokens !== undefined) usage.reasoningTokens = reported.reasoningTokens
  if (reported.cacheReadTokens !== undefined) usage.cacheReadTokens = reported.cacheReadTokens
  if (reported.cacheWriteTokens !== undefined) usage.cacheWriteTokens = reported.cacheWriteTokens
  if (reported.costUsd !== undefined) usage.costUsd = reported.costUsd
}

function sandboxStreamErrorMessage(data: unknown): string {
  const record = asRecord(data)
  const message = asString(record?.message) ?? asString(record?.error)
  if (message) return message
  try {
    return JSON.stringify(data) || 'Sandbox stream returned an error event without details.'
  } catch {
    return 'Sandbox stream returned an error event without details.'
  }
}

function toProducerWireEvent(event: JsonRecord): ProducerWireEvent {
  return event as unknown as ProducerWireEvent
}

function sandboxStreamFailureDiagnostic(error: unknown): {
  userMessage: string
  failureNote: string
} {
  const streamMessage = (error as { streamMessage?: unknown })?.streamMessage
  const message = typeof streamMessage === 'string'
    ? streamMessage
    : error instanceof Error ? error.message : 'Sandbox stream failed'
  const diagnostics = asRecord((error as { diagnostics?: unknown })?.diagnostics)
  let diagnosticText: string | undefined
  if (diagnostics) {
    try {
      diagnosticText = JSON.stringify(diagnostics)
    } catch {
      diagnosticText = '[unserializable diagnostics]'
    }
  }
  const userMessage = [
    'The sandbox model stream stopped before a clean completion.',
    `Error: ${message}`,
    'Please retry. If it repeats, send these support details to the team.',
  ].join('\n\n')
  const failureNote = diagnosticText
    ? `sandbox-stream: ${message}; ${diagnosticText}`
    : `sandbox-stream: ${message}`
  return { userMessage, failureNote }
}

/** Create a sandbox chat producer that manages chat turn routing with logging and interaction rendering options */
export function createSandboxChatProducer(options: SandboxChatProducerOptions): ChatTurnRouteProducer {
  const log = options.log ?? ((message, meta) => console.error(message, meta ?? ''))
  const renderable = options.isRenderableInteraction ?? isRenderableInteractionKind

  let fullText = ''
  const partOrder: string[] = []
  const partMap = new Map<string, JsonRecord>()
  const tracker: TextTracker = { seen: new Map() }
  const usage: ChatTurnUsage = {}
  /** Tool ids already announced as `tool_call` / settled as `tool_result`. */
  const announcedTools = new Set<string>()
  const settledTools = new Set<string>()
  /** Id-less step boundaries: one occurrence per key, never merged. */
  let stepCounter = 0
  let danglingToolsTerminalized = false
  let interactionOutcome: 'answered' | 'expired' = 'answered'
  let warningCount = 0
  /** `promoteFilePart` memo, keyed by `id ?? url` of the raw part. Holds the
   *  PROMISE (never the settled result) so concurrent duplicate events for
   *  the same part await the one in-flight attempt instead of each starting
   *  their own; the promise never rejects (see below), so a later duplicate
   *  reading a settled entry reuses that first outcome — success or
   *  failure — rather than retrying. */
  const promotedFileParts = new Map<string, Promise<FilePartPromotionOutcome>>()

  function recordPersistedPart(part: JsonRecord, delta: string | undefined, keyOverride?: string): void {
    const persisted = normalizePersistedPart(part)
    if (!persisted) return
    const key = keyOverride ?? getPartKey(persisted)
    if (!partMap.has(key)) partOrder.push(key)
    partMap.set(key, mergePersistedPart(partMap.get(key), persisted, delta))
  }

  function* emitTerminalizedTools(): Generator<ProducerWireEvent, void, unknown> {
    if (danglingToolsTerminalized) return
    danglingToolsTerminalized = true
    const updates = terminalizeDanglingAssistantToolUpdates(partOrder, partMap, fullText)
    for (const part of updates) {
      const toolId = asString(part.id)
      if (!toolId || settledTools.has(toolId)) continue
      settledTools.add(toolId)
      const state = asRecord(part.state)
      yield {
        type: 'tool_result',
        toolCallId: toolId,
        toolName: asString(part.tool) ?? 'tool',
        outcome: {
          ok: false,
          ...(asString(state?.error) ? { message: asString(state?.error) } : {}),
        },
      }
    }
  }

  function* emitFinalUsage(): Generator<ProducerWireEvent, void, unknown> {
    const promptTokens = usage.inputTokens ?? 0
    const completionTokens = usage.outputTokens ?? 0
    if (promptTokens || completionTokens) {
      yield { type: 'usage', usage: { promptTokens, completionTokens } }
    }
  }

  async function* stream(): AsyncGenerator<ProducerWireEvent, void, unknown> {
    try {
      for await (const raw of options.events) {
        const record = asRecord(raw)
        if (!record || typeof record.type !== 'string') continue
        // Fold bare tool_call/tool_result shapes into the canonical part event;
        // everything else keeps its original record (verbatim forwarding must
        // not strip fields outside `data`).
        const normalized = normalizeToolEvent({ type: record.type, data: asRecord(record.data) })
        const event: StreamEvent = normalized.type === 'message.part.updated'
          ? normalized
          : { type: record.type, data: asRecord(record.data) }

        if (event.type === 'message.part.updated') {
          const part = asRecord(event.data?.part)
          if (!part) continue
          const rawDelta = event.data?.delta
          const partType = String(part.type ?? '')

          if (partType === 'text' || partType === 'reasoning') {
            const key = getPartKey(part)
            const delta = textDelta(tracker, key, part, rawDelta)
            recordPersistedPart(part, delta || undefined)
            if (delta) {
              if (partType === 'text') fullText += delta
              yield { type: partType, text: delta }
            }
            continue
          }

          if (partType === 'tool') {
            recordPersistedPart(part, undefined)
            const persisted = partMap.get(getPartKey(part))
            const state = asRecord(persisted?.state)
            const toolId = String(persisted?.id ?? '')
            const toolName = String(persisted?.tool ?? 'tool')
            if (toolId && !announcedTools.has(toolId)) {
              announcedTools.add(toolId)
              yield {
                type: 'tool_call',
                call: { toolCallId: toolId, toolName, args: asRecord(state?.input) ?? {} },
              }
            }
            const status = String(state?.status ?? '')
            if (toolId && (status === 'completed' || status === 'error') && !settledTools.has(toolId)) {
              settledTools.add(toolId)
              yield {
                type: 'tool_result',
                toolCallId: toolId,
                toolName,
                outcome: {
                  ok: status === 'completed',
                  ...(state?.output !== undefined ? { result: state.output } : {}),
                  ...(asString(state?.error) ? { message: asString(state?.error) } : {}),
                },
              }
            }
            continue
          }

          if (partType === 'step-finish') {
            usageFromStepFinish(part, usage)
            // Persist the per-step receipt too (unique key per occurrence: the
            // parts have no id and two receipts must never merge into one).
            recordPersistedPart(part, undefined, `step-finish:#${stepCounter++}`)
            const promptTokens = usage.inputTokens ?? 0
            const completionTokens = usage.outputTokens ?? 0
            if (promptTokens || completionTokens) {
              yield { type: 'usage', usage: { promptTokens, completionTokens } }
            }
            continue
          }

          if (partType === 'step-start') {
            recordPersistedPart(part, undefined, `step-start:#${stepCounter}`)
            continue
          }

          if (partType === 'file' && options.promoteFilePart) {
            const promote = options.promoteFilePart
            // Prefixed by source (`id:`/`url:`) rather than the bare raw string —
            // an `id` and a `url` that happen to share the same text (e.g. both
            // `"abc"`) would otherwise collide onto one memo entry and fold two
            // unrelated parts' promotions together. Internal Map key only; never
            // observable outside this module.
            const rawId = asString(part.id)
            const rawUrl = asString(part.url)
            const memoKey = rawId ? `id:${rawId}` : rawUrl ? `url:${rawUrl}` : undefined
            // Always invoke the callback for a `file` part when one is wired —
            // gtm never skips promotion outright, even for a part with neither
            // `id` nor `url` (it simply fails "carries no url" and resolves
            // through the ordinary failure path). Memoization by PROMISE only
            // applies when there is something to key it on; keyless parts are
            // invoked un-memoized, once per occurrence.
            //
            // `Promise.resolve().then(...)` (rather than calling `promote(part)`
            // directly) so a SYNC throw from a non-async `promoteFilePart` is
            // captured into the promise chain instead of escaping this function
            // call outright — `.catch` below only ever sees a rejection, never a
            // thrown exception that unwinds past `attempt()`.
            const attempt = (): Promise<FilePartPromotionOutcome> =>
              Promise.resolve()
                .then(() => promote(part))
                .catch((err) => {
                  const reason = err instanceof Error ? err.message : String(err)
                  log('[chat-routes] file part promotion threw', { key: memoKey ?? '(keyless)', error: reason })
                  return { succeeded: false as const, reason }
                })

            let pending: Promise<FilePartPromotionOutcome>
            if (memoKey) {
              pending = promotedFileParts.get(memoKey) ?? attempt()
              promotedFileParts.set(memoKey, pending)
            } else {
              pending = attempt()
            }

            const outcome = await pending
            if (outcome.succeeded) {
              recordPersistedPart(outcome.part, undefined, outcome.key)
            } else if (outcome.part) {
              // Substitute part (e.g. a warning notice) takes the raw part's
              // place in the transcript — the transient url never lands.
              recordPersistedPart(outcome.part, undefined, outcome.key)
            } else {
              recordPersistedPart(part, undefined)
            }
            continue
          }

          // Remaining storable kinds (file/image/subtask) have no live
          // vocabulary line; they persist so the transcript keeps them.
          recordPersistedPart(part, undefined)
          continue
        }

        if (event.type === 'interaction') {
          const parsed = parseInteractionRequest(asRecord(record.data))
          if (!parsed.succeeded) {
            log('[chat-routes] dropping malformed interaction event', { error: parsed.error })
            continue
          }
          if (renderable(parsed.value.kind)) {
            recordPersistedPart(
              interactionToPersistedPart(parsed.value, 'pending'),
              undefined,
              interactionPartKey(parsed.value.id),
            )
            yield toProducerWireEvent(record)
            continue
          }
          // Non-renderable ask: the run is blocked in the broker until someone
          // answers. Decline it so the turn proceeds instead of hanging.
          let declineFailed = false
          if (options.declineInteraction) {
            try {
              await options.declineInteraction(parsed.value.id)
            } catch (err) {
              declineFailed = true
              log('[chat-routes] failed to auto-decline interaction', {
                id: parsed.value.id,
                error: err instanceof Error ? err.message : String(err),
              })
            }
          } else {
            declineFailed = true
            log('[chat-routes] non-renderable interaction with no declineInteraction wired', {
              id: parsed.value.id,
              kind: parsed.value.kind,
            })
          }
          const text = declineFailed
            ? `The agent requested ${parsed.value.kind} approval; declining it failed — it will expire on its own.`
            : `The agent requested ${parsed.value.kind} approval — auto-declined by policy.`
          const notice = noticePart('auto-declined', `auto-declined-${parsed.value.id}`, text)
          recordPersistedPart(notice, undefined, noticePartKey(notice.id))
          yield { type: 'notice', id: notice.id, noticeKind: 'auto-declined', text }
          continue
        }

        if (event.type === 'interaction.cancel') {
          const parsed = parseInteractionCancel(asRecord(record.data))
          if (!parsed.succeeded) {
            log('[chat-routes] dropping malformed interaction.cancel event', { error: parsed.error })
            continue
          }
          const key = interactionPartKey(parsed.value.id)
          const existing = partMap.get(key)
          if (existing?.type === 'interaction' && existing.status === 'pending') {
            recordPersistedPart({
              ...existing,
              status: cancelStatusFor(parsed.value.reason),
              ...(parsed.value.reason ? { cancelReason: parsed.value.reason } : {}),
            }, undefined, key)
          }
          yield toProducerWireEvent(record)
          continue
        }

        if (event.type === 'plan.submitted') {
          const parsed = parsePlanSubmittedEvent(record)
          if (!parsed.succeeded) {
            log('[chat-routes] dropping malformed plan.submitted event', { error: parsed.error })
            continue
          }
          recordPersistedPart(planToPersistedPart(parsed.value), undefined)
          yield toProducerWireEvent(record)
          continue
        }

        if (event.type === 'warning') {
          const message = asString(event.data?.message)
          if (message) {
            warningCount += 1
            const code = asString(event.data?.code)
            const text = code ? `${code}: ${message}` : message
            const notice = noticePart('warning', `warning-${warningCount}`, text)
            recordPersistedPart(notice, undefined, noticePartKey(notice.id))
            yield { type: 'notice', id: notice.id, noticeKind: 'warning', text }
          }
          // The flattened notice is additive; existing raw-warning consumers keep
          // receiving the original event too.
          yield toProducerWireEvent(record)
          continue
        }

        if (event.type === 'result') {
          const finalText = asString(event.data?.finalText)
          if (finalText) fullText = finalText
          const reported = extractReportedTurnUsage(asRecord(event.data))
          if (reported) {
            applyTerminalUsage(reported, usage)
            yield* emitFinalUsage()
          } else {
            // Legacy result shape kept as a secondary fallback.
            const resultUsage = asRecord(event.data?.usage)
            if (resultUsage) {
              const input = Number(resultUsage.inputTokens)
              const output = Number(resultUsage.outputTokens)
              if (Number.isFinite(input)) usage.inputTokens = input
              if (Number.isFinite(output)) usage.outputTokens = output
            }
          }
          yield* emitTerminalizedTools()
          continue
        }

        if (event.type === 'done') {
          const reported = extractReportedTurnUsage(asRecord(event.data))
          if (reported) {
            applyTerminalUsage(reported, usage)
            yield* emitFinalUsage()
          }
          yield* emitTerminalizedTools()
          yield toProducerWireEvent(record)
          continue
        }

        if (event.type === 'error') {
          const message = sandboxStreamErrorMessage(event.data)
          const errorContent = fullText.trim()
            ? `The sandbox model stream stopped before a clean completion.\n\nError: ${message}`
            : `The sandbox agent returned an error before producing a visible answer.\n\nError: ${message}`
          const errorDelta = fullText ? `\n\n---\n${errorContent}` : errorContent
          fullText += errorDelta
          interactionOutcome = 'expired'
          yield { type: 'text', text: errorDelta }
          yield* emitTerminalizedTools()
          yield toProducerWireEvent(record)
          continue
        }

        // Remaining lifecycle events forward verbatim; the client parser ignores
        // unknown types.
        yield toProducerWireEvent(record)
      }
    } catch (streamErr) {
      const diagnostic = sandboxStreamFailureDiagnostic(streamErr)
      log('[chat-routes] sandbox stream failed', {
        failureNote: diagnostic.failureNote,
        error: streamErr instanceof Error ? streamErr.message : String(streamErr),
      })
      const errorDelta = fullText
        ? `\n\n---\n${diagnostic.userMessage}`
        : diagnostic.userMessage
      fullText += errorDelta
      interactionOutcome = 'expired'
      yield { type: 'text', text: errorDelta }
      yield* emitTerminalizedTools()
      yield {
        type: 'error',
        data: {
          message: diagnostic.userMessage,
          code: 'sandbox.stream_failed',
          details: { failureNote: diagnostic.failureNote },
        },
      }
    }
  }

  return {
    stream: stream(),
    finalText: () => fullText,
    assistantParts: () => finalizePendingInteractionParts(
      finalizeAssistantParts(partOrder, partMap, fullText),
      interactionOutcome,
    ),
    usage: () => usage,
    ...(options.model ? { model: options.model } : {}),
  }
}
