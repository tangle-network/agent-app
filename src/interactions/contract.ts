// Shared contract for agent interaction events (kind: "question" et al) — the
// generalized human-in-the-loop primitive on the chat stream. Framework-agnostic
// (no server- or React-only imports) so a producer (chat route) and a consumer
// (stream parser, transcript, question card) agree on one wire shape and one
// persisted-part shape.
//
// An `interaction` event means the run is BLOCKED inside the sidecar's
// InteractionBroker until the user answers, the agent withdraws the ask
// (`interaction.cancel`), or the broker times out. A pending interaction is
// "waiting on the user", not "model working".

import {
  InteractionRequestSchema,
  type InteractionData,
  type InteractionField,
  type InteractionOutcome,
  type InteractionRequest,
} from '@tangle-network/agent-interface'

export type { InteractionData, InteractionOutcome, InteractionRequest }

// ---------------------------------------------------------------------------
// Event names

/** Sidecar → client: the agent raised an ask; data = `{ request }`. */
export const INTERACTION_EVENT = 'interaction' as const
/** Sidecar → client: the ask was withdrawn; data = `{ id, reason? }`. */
export const INTERACTION_CANCEL_EVENT = 'interaction.cancel' as const
/** An ask was answered; data = `{ id, status }`. In the wire contract so a
 *  server broadcast and a client-local mark share one event name. */
export const INTERACTION_RESOLVED_EVENT = 'interaction.resolved' as const

/** Interaction kinds a product typically renders a card for. Anything else is
 *  auto-declined by the chat producer's safety net and never reaches a client.
 *  A pure default; a product may substitute its own renderable set. */
const RENDERABLE_INTERACTION_KINDS: ReadonlySet<string> = new Set(['question', 'plan'])

export function isRenderableInteractionKind(kind: string): boolean {
  return RENDERABLE_INTERACTION_KINDS.has(kind)
}

/** Answer/field keys the sidecar will accept: identifier-safe and never a
 *  prototype-pollution vector. */
export function isSafeInteractionFieldKey(key: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(key) && key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
}

// ---------------------------------------------------------------------------
// Field types
//
// `allowCustom` (a select that also accepts a write-in value) is defined by
// newer agent-interface schemas; older pinned schemas strip unknown keys on
// parse. The wire/persisted field types below carry the flag so a card can gate
// its write-in input, and `parseInteractionRequest` returns the RAW payload
// (schema-validated, not schema-parsed) so the flag survives.

export type ChatSelectField = Extract<InteractionField, { type: 'select' }> & {
  allowCustom?: boolean
}
export type ChatInteractionField = Exclude<InteractionField, { type: 'select' }> | ChatSelectField

/** `InteractionRequest` whose select fields may carry `allowCustom`. */
export type InteractionRequestWire = Omit<InteractionRequest, 'answerSpec'> & {
  answerSpec: { fields: ChatInteractionField[] }
}

// ---------------------------------------------------------------------------
// Interaction lifecycle

export type ChatInteractionStatus = 'pending' | 'answered' | 'declined' | 'cancelled' | 'expired'

/** Accepted field selections keyed by answer-spec field name. */
export type InteractionAnswers = Record<string, string[]>

export type ParseInteractionAnswersResult =
  | { succeeded: true; value: InteractionAnswers }
  | { succeeded: false; error: string }

/** Strictly validates and copies persisted answer selections. */
export function parseInteractionAnswers(value: unknown): ParseInteractionAnswersResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { succeeded: false, error: 'interaction answers must be an object' }
  }
  const answers: InteractionAnswers = {}
  for (const [key, selection] of Object.entries(value as Record<string, unknown>)) {
    if (!isSafeInteractionFieldKey(key)) {
      return { succeeded: false, error: `interaction answers contain an unsafe field key: ${key}` }
    }
    if (!Array.isArray(selection) || !selection.every((item) => typeof item === 'string')) {
      return { succeeded: false, error: `interaction answer ${key} must be a string array` }
    }
    answers[key] = [...selection]
  }
  return { succeeded: true, value: answers }
}

/** The client/persisted view of one ask. `fields` come verbatim off the wire. */
export interface ChatInteraction {
  id: string
  kind: string
  title: string
  body?: string
  fields: ChatInteractionField[]
  status: ChatInteractionStatus
  /** Accepted selections, restored with the transcript after reload. */
  answers?: InteractionAnswers
  /** Set when status came from an `interaction.cancel` (e.g. "timeout"). */
  cancelReason?: string
}

export function isTerminalInteractionStatus(status: ChatInteractionStatus): boolean {
  return status !== 'pending'
}

/** Statuses only move forward (pending → terminal); a replayed/stale `pending`
 *  must never resurrect a resolved card. */
