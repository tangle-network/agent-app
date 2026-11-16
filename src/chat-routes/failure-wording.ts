/**
 * What a person reads when a sandbox turn fails. A reason the producer can word plainly (a provider wait, a refused
 * model key, the Router's own budget or balance refusal) becomes that sentence. A refusal that would fail the same way
 * again, and a funding, billing or admission refusal the client's recovery UI reads, keep their words. Any other reason
 * (a harness error, a tool list, a repeated-call loop, a stack) is withheld: the person reads one plain sentence and the
 * server keeps the reason, in its log and under a Symbol key the route's own failure hooks read.
 */

import { ModelFailoverExhaustedError } from '../model-resolution/failover'
import { SandboxRunError } from '../sandbox/sandbox-run-error'
import { asRecord, asString, type JsonRecord } from '../stream/index'
import { getChatFundingRecovery } from '../web/turn-funding-recovery'
import { ModelFailoverTimeoutError } from './model-failover-stream'
import { WITHHELD_FAILURE } from './turn-event-stream'

type Log = (message: string, meta?: Record<string, unknown>) => void

const utcTime = (at: Date) => `${at.toISOString().slice(11, 19)} UTC`

/** A harness's provider retry wait (OpenCode's raw `retry` status) as one sentence: the provider's words and the next attempt. */
export function providerRetryNotice(event: { type: string; data?: unknown }): string | undefined {
  const retry = event.type === 'raw' ? asRecord(asRecord(event.data)?.event) : undefined
  if (retry?.type !== 'retry' || !(Number(retry.next) > 0)) return undefined
  const cause = asString(retry.message)?.trim() || 'no reason given'
  return `The model provider refused the call (${cause}), so the turn retries at ${utcTime(new Date(Number(retry.next)))}.`
}

/** A terminal provider wait (`…, reset at <ISO>`, agent-container provider-retry-wait.ts) as one sentence. */
export function providerResetSentence(message: string): string | undefined {
  const at = new Date(message.match(/reset at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)?.[1] ?? NaN)
  if (Number.isNaN(at.getTime())) return undefined
  const cause = message.split('; the provider asked')[0]?.trim()
  return `The model provider refused the call (${cause}); try again after ${utcTime(at)} on ${at.toISOString().slice(0, 10)}.`
}

/** The typed code for a harness whose model refused its key, so a product can tell it from other stream failures. */
export const MODEL_KEY_REFUSED_CODE = 'model.key_refused'

/** A harness whose model provider refused its key ("Invalid API key", OpenCode's `OPENCODE_ERROR`) as plain words, true
 *  both for a newly started box whose harness called the model before its minted key was in place (it recovers within
 *  minutes) and for a key that is wrong. The raw error goes to the log and the failure note, never to the person. */
export function modelKeyRefusedSentence(message: string): string | undefined {
  if (!/\binvalid api key\b|\b401\b[^\n]*\b(?:unauthori[sz]ed|api key)\b/i.test(message)) return undefined
  return "The assistant's model refused its access key, so this message was not answered. "
    + 'If the assistant has just started, send it again in a minute; if this repeats, tell the team.'
}

/** The Router's budget and balance refusals: a key's monthly or lifetime budget is exhausted, or the remaining budget
 *  or balance is below the cost of one answer. */
const ROUTER_REFUSAL = new RegExp([
  "This key's (?:monthly|lifetime) budget is exhausted",
  "(?:This key's remaining budget|Your available balance), after other in-flight requests, is below \\$",
].join('|'))

/** The Router's own budget or balance refusal, without the harness's wrapper around it: its prefix and exit status. */
function routerRefusalSentence(message: string): string | undefined {
  const at = message.search(ROUTER_REFUSAL)
  return at < 0 ? undefined : message.slice(at).split('\n')[0]!.replace(/\s*\((?:exit code|killed by)[^)]*\)\s*$/, '').trim()
}

