/**
 * What a person reads when a sandbox turn fails: only sentences written here. Harness, provider and Router text is read
 * only to classify the failure, by its code, its HTTP status or a recognized phrase, and the person reads that class's
 * fixed sentence. No part of the reason is shown; the only values in a sentence are times parsed and formatted here.
 * The server keeps the reason, in its log and under a Symbol key the route's own failure hooks read. `personFacing`
 * applies this to every event the sandbox producer yields.
 */

import { ModelFailoverExhaustedError } from '../model-resolution/failover'
import { SandboxRunError } from '../sandbox/sandbox-run-error'
import { asRecord, asString, type JsonRecord } from '../stream/index'
import { getChatFundingRecovery } from '../web/turn-funding-recovery'
import { ModelFailoverTimeoutError } from './model-failover-stream'
import { WITHHELD_FAILURE } from './turn-event-stream'
import { TURN_USAGE_KEYS } from './sandbox-turn-usage'

type Log = (message: string, meta?: Record<string, unknown>) => void

const utcTime = (at: Date) => `${at.toISOString().slice(11, 19)} UTC`

export const FAILED_TURN_TEXT = 'That answer stopped before it finished. Please send your question again.'
const SENTENCES = {
  settlement: 'The answer above is complete.',
  model_key_refused: "The assistant's model refused its access key, so this message was not answered. "
    + 'If the assistant has just started, send it again in a minute; if this repeats, tell the team.',
  budget_exhausted: "This assistant's spending budget is used up. Raise its cap or wait for it to reset, then send again.",
  balance_low: 'Insufficient credits to cover this request. Add funds, then send again.',
  model_policy: "That model isn't available here. Choose another model and send again.",
  grant_model_unsupported: "This assistant's model can't run here. Ask the team to choose a supported model.",
  grant_activation_missing: "This assistant couldn't connect to its model. Tell the team; sending again won't help.",
  profile_unsupported: "This assistant's setup can't run here. Ask the team to update it.",
  provider_retry: 'The model provider is busy, so the request is being retried.',
}

/** A harness's provider retry wait (OpenCode's raw `retry` status) as one sentence with its next attempt's time. */
export function providerRetryNotice(event: { type: string; data?: unknown }): string | undefined {
  const retry = event.type === 'raw' ? asRecord(asRecord(event.data)?.event) : undefined
  if (retry?.type !== 'retry' || !(Number(retry.next) > 0)) return undefined
  return `The model provider is busy; retrying at ${utcTime(new Date(Number(retry.next)))}.`
}

/** A terminal provider wait (`…, reset at <ISO>`, agent-container provider-retry-wait.ts) as one sentence with its time. */
export function providerResetSentence(message: string): string | undefined {
  const at = new Date(message.match(/reset at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)?.[1] ?? NaN)
  if (Number.isNaN(at.getTime())) return undefined
  return `The model provider asked us to wait. Try again after ${utcTime(at)} on ${at.toISOString().slice(0, 10)}.`
}

/** The typed code for a harness whose model refused its key, so a product can tell it from other stream failures. */
export const MODEL_KEY_REFUSED_CODE = 'model.key_refused'

/** A harness whose model provider refused its key ("Invalid API key", OpenCode's `OPENCODE_ERROR`) as plain words, true
 *  both for a newly started box whose harness called the model before its minted key was in place (it recovers within
 *  minutes) and for a key that is wrong. The raw error goes to the log, never to the person. */
export function modelKeyRefusedSentence(message: string): string | undefined {
  const lower = message.toLowerCase()
  const refused = lower.includes('invalid api key') || (/\b401\b/.test(message) && /unauthori[sz]ed|api key/.test(lower))
  return refused ? SENTENCES.model_key_refused : undefined
}

/** The Router's refusals of a key's budget, and of a balance too low for one request. */
const ROUTER_BUDGET = ["This key's monthly budget is exhausted", "This key's lifetime budget is exhausted",
  'Monthly budget exceeded (', 'The key or product budget cannot cover']

/** How a failure reads to the person: its class and that class's fixed sentence. */
export interface FailureView {
  class: string
  shown: string
}

/** Refusals by code, each as its fixed sentence: they fail the same way again, so none asks the person to resend. */
const REFUSALS = new Map<string, keyof typeof SENTENCES>([
  ['MODEL_REFUSED', 'model_policy'], ['model_policy_denied', 'model_policy'], ['budget_exceeded', 'budget_exhausted'],
  ['grant_model_unsupported', 'grant_model_unsupported'], ['grant_activation_missing', 'grant_activation_missing'],
  ['profile_unsupported', 'profile_unsupported'], [MODEL_KEY_REFUSED_CODE, 'model_key_refused'],
])

