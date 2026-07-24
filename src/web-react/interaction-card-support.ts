/**
 * Shared answer-building + submit plumbing for the interaction cards
 * (question, plan). Client-safe, no React: cards own their state, this owns
 * the wire. Lifted from the gtm-agent fork (the most fix-absorbed of the three
 * product copies), including the 30s submit timeout that keeps a dead route
 * from wedging a card in "Submitting…".
 */

import type {
  ChatInteraction,
  ChatInteractionField,
  ChatInteractionStatus,
  ChatSelectField,
  InteractionAnswers,
  InteractionData,
} from './chat-interactions'

// ---------------------------------------------------------------------------
// Card copy helpers

/** Status-badge labels for an interaction card. `cancelled`/`expired` read the
 *  same across cards; each card supplies its own verbs for the other states
 *  (a question is answered/declined; a plan is approved/rejected). */
export function interactionStatusLabels(
  labels: { pending: string; answered: string; declined: string },
): Record<ChatInteractionStatus, string> {
  return { cancelled: 'Withdrawn', expired: 'Expired', ...labels }
}

/** Terminal-state notes for an interaction card. The expiry/withdrawal lines
 *  share one shape around the card's noun ("question"/"plan"); any extra notes
 *  (e.g. a plan's `declined` revision line) merge on top. */