export function canTransitionInteractionStatus(
  from: ChatInteractionStatus,
  to: ChatInteractionStatus,
): boolean {
  return from === 'pending' && to !== from
}

/** Maps an `interaction.cancel` reason to the card's terminal status. */
export function cancelStatusFor(reason: string | undefined): ChatInteractionStatus {
  return reason === 'timeout' ? 'expired' : 'cancelled'
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  )
}

function normalizedInteractionText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

/** Content identity for duplicate safety nets. Excludes volatile ids/statuses. */
export function questionInteractionContentSignature(interaction: ChatInteraction): string | null {
  if (interaction.kind !== 'question') return null
  return JSON.stringify(stableValue({
    kind: interaction.kind,
    title: normalizedInteractionText(interaction.title),
    body: normalizedInteractionText(interaction.body),
    fields: interaction.fields,
  }))
}

export function dedupeQuestionInteractionsByContent(interactions: ChatInteraction[]): ChatInteraction[] {
  const seen = new Set<string>()
  return interactions.filter((interaction) => {
    const signature = questionInteractionContentSignature(interaction)
    if (!signature) return true
    if (seen.has(signature)) return false
    seen.add(signature)
    return true
  })
}

// ---------------------------------------------------------------------------
// Wire parsing — typed outcomes, fail loud at the caller (log + skip; never a
// half-rendered card).

export type ParseInteractionResult =
  | { succeeded: true; value: InteractionRequestWire }
  | { succeeded: false; error: string }

/** Parses an `interaction` event's data (`{ request }`). Validates the shape
 *  with the agent-interface schema but returns the raw request so a field a
 *  pinned schema predates (`allowCustom`) survives. */
export function parseInteractionRequest(data: Record<string, unknown> | undefined): ParseInteractionResult {
  const request = data?.request
  if (!request || typeof request !== 'object') {
    return { succeeded: false, error: 'interaction event carried no request object' }
  }
  const validation = InteractionRequestSchema.safeParse(request)
  if (!validation.success) {
    return { succeeded: false, error: `malformed interaction request: ${validation.error.message}` }
  }
  return { succeeded: true, value: request as InteractionRequestWire }
}

export interface InteractionCancelData {
  id: string
  reason?: string
}

export function parseInteractionCancel(
  data: Record<string, unknown> | undefined,
): { succeeded: true; value: InteractionCancelData } | { succeeded: false; error: string } {
  const id = typeof data?.id === 'string' && data.id ? data.id : null
  if (!id) return { succeeded: false, error: 'interaction.cancel event carried no id' }
  const reason = typeof data?.reason === 'string' && data.reason ? data.reason : undefined
  return { succeeded: true, value: { id, ...(reason ? { reason } : {}) } }
}

// ---------------------------------------------------------------------------
// Composer-as-answer delivery: while asks are pending the composer never
// blocks — typed text is delivered verbatim to every open ask and the agent
// decides what it means. No interpretation here; the sidecar validates answers
// fail-closed (invalid free text on an option-only ask → 400).

export function fieldAcceptsFreeText(field: ChatInteractionField): boolean {
  if (field.type === 'text') return true
  if (field.type === 'select') return (field as ChatSelectField).allowCustom === true
  return false
}

export interface ComposerAnswerDelivery {
  interactionId: string
  field: ChatInteractionField
}

/** One delivery per pending ask: the first free-text-capable field, else the
 *  first field. Zero-field asks are skipped (nothing to carry the text). */
export function composerAnswerDeliveries(pending: ChatInteraction[]): ComposerAnswerDelivery[] {
  const deliveries: ComposerAnswerDelivery[] = []
  for (const interaction of pending) {
    // Only questions take a composer-routed answer. A non-question ask (a plan)
    // is POSTed as outcome:"accepted" when answered — routing composer text to
    // it would silently APPROVE it. Approval is an explicit card click, so the
    // composer skips it and the plan card stays the only path.
    if (interaction.kind !== 'question') continue
    const field = interaction.fields.find(fieldAcceptsFreeText) ?? interaction.fields[0]
    if (!field) continue
    deliveries.push({ interactionId: interaction.id, field })
  }
  return deliveries
}

/** Shapes composer text into the respond payload for the routed field
 *  (select answers are string arrays on the wire; text answers are strings). */
export function composerAnswerData(field: ChatInteractionField, text: string): InteractionData {
  return { [field.name]: field.type === 'select' ? [text] : text }
}

// ---------------------------------------------------------------------------
// Part keys + codecs (persisted `messages.parts` entries and live stream parts
// share these shapes).

export function interactionPartKey(id: string): string {
  return `interaction:${id}`
}

export function noticePartKey(id: string): string {
  return `notice:${id}`
}