/** Classes a person reads after a lead line, so a client that recognizes the stored failure prefix still finds them. */
const LED_CLASSES: ReadonlySet<string> = new Set(['funding', 'balance_low', 'model_policy', 'grant_model_unsupported',
  'grant_activation_missing', 'profile_unsupported'])

/** Warnings a person may read, each as a sentence written here; any other warning is dropped. */
const WARNING_SENTENCES = new Map<string, string>([
  ['empty_visible_output_retry', 'The model returned no visible answer, so it is trying once more.'],
  ['OPENCODE_STEP_TRUNCATED', 'A step of this answer was cut short, so the answer may be incomplete.'],
  ['OPENCODE_PROVIDER_RETRY', SENTENCES.provider_retry],
  ['CODEX_UNEXPECTED_APPROVAL', 'The agent asked for an approval it does not need here, and it was declined.'],
  ['CODEX_UNEXPECTED_QUESTION', 'The agent asked a question it cannot ask here, and it was declined.'],
  ['EXECUTION_INTERRUPTED', 'This answer was interrupted before it finished.'],
  ['FILE_DENIED', 'The agent was refused access to a file.'],
])

/** A model failover trail: `All N model(s) failed. <model>: <reason> | <model>: <reason>`. */
const FAILOVER_TRAIL = /^All \d+ model\(s\) failed\. /

/** A failover trail read for its last attempt only; any other reason as it is. */
function lastAttempt(reason: string): string {
  if (!FAILOVER_TRAIL.test(reason)) return reason
  const attempts = reason.replace(FAILOVER_TRAIL, '')
  const last = attempts.slice(attempts.lastIndexOf(' | ') + 1).replace(/^\| /, '')
  const colon = last.indexOf(': ')
  return colon < 0 ? last : last.slice(colon + 2)
}

/** The class of a failure and its sentence, or `undefined` for the default, withheld class. Linear in the reason. */
function classify(reason: string, code: string | undefined, status: unknown): FailureView | undefined {
  const refusal = REFUSALS.get(code ?? '')
  if (refusal) return { class: refusal, shown: SENTENCES[refusal] }
  const funding = getChatFundingRecovery({ code: code === 'PAYMENT_REQUIRED' ? 'insufficient_credits' : code })
  const last = lastAttempt(reason)
  if (!funding) {
    const wait = providerResetSentence(last)
    if (wait) return { class: 'provider_wait', shown: wait }
    const kind = modelKeyRefusedSentence(last) ? 'model_key_refused'
      : ROUTER_BUDGET.some((phrase) => last.includes(phrase)) ? 'budget_exhausted'
      : last.includes('Available credits cannot cover') ? 'balance_low' : undefined
    if (kind) return { class: kind, shown: SENTENCES[kind] }
  }
  const recovery = funding ?? getChatFundingRecovery({ message: last })
    ?? (Number(status) === 402 ? getChatFundingRecovery({ code: 'insufficient_credits' }) : null)
  if (!recovery) return undefined
  // The recovery UI's own words, so a client that reads the sentence still opens billing.
  const paidAccess = recovery.reason === 'paid_access_required' ? 'Inference requires verified paid access. ' : ''
  return { class: 'funding', shown: `${recovery.title}. ${paidAccess}${recovery.message}` }
}

/** The turn, thread, session and execution ids a record carries, for the server log. */
export function failureIds(source: unknown): Record<string, string> {
  const record = asRecord(source)
  return Object.fromEntries(['turnId', 'threadId', 'sessionId', 'executionId']
    .flatMap((key) => typeof record?.[key] === 'string' && record[key] ? [[key, record[key] as string]] : []))
}

/** The text a failure adds to the answer: its sentence, after a lead line for the classes that carry one. */
export function failureText(view: FailureView, partialAnswer: string): string {
  if (!LED_CLASSES.has(view.class)) return view.shown
  const lead = partialAnswer.trim()
    ? 'The sandbox model stream stopped before a clean completion.'
    : 'The sandbox agent returned an error before producing a visible answer.'
  return `${lead}\n\nError: ${view.shown}`
}

/** Protocol reason values, not arbitrary identifiers or prose. */
const REASONS = new Set(['provider_error', 'abort'])
const USAGE_KEYS = new Set<string>([...TURN_USAGE_KEYS, 'cacheReadInputTokens', 'cacheCreationInputTokens', 'cost', 'totalCostUsd'])

/** Failure carriers in precedence order, shared by the reason and code extractors. */
function failureSources(event: unknown) {
  const record = asRecord(event)
  const data = asRecord(record?.data)
  const raw = asRecord(data?.event)
  return [data, asRecord(data?.error), asRecord(asRecord(data?.properties)?.error), record, asRecord(record?.error),
    raw, asRecord(raw?.error), asRecord(raw?.item)]
}