export function interactionTerminalNotes(
  noun: string,
  extra?: Partial<Record<ChatInteractionStatus, string>>,
): Partial<Record<ChatInteractionStatus, string>> {
  return {
    expired: `This ${noun} expired — send a new message to continue.`,
    cancelled: `The agent withdrew this ${noun}.`,
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// Answer building

/** Define a record mapping field names to objects with optional selected, text, and custom string arrays or values */
export type FieldValues = Record<string, { selected?: string[]; text?: string; custom?: string }>

/** Converts acknowledged, persisted answers back into the local field state
 * consumed by the shared cards. Persisted values are authoritative: this is
 * intentionally used only when an interaction carries `answers`, never to
 * guess an answer from the absence of an outstanding sidecar ask. */
export function fieldValuesFromAnswers(
  fields: ChatInteractionField[],
  answers: InteractionAnswers | undefined,
): FieldValues {
  if (!answers) return {}
  const values: FieldValues = {}
  for (const field of fields) {
    const answer = answers[field.name]
    if (answer === undefined) continue
    if (field.type === 'select') {
      values[field.name] = { selected: Array.isArray(answer) ? [...answer] : [String(answer)] }
    } else if (field.type === 'boolean') {
      values[field.name] = { selected: [String(answer)] }
    } else {
      values[field.name] = { text: String(answer) }
    }
  }
  return values
}

/** The submitted value for one field, or null when it has no answer yet. */
export function fieldAnswer(field: ChatInteractionField, values: FieldValues): InteractionData[string] | null {
  const value = values[field.name] ?? {}
  if (field.type === 'select') {
    const custom = (field as ChatSelectField).allowCustom === true ? value.custom?.trim() : undefined
    const chosen = [...(value.selected ?? []), ...(custom ? [custom] : [])]
    if (field.multi !== true && custom) return [custom]
    return chosen.length > 0 ? chosen : null
  }
  if (field.type === 'number') {
    const parsed = Number(value.text)
    return value.text?.trim() && Number.isFinite(parsed) ? parsed : null
  }
  if (field.type === 'boolean') return value.selected ? value.selected[0] === 'true' : null
  const text = value.text?.trim()
  return text ? text : null
}

/** All required fields answered → the respond payload; else null (not
 *  submittable yet). Optional unanswered fields are omitted. */
export function buildAnswerData(fields: ChatInteractionField[], values: FieldValues): InteractionData | null {
  const data: InteractionData = {}
  for (const field of fields) {
    const answer = fieldAnswer(field, values)
    if (answer === null) {
      if (field.required === false) continue
      return null
    }
    data[field.name] = answer
  }
  return data
}

// ---------------------------------------------------------------------------
// Late answers (question card): an expired/withdrawn ask can still be sent as
// a NEW chat turn carrying the question context, so the user's typed answer is
// never dropped on the floor.

/** Determine if a status is late answerable by checking if it is expired or cancelled */
export function isLateAnswerableStatus(status: ChatInteractionStatus): boolean {
  return status === 'expired' || status === 'cancelled'
}

/** Secrets must never leave the sidecar answer channel for the visible chat
 *  transcript, so a secret-bearing ask cannot be late-answered. */
export function hasSecretField(fields: ChatInteractionField[]): boolean {
  return fields.some((field) => field.type === 'secret')
}

function optionLabel(field: ChatSelectField, value: string): string {
  return field.options.find((option) => option.value === value)?.label ?? value
}

function answerText(field: ChatInteractionField, answer: InteractionData[string]): string {
  if (field.type === 'select' && Array.isArray(answer)) {
    return answer.map((value) => optionLabel(field as ChatSelectField, value)).join(', ')
  }
  if (field.type === 'boolean') return answer === true ? 'Yes' : 'No'
  if (field.type === 'secret') return '[secret omitted]'
  return String(answer)
}

/** Renders the late answer as a self-contained chat message: the original
 *  question, its context, and the user's answer(s). */
export function lateAnswerMessage(interaction: ChatInteraction, data: InteractionData): string {
  const title = interaction.title.trim() || 'the earlier question'
  const body = interaction.body?.trim()
  const answers = interaction.fields
    .map((field) => {
      const answer = data[field.name]
      if (answer === undefined) return null
      return { label: field.label.trim(), text: answerText(field, answer).trim() }
    })
    .filter((item): item is { label: string; text: string } => !!item && item.text.length > 0)

  const only = answers.length === 1 ? answers[0] : undefined
  const answerSummary = only
    ? only.text
    : answers.map((item) => `${item.label || 'Answer'}: ${item.text}`).join('\n')

  return [
    `Regarding your earlier question: "${title}"`,
    body ? `Context: ${body}` : null,
    `My answer: ${answerSummary}`,
  ].filter((line): line is string => !!line).join('\n')
}

// ---------------------------------------------------------------------------
// Submit plumbing

/** Define the timeout duration in milliseconds for submitting an interaction */
export const INTERACTION_SUBMIT_TIMEOUT_MS = 30_000
/** Provide the timeout message displayed when the agent cannot be reached during interaction submission */
export const INTERACTION_SUBMIT_TIMEOUT_MESSAGE = 'Could not reach the agent. Try again.'

/** One card submission: which ask, resolved how, with what answers. */
export interface InteractionAnswerSubmission {
  id: string
  outcome: 'accepted' | 'declined'
  data?: InteractionData
}

/** Resolve the result of an interaction submission indicating success or failure with details */
export type InteractionSubmitResult =
  | { ok: true }
  | { ok: false; expired: boolean; message: string }

/** The cards' only side-effect seam: POST one resolution, report the normalized
 *  outcome. Products bind their route URL + routing fields (workspaceId,
 *  threadId, session path param) via `createInteractionAnswerSubmitter` or a
 *  hand-rolled implementation. */
export type SubmitInteractionAnswer = (submission: InteractionAnswerSubmission) => Promise<InteractionSubmitResult>

/** Extracts the most specific error message a route returned. */
export async function responseErrorMessage(res: Response): Promise<{ code?: string; message: string }> {
  const text = await res.text().catch(() => '')
  if (text) {
    try {
      const parsed = JSON.parse(text) as { code?: unknown; error?: unknown; message?: unknown }
      const message = typeof parsed.error === 'string' && parsed.error.trim() ? parsed.error
        : typeof parsed.message === 'string' && parsed.message.trim() ? parsed.message
        : null
      if (message) return { ...(typeof parsed.code === 'string' ? { code: parsed.code } : {}), message }
    } catch { /* non-JSON body falls through */ }
  }
  return { message: `Answer failed (${res.status})` }
}

/** Define options for submitting interaction answers including URL, body, timeout, and fetch implementation */
export interface InteractionAnswerSubmitterOptions {
  /** The product's answer route (the POST half of `createInteractionAnswerRoute`).
   *  A function when the URL carries the session (e.g. `/api/sessions/${id}/interactions`). */
  url: string | ((submission: InteractionAnswerSubmission) => string)
  /** Extra routing fields merged into the POST body (e.g. workspaceId, threadId). */
  body?: Record<string, unknown> | ((submission: InteractionAnswerSubmission) => Record<string, unknown>)
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/**
 * Builds the `SubmitInteractionAnswer` the cards consume: POSTs
 * `{ ...routingFields, id, outcome, data? }` with an abortable timeout and
 * normalizes the outcome. `expired` is the 410 path — the ask is gone
 * (answered elsewhere, timed out, or the session moved on) and the card must
 * flip to the same dead state a cancel event produces.
 */
export function createInteractionAnswerSubmitter(options: InteractionAnswerSubmitterOptions): SubmitInteractionAnswer {
  const timeoutMs = options.timeoutMs ?? INTERACTION_SUBMIT_TIMEOUT_MS
  return async (submission) => {
    const doFetch = options.fetchImpl ?? fetch
    const url = typeof options.url === 'function' ? options.url(submission) : options.url
    const extra = typeof options.body === 'function' ? options.body(submission) : options.body ?? {}
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(INTERACTION_SUBMIT_TIMEOUT_MESSAGE), timeoutMs)
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          ...extra,
          id: submission.id,
          outcome: submission.outcome,
          ...(submission.data ? { data: submission.data } : {}),
        }),
      })
      if (res.ok) return { ok: true }
      const failure = await responseErrorMessage(res)
      return { ok: false, expired: res.status === 410, message: failure.message }
    } catch (err) {
      if (controller.signal.aborted) {
        return { ok: false, expired: false, message: INTERACTION_SUBMIT_TIMEOUT_MESSAGE }
      }
      return { ok: false, expired: false, message: err instanceof Error ? err.message : 'Failed to submit the answer' }
    } finally {
      clearTimeout(timer)
    }
  }
}
