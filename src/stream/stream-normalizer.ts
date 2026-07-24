import {
  canTransitionInteractionStatus,
  persistedPartToInteraction,
  type ChatInteractionStatus,
} from '../interactions/contract'
import {
  canTransitionPlanStatus,
  persistedPartToPlan,
  planPartKey,
  planToPersistedPart,
  type ChatPlanStatus,
} from '../plans/index'

/** Represent a JSON-compatible object with string keys and values of any type */
export type JsonRecord = Record<string, unknown>

/** Define an event object carrying a type and optional JSON data payload */
export interface StreamEvent {
  type: string
  data?: JsonRecord
}

/** Resolve an unknown value to a JsonRecord if it is a non-array object or return undefined */
export function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

/** Resolve a non-empty string from a value or return undefined */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Resolve a unique tool identifier from various possible properties or generate a fallback ID */
export function resolveToolId(part: JsonRecord): string {
  return String(
    part.id ??
      part.callID ??
      part.callId ??
      part.toolUseId ??
      part.toolCallId ??
      part.tool ??
      part.name ??
      `tool-${Date.now()}`,
  )
}

/** Resolve the tool name from a JSON record using tool, name, or a default value */
export function resolveToolName(part: JsonRecord): string {
  return String(part.tool ?? part.name ?? 'tool')
}

/** Resolve time properties from various keys into a normalized record with numeric start and end fields */
export function normalizeTime(value: unknown): JsonRecord | undefined {
  const record = asRecord(value)
  if (!record) return undefined

  const start = Number(record.start ?? record.startedAt ?? record.started_at)
  const end = Number(record.end ?? record.completedAt ?? record.completed_at)
  if (!Number.isFinite(start) && !Number.isFinite(end)) return undefined

  return {
    start: Number.isFinite(start) ? start : undefined,
    end: Number.isFinite(end) ? end : undefined,
  }
}

/** Normalize tool-related events into a standardized message.part.updated format */
export function normalizeToolEvent(event: StreamEvent): StreamEvent {
  if (event.type === 'tool_call' || event.type === 'tool.call') {
    const data = event.data ?? {}
    return {
      type: 'message.part.updated',
      data: {
        part: {
          type: 'tool',
          id: data.id ?? data.callId ?? data.callID ?? data.name,
          tool: data.name ?? data.tool ?? 'tool',
          input: data.arguments ?? data.input,
          status: 'running',
        },
      },
    }
  }

  if (event.type === 'tool_result' || event.type === 'tool.result') {
    const data = event.data ?? {}
    const error = asString(data.error)
    return {
      type: 'message.part.updated',
      data: {
        part: {
          type: 'tool',
          id: data.id ?? data.callId ?? data.callID ?? data.name,
          tool: data.name ?? data.tool ?? 'tool',
          output: data.output,
          error,
          status: error ? 'error' : 'completed',
        },
      },
    }
  }

  return event
}