/** The reason stays server-side; a closed protocol reason is a class, not prose. */
export function failureReason(event: unknown): string {
  for (const row of failureSources(event)) {
    const reason = asString(row?.message) ?? asString(row?.error) ?? asString(row?.detail) ?? asString(row?.details)
      ?? (REASONS.has(String(row?.reason)) ? undefined : asString(row?.reason)) ?? asString(asRecord(row?.data)?.message)
    if (reason) return reason
  }
  return ''
}

/** Event types that carry a failure reason; `done` and `status` do too when their status is `failed`. */
const FAILURE_TYPES: ReadonlySet<string> = new Set(['error', 'warning', 'session.run.failed', 'session.error'])

/** One code extractor for the wire, raw harness events and the answer text. */
export function failureCode(event: unknown): string | undefined {
  return failureSources(event).map((row) => asString(row?.code)).find(Boolean)
}

/** Allowed fields must also have scalar values: a known key cannot smuggle a nested reason onto the wire. */
function visibleValues(data: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(data).filter(([key, value]) => {
    if (['turnId', 'threadId', 'sessionId', 'executionId', 'code'].includes(key)) return typeof value === 'string' && /^[\w.:-]+$/.test(value)
    if (key === 'reason') return typeof value === 'string' && REASONS.has(value)
    if (key === 'retryable') return typeof value === 'boolean'
    if (key === 'status' && value === 'failed') return true
    return (['status', 'statusCode', 'retryAt', 'resetAt'].includes(key) || USAGE_KEYS.has(key)) && typeof value === 'number' && Number.isFinite(value)
  }))
}

/** A failure event as the person reads it: every text field reads `shown`, `details` keeps only its value keys, and the
 *  original data, with its reason, rides under `WITHHELD_FAILURE`, which JSON (the wire, the turn buffer) drops. */
function shownFailure(event: JsonRecord, shown: string, reason: string): JsonRecord {
  const data = asRecord(event.data) ?? {}
  const visible = { ...visibleValues(data), ...visibleValues({ code: failureCode(event) }), message: shown }
  const details = visibleValues(asRecord(data.details) ?? {})
  if (Object.keys(details).length) Object.assign(visible, { details })
  for (const key of ['usage', 'tokenUsage']) {
    const usage = Object.fromEntries(Object.entries(asRecord(data[key]) ?? {}).filter(([name, value]) =>
      USAGE_KEYS.has(name) && typeof value === 'number' && Number.isFinite(value)))
    if (Object.keys(usage).length) Object.assign(visible, { [key]: usage })
  }
  const original = typeof data.message === 'string' ? data : { ...data, message: reason }
  return { type: event.type, data: Object.assign(visible, { [WITHHELD_FAILURE]: original }) }
}

/** One turn's person-facing filter. `view` classifies a failure reason; every reason is logged once, at warn (`log`,
 *  else `console.warn`), with its class and ids, and the same reason reads the same wherever it appears. `warning`
 *  gives an allowed warning's sentence. `event` is every event the producer yields as it may reach the client.
 *  `hasAnswer` says whether the turn already shows answer text. */
export function personFacing(options: { log?: Log; failedTurnText: string; hasAnswer?: () => boolean }) {
  const views = new Map<string, FailureView>()
  const droppedWarnings = new Set<string>()
  const warn = (message: string, meta: Record<string, unknown>) => (options.log ?? console.warn)(message, meta)
  const view = (reason: string, code?: string, status?: unknown, meta: Record<string, unknown> = {}): FailureView => {
    const settled = code?.startsWith('settlement_') ?? false
    const answered = settled && options.hasAnswer?.()
    const key = [reason, code, Number(status) === 402, answered].join('\n')
    const known = views.get(key)
    if (known) return known
    // A settlement check that fails after a charged answer leaves that answer whole: sending again would charge again.
    const seen = (answered ? { class: 'settlement', shown: SENTENCES.settlement } : undefined)
      ?? classify(reason, code, status)
      ?? { class: settled ? 'settlement' : 'runtime_failure', shown: options.failedTurnText }
    warn('[chat-routes] turn failure withheld from the person', { failureClass: seen.class, code, error: reason, ...meta })
    views.set(key, seen)
    return seen
  }
  /** An allowed warning's sentence, or `undefined` for any other warning, which is dropped and logged once. */
  const warning = (code: string | undefined, message: string, meta: Record<string, unknown> = {}): string | undefined => {
    const shown = WARNING_SENTENCES.get(code ?? '')
    if (shown || droppedWarnings.has(`${code}\n${message}`)) return shown
    droppedWarnings.add(`${code}\n${message}`)
    warn('[chat-routes] harness warning withheld from the person', { failureClass: 'harness_warning', code, error: message, ...meta })
    return undefined
  }
  /** An event as it may reach the client, or `undefined` for a dropped warning. A failure carrier always reads its class's
   *  sentence, even when no reason can be found in it. */
  const event = (event: JsonRecord): JsonRecord | undefined => {
    const data = asRecord(event.data)
    const raw = event.type === 'raw' ? asRecord(data?.event) : undefined
    if (raw) {
      const part = asRecord(raw.part)
      const item = asRecord(raw.item)?.type === 'error' ? asRecord(raw.item) : undefined
      if (raw.type !== 'error' && raw.type !== 'retry' && raw.type !== 'turn.failed' && !('error' in raw) && !item) {
        return part?.type === 'tool' ? { ...event, data: { ...data, event: { ...raw, part: withoutToolList(part) } } } : event
      }
      const reason = failureReason(event)
      const shown = raw.type === 'retry' ? SENTENCES.provider_retry : view(reason, failureCode(event), raw.statusCode ?? raw.status, failureIds(data)).shown
      return { type: 'raw', data: { ...(shownFailure(event, shown, reason).data as JsonRecord),
        event: { type: raw.type === 'retry' ? 'retry' : 'error', ...visibleValues({ code: failureCode(event) }), message: shown } } }
    }
    const failed = (event.type === 'done' || event.type === 'status') && data?.status === 'failed'
    if (!failed && !FAILURE_TYPES.has(String(event.type))) return event
    const reason = failureReason(event)
    if (event.type === 'warning') {
      const shown = warning(failureCode(event), reason, failureIds(data))
      return shown ? shownFailure(event, shown, reason) : undefined
    }
    const status = data?.statusCode ?? (failed ? undefined : data?.status)
    return shownFailure(event, view(reason, failureCode(event), status, failureIds(data)).shown, reason)
  }
  return { view, warning, event }
}