/** A failure reason as the plain sentence the person reads, when the producer has one for it. */
export function plainFailureSentence(message: string): string | undefined {
  return providerResetSentence(message) ?? modelKeyRefusedSentence(message) ?? routerRefusalSentence(message)
}

export function sandboxStreamErrorMessage(data: unknown): string {
  const record = asRecord(data)
  const message = asString(record?.message) ?? asString(record?.error)
  if (message) return message
  try {
    return JSON.stringify(data) || 'Sandbox stream returned an error event without details.'
  } catch {
    return 'Sandbox stream returned an error event without details.'
  }
}

/** The typed reason a sandbox `error` event carries, or a generic stream-error code. */
export function sandboxStreamErrorCode(data: unknown): string {
  return asString(asRecord(data)?.code) ?? 'sandbox.stream_error'
}

/** A failure event the person can read (`error`, `warning`, `done`, `session.run.failed`): when a reason field is one the
 *  producer words plainly, every reason field carries that sentence and the raw text moves to `details.raw`. The client
 *  prints an error event's `message`, and the route's failure card reads `message`/`error`/`reason`. */
export function plainFailureEvent(event: JsonRecord): JsonRecord {
  const data = asRecord(event.data)
  if (!data || !['error', 'warning', 'done', 'session.run.failed'].includes(String(event.type))) return event
  const reasons = (['message', 'error', 'reason'] as const).filter((key) => typeof data[key] === 'string' && data[key])
  const raw = reasons.map((key) => data[key] as string).join(' | ')
  const plain = reasons.map((key) => plainFailureSentence(data[key] as string)).find((sentence) => sentence !== undefined)
  if (!plain) return event
  return { ...event, data: { ...data, ...Object.fromEntries(reasons.map((key) => [key, plain])), details: { ...asRecord(data.details), raw } } }
}

export const FAILED_TURN_TEXT = 'That answer stopped before it finished. Please send your question again.'

/** Refusals that fail the same way again, whose product-written words and code the person acts on: a payment refusal;
 *  a model-policy refusal (`MODEL_REFUSED` from the box, `model_policy_denied` when the policy admits no model in the
 *  chain); and the protected lane's refusal of its model, its activation or its profile. */
const REFUSAL_CODES: ReadonlySet<string> = new Set(['PAYMENT_REQUIRED', 'MODEL_REFUSED', 'model_policy_denied',
  'grant_model_unsupported', 'grant_activation_missing', 'profile_unsupported'])

/** True when a terminal failure's reason (a harness error, a tool list, a call loop, a stack) is withheld: the person
 *  reads the failed-turn text and the server log (`log`, else `console.warn`) keeps the reason under one class, with
 *  `meta` (the ids and failure note the producer has). Passing through: a plainly worded reason (a provider reset, a
 *  refused model key, a Router budget or balance refusal); HTTP 402; a {@link REFUSAL_CODES} refusal; and what the
 *  client's recovery UI reads (`getChatFundingRecovery`: `insufficient_credits`, `paid_access_required`,
 *  `funding_required`, or its words). */
export function withheld(log: Log | undefined, reason: string, code: string | undefined, status: unknown,
  meta: Record<string, unknown> = {}): boolean {
  const passes = Number(status) === 402 || REFUSAL_CODES.has(code ?? '') || plainFailureSentence(reason)
    || getChatFundingRecovery({ code, message: reason })
  if (!passes) {
    (log ?? console.warn)('[chat-routes] turn failure withheld from the person',
      { failureClass: 'runtime_failure', code, error: reason, ...meta })
  }
  return !passes
}

/** The turn, thread, session and execution ids a record carries, for the server log. */
export function failureIds(source: unknown): Record<string, string> {
  const record = asRecord(source)
  return Object.fromEntries(['turnId', 'threadId', 'sessionId', 'executionId']
    .flatMap((key) => typeof record?.[key] === 'string' && record[key] ? [[key, record[key] as string]] : []))
}

/** Detail fields a client renders as text (`supportDetails`, `hint`) or that carry the raw reason. */
const TEXT_DETAILS: ReadonlySet<string> = new Set(['supportDetails', 'hint', 'failureNote', 'raw'])