export type NoticeKind = 'warning' | 'auto-declined'

/**
 * Persisted-part shapes the codecs below produce — the SAME rows
 * `/chat-store`'s `ChatInteractionPart`/`ChatNoticePart` store, typed at the
 * source so a product pushing them into a `ChatMessagePart[]` transcript needs
 * no cast. Type aliases (not interfaces) on purpose: the implicit index
 * signature keeps them assignable to the `Record<string, unknown>` these
 * codecs previously returned, so existing consumers stay source-compatible.
 */
export type InteractionPersistedPart = {
  type: 'interaction'
  id: string
  kind: string
  title: string
  body?: string
  answerSpec: { fields: ChatInteractionField[] }
  status: ChatInteractionStatus
  answers?: InteractionAnswers
  cancelReason?: string
}

export type NoticePersistedPart = {
  type: 'notice'
  id: string
  noticeKind: NoticeKind
  text: string
}

/** Builds the persisted/streamed `notice` part — a one-line transcript notice
 *  explaining an out-of-band event (warning, auto-declined interaction). */
export function noticePart(noticeKind: NoticeKind, id: string, text: string): NoticePersistedPart {
  return { type: 'notice', id, noticeKind, text }
}

/** Reads a wire request into the client's pending `ChatInteraction`. */
export function interactionFromWireRequest(request: InteractionRequestWire): ChatInteraction {
  return {
    id: request.id,
    kind: request.kind,
    title: request.title,
    ...(request.body ? { body: request.body } : {}),
    fields: request.answerSpec.fields,
    status: 'pending',
  }
}

/** Builds the persisted/streamed `interaction` part from a wire request. */
export function interactionToPersistedPart(
  request: InteractionRequestWire,
  status: ChatInteractionStatus,
  cancelReason?: string,
  answers?: InteractionAnswers,
): InteractionPersistedPart {
  const parsedAnswers = answers === undefined ? undefined : parseInteractionAnswers(answers)
  if (parsedAnswers && !parsedAnswers.succeeded) throw new TypeError(parsedAnswers.error)
  return {
    type: 'interaction',
    id: request.id,
    kind: request.kind,
    title: request.title,
    ...(request.body ? { body: request.body } : {}),
    answerSpec: { fields: request.answerSpec.fields },
    status,
    ...(parsedAnswers?.succeeded ? { answers: parsedAnswers.value } : {}),
    ...(cancelReason ? { cancelReason } : {}),
  }
}

/** Stamps accepted values onto matching persisted interaction parts without
 * mutating the caller's transcript or answer maps. */
export function stampInteractionAnswers(
  parts: Array<Record<string, unknown>>,
  answersByInteractionId: Readonly<Record<string, InteractionAnswers>>,
): Array<Record<string, unknown>> {
  return parts.map((part) => {
    if (String(part.type ?? '') !== 'interaction' || typeof part.id !== 'string') return part
    if (!Object.prototype.hasOwnProperty.call(answersByInteractionId, part.id)) return part
    const rawAnswers = answersByInteractionId[part.id]
    if (rawAnswers === undefined) return part
    const parsed = parseInteractionAnswers(rawAnswers)
    if (!parsed.succeeded) throw new TypeError(parsed.error)
    return { ...part, answers: parsed.value }
  })
}

/** Reads a persisted/streamed `interaction` part back into a `ChatInteraction`.
 *  Returns null (caller logs) when the part is not one of ours. */
export function persistedPartToInteraction(part: Record<string, unknown>): ChatInteraction | null {
  if (String(part.type ?? '') !== 'interaction') return null
  const id = typeof part.id === 'string' && part.id ? part.id : null
  const kind = typeof part.kind === 'string' && part.kind ? part.kind : null
  const title = typeof part.title === 'string' ? part.title : ''
  const answerSpec = part.answerSpec as { fields?: unknown } | undefined
  const fields = Array.isArray(answerSpec?.fields) ? (answerSpec.fields as ChatInteractionField[]) : null
  const status = part.status as ChatInteractionStatus | undefined
  const validStatus = status && ['pending', 'answered', 'declined', 'cancelled', 'expired'].includes(status)
  const parsedAnswers = part.answers === undefined ? undefined : parseInteractionAnswers(part.answers)
  if (!id || !kind || !fields || !validStatus || (parsedAnswers && !parsedAnswers.succeeded)) return null
  return {
    id,
    kind,
    title,
    ...(typeof part.body === 'string' && part.body ? { body: part.body } : {}),
    fields,
    status,
    ...(parsedAnswers?.succeeded ? { answers: parsedAnswers.value } : {}),
    ...(typeof part.cancelReason === 'string' && part.cancelReason ? { cancelReason: part.cancelReason } : {}),
  }
}