/** Normalize a persisted part object by standardizing its structure and fields */
export function normalizePersistedPart(rawPart: JsonRecord): JsonRecord | null {
  const type = String(rawPart.type ?? '')

  if (type === 'text') {
    const id = asString(rawPart.id) ?? asString(rawPart.partId)
    return {
      type: 'text',
      text: asString(rawPart.text) ?? asString(rawPart.content) ?? '',
      // id: per-segment identity from the harness; absent on legacy parts,
      // which collapse to a single keyed segment. Never invented here.
      ...(id ? { id } : {}),
    }
  }

  if (type === 'reasoning') {
    const id = asString(rawPart.id) ?? asString(rawPart.partId)
    return {
      type: 'reasoning',
      text: asString(rawPart.text) ?? asString(rawPart.content) ?? '',
      time: normalizeTime(rawPart.time),
      ...(id ? { id } : {}),
    }
  }

  if (type === 'file' || type === 'image') {
    const id = asString(rawPart.id) ?? asString(rawPart.partId)
    return {
      type,
      ...(id ? { id } : {}),
      ...(asString(rawPart.filename) ? { filename: asString(rawPart.filename) } : {}),
      ...(asString(rawPart.mediaType) ? { mediaType: asString(rawPart.mediaType) } : {}),
      ...(asString(rawPart.url) ? { url: asString(rawPart.url) } : {}),
      ...(asString(rawPart.path) ? { path: asString(rawPart.path) } : {}),
      ...(type === 'file' && asString(rawPart.content) ? { content: asString(rawPart.content) } : {}),
    }
  }

  if (type === 'step-start') {
    return { type: 'step-start' }
  }

  // The harness's per-step usage receipt. Dropping it here silently loses the
  // turn's token/cost accounting from the persisted transcript.
  if (type === 'step-finish') {
    const tokens = asRecord(rawPart.tokens)
    const cost = Number(rawPart.cost)
    return {
      type: 'step-finish',
      ...(asString(rawPart.reason) ? { reason: asString(rawPart.reason) } : {}),
      ...(tokens ? { tokens } : {}),
      ...(Number.isFinite(cost) ? { cost } : {}),
    }
  }

  if (type === 'subtask') {
    const id = asString(rawPart.id) ?? asString(rawPart.partId)
    return {
      type: 'subtask',
      prompt: asString(rawPart.prompt) ?? '',
      description: asString(rawPart.description) ?? '',
      agent: asString(rawPart.agent) ?? '',
      ...(id ? { id } : {}),
    }
  }

  if (type === 'interaction') {
    return persistedPartToInteraction(rawPart) ? rawPart : null
  }

  if (type === 'plan') {
    const plan = persistedPartToPlan(rawPart)
    return plan ? { ...rawPart, ...planToPersistedPart(plan) } : null
  }

  // System-authored notices pass through verbatim; `/chat-store` owns their
  // final typed validation before persistence.
  if (type === 'notice') {
    return rawPart
  }

  if (type === 'tool') {
    const state = asRecord(rawPart.state)
    const output = state?.output ?? rawPart.output
    const error = asString(state?.error ?? rawPart.error)
    const terminalError =
      state?.status === 'error' ||
      state?.status === 'failed' ||
      rawPart.status === 'error' ||
      rawPart.status === 'failed' ||
      Boolean(error)
    const status =
      state?.status === 'completed' || rawPart.status === 'completed'
        ? 'completed'
        : terminalError
          ? 'error'
          : output !== undefined
            ? 'completed'
            : 'running'

    return {
      type: 'tool',
      id: resolveToolId(rawPart),
      tool: resolveToolName(rawPart),
      callID:
        rawPart.callID != null || rawPart.callId != null
          ? String(rawPart.callID ?? rawPart.callId)
          : undefined,
      state: {
        status,
        input: state?.input ?? rawPart.input,
        output,
        error,
        metadata: asRecord(state?.metadata) ?? asRecord(rawPart.metadata),
        time: normalizeTime(state?.time ?? rawPart.time),
      },
    }
  }

  return null
}

/** Stream/transcript part key for a promoted (path-bearing) attachment,
 *  keyed on its storage path — re-emitting the same path folds into the same
 *  segment instead of duplicating it. */
export function attachmentPartKey(path: string): string {
  return `attachment:${path}`
}

/** Resolve a unique key string for a part based on its type and identifying properties */
export function getPartKey(part: JsonRecord): string {
  const type = String(part.type ?? 'unknown')
  if (type === 'tool') {
    return `tool:${resolveToolId(part)}`
  }
  if (type === 'plan') return planPartKey(String(part.planId ?? ''))
  if ((type === 'file' || type === 'image') && asString(part.path)) {
    return attachmentPartKey(String(part.path))
  }

  // Keyed by the part's OWN type so distinct kinds never merge into each
  // other. Untyped parts fall back to the text lane (legacy shape).
  const lane = type && type !== 'unknown' ? type : 'text'
  return `${lane}:${String(part.id ?? part.partId ?? part.index ?? 'current')}`
}

/** Shallow overlay that skips `undefined` incoming values, so a later partial
 *  update never erases a field an earlier one captured. */