/** A failure event whose reason is withheld: every reason field (`message`, `error`, `reason`) reads `text`, the
 *  detail fields that carry text are dropped, and the original data rides under `WITHHELD_FAILURE`, which JSON (the
 *  wire, the turn buffer) drops and the route's hooks read. */
export function withheldFailureEvent(event: JsonRecord, text: string): JsonRecord {
  const data = asRecord(event.data) ?? {}
  const details = Object.entries(asRecord(data.details) ?? {}).filter(([key]) => !TEXT_DETAILS.has(key))
  const shown: JsonRecord = { ...data, message: text }
  delete shown.details
  for (const key of ['error', 'reason']) if (typeof shown[key] === 'string') shown[key] = text
  if (details.length > 0) shown.details = Object.fromEntries(details)
  return { ...event, data: Object.assign(shown, { [WITHHELD_FAILURE]: data }) }
}

/** Every model in the chain was refused by the product's model policy (`checkModelPolicy`'s refusal words), so a
 *  retry admits none. */
function noModelAllowed(error: ModelFailoverExhaustedError): boolean {
  return error.attempts.length > 0 && error.attempts.every((attempt) => attempt.reason?.includes(' is not admitted by policy: '))
}

/** A thrown sandbox stream as what the person reads, the operator's failure note, its code and its raw reason. */
export function sandboxStreamFailureDiagnostic(error: unknown): {
  userMessage: string
  failureNote: string
  code: string
  reason: string
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
  const failureNote = diagnosticText
    ? `sandbox-stream: ${message}; ${diagnosticText}`
    : `sandbox-stream: ${message}`
  const ownCode = asString(asRecord(error)?.code)
  let code = 'sandbox.stream_failed'
  if (error instanceof SandboxRunError) {
    code = error.code
  } else if (error instanceof ModelFailoverTimeoutError) {
    code = error.code
  } else if (error instanceof ModelFailoverExhaustedError) {
    code = noModelAllowed(error) ? 'model_policy_denied' : error.upstreamCode ?? code
  } else if (ownCode && REFUSAL_CODES.has(ownCode)) {
    code = ownCode
  }
  if (modelKeyRefusedSentence(message)) code = MODEL_KEY_REFUSED_CODE
  // A refusal reads as its own words: retrying would fail the same way.
  const userMessage = plainFailureSentence(message) ?? (REFUSAL_CODES.has(code) ? message : [
    'The sandbox model stream stopped before a clean completion.',
    `Error: ${message}`,
    'Please retry. If it repeats, send these support details to the team.',
  ].join('\n\n'))
  return { userMessage, failureNote, code, reason: message }
}

const UNAVAILABLE_TOOL_TEXT = "That tool isn't available."

/** A value with every `Available tools: …` tail cut off its strings. */
function withoutToolListTail(value: unknown): unknown {
  if (typeof value === 'string') return value.includes('Available tools:') ? value.replace(/\s*Available tools:[\s\S]*$/, '') : value
  if (Array.isArray(value)) return value.map(withoutToolListTail)
  const record = asRecord(value)
  return record ? Object.fromEntries(Object.entries(record).map(([key, item]) => [key, withoutToolListTail(item)])) : value
}

/** A tool part as the person may read it, live and stored: it never carries the harness's list of every tool. The
 *  harness's `invalid` repair tool, which stands in for a call to a tool the model does not have, reads one sentence. */
export function withoutToolList(part: JsonRecord): JsonRecord {
  const shown = withoutToolListTail(part) as JsonRecord
  if (shown.tool !== 'invalid') return shown
  const state: JsonRecord = { ...asRecord(shown.state), input: { ...asRecord(asRecord(shown.state)?.input), error: UNAVAILABLE_TOOL_TEXT } }
  for (const key of ['output', 'error']) if (typeof state[key] === 'string') state[key] = UNAVAILABLE_TOOL_TEXT
  return { ...shown, state }
}