/** A thrown sandbox stream as the operator's failure note, its code and its raw reason. */
export function sandboxStreamFailureDiagnostic(error: unknown): { failureNote: string; code: string; reason: string } {
  const streamMessage = (error as { streamMessage?: unknown })?.streamMessage
  const message = typeof streamMessage === 'string'
    ? streamMessage
    : error instanceof Error ? error.message : 'Sandbox stream failed'
  let failureNote = `sandbox-stream: ${message}`
  try {
    const diagnostics = asRecord((error as { diagnostics?: unknown })?.diagnostics)
    if (diagnostics) failureNote += `; ${JSON.stringify(diagnostics)}`
  } catch {
    failureNote += '; [unserializable diagnostics]'
  }
  const ownCode = asString(asRecord(error)?.code)
  const last = error instanceof ModelFailoverExhaustedError ? error.attempts.at(-1) : undefined
  const reason = last?.reason ?? message
  let code = 'sandbox.stream_failed'
  if (error instanceof SandboxRunError) {
    code = error.code
  } else if (error instanceof ModelFailoverTimeoutError) {
    code = error.code
  } else if (error instanceof ModelFailoverExhaustedError) {
    code = last?.errorCode ?? (last && error.attempts.every((attempt) => attempt.reason?.includes(' is not admitted by policy: '))
      ? 'model_policy_denied' : code)
  } else if (ownCode && (REFUSALS.has(ownCode) || getChatFundingRecovery({ code: ownCode })
    || ownCode === 'PAYMENT_REQUIRED' || ownCode.startsWith('settlement_'))) {
    code = ownCode
  }
  if (modelKeyRefusedSentence(reason) && code === 'sandbox.stream_failed') code = MODEL_KEY_REFUSED_CODE
  return { failureNote, code, reason }
}

const UNAVAILABLE_TOOL_TEXT = "That tool isn't available."

/** Text without the list of every tool a harness appends to a refused or repeated tool call. */
function withoutToolListTail(text: string): string {
  const at = text.indexOf('Available tools:')
  return at < 0 ? text : text.slice(0, at).trimEnd()
}

/** A tool part as the person may read it, live and stored: a failed call's `error` and `output` lose the harness's list
 *  of every tool, and the harness's `invalid` repair tool, which stands in for a call to a tool the model does not have,
 *  reads one sentence. Inputs, metadata and a completed call's output (a document it read) stay whole. */
export function withoutToolList(part: JsonRecord): JsonRecord {
  // Bare tool_result events have flat fields until recordPersistedPart normalizes them.
  const nested = asRecord(part.state)
  const state = nested ?? part
  const invalid = part.tool === 'invalid'
  const shown: JsonRecord = { ...state }
  for (const key of ['error', 'output']) {
    if (typeof shown[key] !== 'string' || (key === 'output' && !invalid && state.status !== 'error')) continue
    shown[key] = invalid ? UNAVAILABLE_TOOL_TEXT : withoutToolListTail(shown[key] as string)
  }
  if (invalid) shown.input = { ...asRecord(state.input), error: UNAVAILABLE_TOOL_TEXT }
  return nested ? { ...part, state: shown } : shown
}
