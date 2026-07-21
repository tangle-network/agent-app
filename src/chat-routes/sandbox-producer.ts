/**
 * Sandbox lane: bridge a raw sandbox event stream (`streamSandboxPrompt`) into
 * the `ChatTurnProducer` shape agent-runtime's `handleChatTurn` consumes AND
 * the client vocabulary `/web-react`'s `dispatchChatStreamLine` already parses
 * (`text` / `reasoning` / `tool_call` / `tool_result` / `usage` /
 * `interaction`). Legal and tax each hand-rolled this mapping differently;
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
  parseInteractionCancel,
  parseInteractionRequest,
  type InteractionCancelData,
  type InteractionPersistedPart,
  type InteractionRequestWire,
} from '../interactions/contract'
import {
  parsePlanSubmittedEvent,
  planToPersistedPart,
} from '../plans/index'
import {
  asRecord,
  asString,
  finalizeAssistantParts,
  getPartKey,
  mergePersistedPart,
  normalizePersistedPart,
  normalizeToolEvent,
  type JsonRecord,
  type StreamEvent,
} from '../stream/index'
import type { ChatTurnRouteProducer, ChatTurnUsage } from './turn-routes'

export interface SandboxChatProducerOptions {
  /** The raw sandbox event stream (e.g. `streamSandboxPrompt(...)`). */
  events: AsyncIterable<unknown>
  /** Recorded on the persisted assistant message. */
  model?: string
  /** Which ask kinds the product renders a card for. Anything else is
   *  auto-declined (see `declineInteraction`) so the run never hangs in the
   *  broker waiting on a card no client will show. Default: question/plan. */
  isRenderableInteraction?: (kind: string) => boolean
  /** Resolve a non-renderable ask (wire `respondToSessionInteraction` with the
   *  session's sidecar connection). Without it, non-renderable asks are only
   *  logged — the run stays blocked until the broker times out. */
  declineInteraction?: (id: string) => Promise<void>
  /** Optional durable lifecycle projection. The closure is already scoped by
   * the product's authorized session context. Its materialized terminal parts
   * replace live pending snapshots before assistant persistence. */
  interactionProjection?: {
    upsertAsk(request: InteractionRequestWire): void | Promise<void>
    cancel(cancel: InteractionCancelData): void | Promise<void>
    materialize(): InteractionPersistedPart[] | Promise<InteractionPersistedPart[]>
  }
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

  function recordPersistedPart(part: JsonRecord, delta: string | undefined, keyOverride?: string): void {
    const persisted = normalizePersistedPart(part)
    if (!persisted) return
    const key = keyOverride ?? getPartKey(persisted)
    if (!partMap.has(key)) partOrder.push(key)
    partMap.set(key, mergePersistedPart(partMap.get(key), persisted, delta))
  }

  async function* stream(): AsyncGenerator<StreamEvent, void, unknown> {
    for await (const raw of options.events) {
      const record = asRecord(raw)
      if (!record || typeof record.type !== 'string') continue
      // Fold bare tool_call/tool_result shapes into the canonical part event;
      // everything else keeps its original record (verbatim forwarding must
      // not strip fields outside `data`).
      const normalized = normalizeToolEvent({ type: record.type, data: asRecord(record.data) })
      const event = normalized.type === 'message.part.updated' ? normalized : (record as unknown as StreamEvent)

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
            yield { type: partType, text: delta } as StreamEvent & { text: string }
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
            } as StreamEvent
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
            } as StreamEvent
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
            yield { type: 'usage', usage: { promptTokens, completionTokens } } as StreamEvent
          }
          continue
        }

        if (partType === 'step-start') {
          recordPersistedPart(part, undefined, `step-start:#${stepCounter}`)
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
          await options.interactionProjection?.upsertAsk(parsed.value)
          yield event
          continue
        }
        // Non-renderable ask: the run is blocked in the broker until someone
        // answers. Decline it so the turn proceeds instead of hanging.
        if (options.declineInteraction) {
          try {
            await options.declineInteraction(parsed.value.id)
          } catch (err) {
            log('[chat-routes] failed to auto-decline interaction', {
              id: parsed.value.id,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        } else {
          log('[chat-routes] non-renderable interaction with no declineInteraction wired', {
            id: parsed.value.id,
            kind: parsed.value.kind,
          })
        }
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
        await options.interactionProjection?.cancel(parsed.value)
        yield event
        continue
      }

      if (event.type === 'plan.submitted') {
        const parsed = parsePlanSubmittedEvent(record)
        if (!parsed.succeeded) {
          log('[chat-routes] dropping malformed plan.submitted event', { error: parsed.error })
          continue
        }
        recordPersistedPart(planToPersistedPart(parsed.value), undefined)
        yield event
        continue
      }

      if (event.type === 'result') {
        const finalText = asString(event.data?.finalText)
        if (finalText) fullText = finalText
        const resultUsage = asRecord(event.data?.usage)
        if (resultUsage) {
          const input = Number(resultUsage.inputTokens)
          const output = Number(resultUsage.outputTokens)
          if (Number.isFinite(input)) usage.inputTokens = input
          if (Number.isFinite(output)) usage.outputTokens = output
        }
        continue
      }

      // Everything else (error, lifecycle) forwards
      // verbatim — the client parser ignores unknown types.
      yield event
    }

    if (options.interactionProjection) {
      for (const part of await options.interactionProjection.materialize()) {
        recordPersistedPart(part, undefined, interactionPartKey(part.id))
      }
    }
  }

  return {
    stream: stream(),
    finalText: () => fullText,
    assistantParts: () => finalizeAssistantParts(partOrder, partMap, fullText),
    usage: () => usage,
    ...(options.model ? { model: options.model } : {}),
  }
}