function overlayDefined(base: JsonRecord, patch: JsonRecord): JsonRecord {
  const out: JsonRecord = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/** Merge incoming JSON with existing persisted data, applying delta for text types when provided */
export function mergePersistedPart(existing: JsonRecord | undefined, incoming: JsonRecord, delta?: string): JsonRecord {
  const type = String(incoming.type ?? '')
  if (!existing) {
    if (type === 'text' && delta) {
      return { type: 'text', text: delta }
    }
    return incoming
  }

  if (type === 'text' && String(existing.type ?? '') === 'text') {
    const existingText = String(existing.text ?? '')
    const incomingText = String(incoming.text ?? '')
    return {
      ...existing,
      ...incoming,
      // An empty snapshot never erases accumulated text (matches reasoning).
      text: delta ? `${existingText}${delta}` : incomingText || existingText,
    }
  }

  if (type === 'reasoning' && String(existing.type ?? '') === 'reasoning') {
    const existingText = String(existing.text ?? '')
    const incomingText = String(incoming.text ?? '')
    return {
      ...existing,
      ...incoming,
      text: delta && incomingText === existingText ? `${existingText}${delta}` : incomingText || existingText,
      time: incoming.time ?? existing.time,
    }
  }

  if (type === 'tool' && String(existing.type ?? '') === 'tool') {
    const existingState = asRecord(existing.state) ?? {}
    const incomingState = asRecord(incoming.state) ?? {}
    // Overlay only DEFINED incoming fields: a normalized tool part always
    // carries `output`/`error` keys (undefined when not captured), so a plain
    // spread would clobber a completed tool's output with a later empty update.
    const mergedState = overlayDefined(existingState, incomingState)
    // A partial update with no captured status/output/error normalizes to
    // `running`; never let it downgrade a tool that already settled.
    const existingStatus = String(existingState.status ?? '')
    if (
      (existingStatus === 'completed' || existingStatus === 'error') &&
      String(incomingState.status ?? '') === 'running'
    ) {
      mergedState.status = existingStatus
    }
    return {
      ...overlayDefined(existing, incoming),
      state: mergedState,
    }
  }

  if (type === 'interaction' && String(existing.type ?? '') === 'interaction') {
    const merged = overlayDefined(existing, incoming)
    const existingStatus = existing.status as ChatInteractionStatus | undefined
    const incomingStatus = incoming.status as ChatInteractionStatus | undefined
    if (
      existingStatus &&
      incomingStatus &&
      existingStatus !== incomingStatus &&
      !canTransitionInteractionStatus(existingStatus, incomingStatus)
    ) {
      merged.status = existingStatus
    }
    if (incoming.answers === undefined && existing.answers !== undefined) {
      merged.answers = existing.answers
    }
    return merged
  }

  if (type === 'plan' && String(existing.type ?? '') === 'plan') {
    const existingRevision = Number(existing.revision)
    const incomingRevision = Number(incoming.revision)
    if (Number.isInteger(existingRevision) && Number.isInteger(incomingRevision)) {
      if (incomingRevision < existingRevision) return existing
      if (incomingRevision > existingRevision) return incoming
    }
    const merged = overlayDefined(existing, incoming)
    const existingStatus = existing.status as ChatPlanStatus | undefined
    const incomingStatus = incoming.status as ChatPlanStatus | undefined
    if (
      existingStatus &&
      incomingStatus &&
      existingStatus !== incomingStatus &&
      !canTransitionPlanStatus(existingStatus, incomingStatus)
    ) {
      merged.status = existingStatus
    }
    return merged
  }

  return incoming
}

/** Resolve errors when a tool fails to report a terminal result before the assistant turn ends */
export const MISSING_TOOL_TERMINAL_ERROR = 'Tool did not report a terminal result before the assistant turn completed.'
/** Provide the reason identifier for a missing tool in the terminal environment */
export const MISSING_TOOL_TERMINAL_REASON = 'missing-tool-terminal'

/** Closes a tool part left `running` when a stream ended abnormally: settles
 *  it as a terminal `error` and stamps `state.metadata.terminalized` so the
 *  synthetic settlement is distinguishable from a real tool failure. Parts
 *  that already settled (and non-tool parts) pass through untouched. */
export function terminalizeDanglingToolPart(part: JsonRecord): JsonRecord {
  if (String(part.type ?? '') !== 'tool') return part

  const state = asRecord(part.state) ?? {}
  if (String(state.status ?? part.status ?? '') !== 'running') return part

  const metadata = asRecord(state.metadata) ?? {}
  return {
    ...part,
    state: {
      ...state,
      status: 'error',
      error: asString(state.error ?? part.error) ?? MISSING_TOOL_TERMINAL_ERROR,
      metadata: {
        ...metadata,
        terminalized: true,
        terminalReason: MISSING_TOOL_TERMINAL_REASON,
      },
    },
  }
}

/** Resolve dangling tool parts into terminal forms within the given JSON records array */
export function terminalizeDanglingToolParts(parts: JsonRecord[]): JsonRecord[] {
  return parts.map(terminalizeDanglingToolPart)
}

/** Settles still-pending interaction parts at persist time. The broker
 *  guarantees a resolved question either answered (run unblocked, no cancel
 *  event) or cancelled/timed out (cancel event already updated the part), so
 *  the success path finalizes remaining pendings as `answered` and the
 *  failure/terminalize paths as `expired`. */
export function finalizePendingInteractionParts(
  parts: JsonRecord[],
  outcome: Extract<ChatInteractionStatus, 'answered' | 'expired'>,
): JsonRecord[] {
  return parts.map((part) => {
    if (String(part.type ?? '') !== 'interaction') return part
    if (String(part.status ?? '') !== 'pending') return part
    return { ...part, status: outcome }
  })
}

/** Collapses text-part artifacts of unstable upstream segment identity: the
 *  same text arriving under two keys (id-less delta stream, then an
 *  id-bearing snapshot) folds into two segments, and interleaved empty
 *  segments survive as blank parts. Consecutive identical text parts merge
 *  into one; empty text parts drop when any non-empty text part exists. */
export function collapseRedundantTextParts(parts: JsonRecord[]): JsonRecord[] {
  const hasNonEmptyText = parts.some(
    (part) => String(part.type ?? '') === 'text' && String(part.text ?? '').trim().length > 0,
  )
  const collapsed: JsonRecord[] = []
  for (const part of parts) {
    if (String(part.type ?? '') !== 'text') {
      collapsed.push(part)
      continue
    }
    const text = String(part.text ?? '')
    if (hasNonEmptyText && text.trim().length === 0) continue
    const previous = collapsed[collapsed.length - 1]
    if (previous && String(previous.type ?? '') === 'text' && String(previous.text ?? '') === text) continue
    collapsed.push(part)
  }
  return collapsed
}

function assembleAssistantParts(
  partOrder: string[],
  partMap: Map<string, JsonRecord>,
  finalText: string,
): JsonRecord[] {
  const parts = partOrder
    .map((key) => partMap.get(key))
    .filter((part): part is JsonRecord => Boolean(part))

  const textParts = parts.filter((part) => String(part.type ?? '') === 'text')

  if (textParts.length === 0) {
    if (finalText.trim()) {
      parts.push({ type: 'text', text: finalText })
    }
    return parts
  }

  // Id-less text parts form a single logical stream — the final text is
  // authoritative for it.
  if (!textParts.some((part) => asString(part.id))) {
    return parts.map((part) => {
      if (String(part.type ?? '') !== 'text') return part
      return {
        ...part,
        text: finalText || String(part.text ?? ''),
      }
    })
  }

  // Per-id text segments: invariant is concat(text parts) === persisted final
  // text, so segment boundaries survive without duplicating the answer into
  // every segment.
  const joined = textParts.map((part) => String(part.text ?? '')).join('')
  if (finalText === joined || finalText.trimEnd() === joined.trimEnd()) {
    return parts
  }

  if (finalText.startsWith(joined)) {
    // Final text extends the streamed segments (e.g. a failure diagnostic
    // appended after the stream) — persist the remainder as a trailing
    // id-less segment.
    return [...parts, { type: 'text', text: finalText.slice(joined.length) }]
  }

  // Final text replaced the streamed text outright. Keep non-text chronology;
  // collapse text to one authoritative segment at the last text position.
  const lastTextPart = textParts[textParts.length - 1]
  return parts
    .filter((part) => String(part.type ?? '') !== 'text' || part === lastTextPart)
    .map((part) => (part === lastTextPart ? { ...part, text: finalText } : part))
}

/** Resolve and clean up assistant parts by terminalizing and collapsing redundant segments */
export function finalizeAssistantParts(
  partOrder: string[],
  partMap: Map<string, JsonRecord>,
  finalText: string,
): JsonRecord[] {
  // A stream that ended abnormally can leave tool parts `running` — never
  // persist one; collapsing then removes the duplicate/blank text segments an
  // unstable upstream segment identity produced.
  return collapseRedundantTextParts(terminalizeDanglingToolParts(
    assembleAssistantParts(partOrder, partMap, finalText),
  ))
}

function partStatus(part: JsonRecord | undefined): string {
  const state = asRecord(part?.state)
  return String(state?.status ?? part?.status ?? '')
}

/** Finalizes, then folds each synthetic tool settlement back into `partMap`
 *  and returns just those updates — the shape a streaming loop needs to emit
 *  closing `message.part.updated` frames for tools the stream never settled. */
export function terminalizeDanglingAssistantToolUpdates(
  partOrder: string[],
  partMap: Map<string, JsonRecord>,
  finalText: string,
): JsonRecord[] {
  const finalizedParts = finalizeAssistantParts(partOrder, partMap, finalText)
  const updates: JsonRecord[] = []

  for (const part of finalizedParts) {
    if (String(part.type ?? '') !== 'tool') continue

    const key = getPartKey(part)
    const existing = partMap.get(key)
    if (partStatus(existing) !== 'running' || partStatus(part) === 'running') continue

    partMap.set(key, mergePersistedPart(existing, part))
    updates.push(part)
  }

  return updates
}

/** Encode a StreamEvent object into a Uint8Array using the provided TextEncoder */
export function encodeEvent(encoder: TextEncoder, event: StreamEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`)
}
