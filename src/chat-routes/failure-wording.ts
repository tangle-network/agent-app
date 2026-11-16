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

type Log = (message: string, meta?: Record<string, unknown>) => void

const utcTime = (at: Date) => `${at.toISOString().slice(11, 19)} UTC`

export const FAILED_TURN_TEXT = 'That answer stopped before it finished. Please send your question again.'
const ANSWER_COMPLETE_TEXT = 'The answer above is complete.'
const MODEL_KEY_REFUSED_TEXT = "The assistant's model refused its access key, so this message was not answered. "
  + 'If the assistant has just started, send it again in a minute; if this repeats, tell the team.'
const BUDGET_TEXT = "This assistant's spending budget is used up. Raise its cap or wait for it to reset, then send again."
const BALANCE_TEXT = 'Insufficient credits to cover this request. Add funds, then send again.'
const MODEL_POLICY_TEXT = "That model isn't available here. Choose another model and send again."
const RETRY_TEXT = 'The model provider is busy, so the request is being retried.'

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
  const refused = lower.includes('invalid api key') || (/\b401\b/.test(message)
    && (lower.includes('unauthorized') || lower.includes('unauthorised') || lower.includes('api key')))
  return refused ? MODEL_KEY_REFUSED_TEXT : undefined
}

/** The Router's refusals of a key's budget, and of a balance too low for one request. */
const ROUTER_BUDGET = ["This key's monthly budget is exhausted", "This key's lifetime budget is exhausted",
  "This key's remaining budget, after other in-flight requests, is below", 'The key or product budget cannot cover']
const ROUTER_BALANCE = ['Your available balance, after other in-flight requests, is below', 'Available credits cannot cover']

/** How a failure reads to the person: its class and that class's fixed sentence. */
export interface FailureView {
  class: string
  shown: string
}

/** Refusals by code, each as its fixed sentence: they fail the same way again, so none asks the person to resend. */
const REFUSALS = new Map<string, FailureView>([
  ['MODEL_REFUSED', { class: 'model_policy', shown: MODEL_POLICY_TEXT }],
  ['model_policy_denied', { class: 'model_policy', shown: MODEL_POLICY_TEXT }],
  ['grant_model_unsupported', { class: 'grant_model_unsupported',
    shown: "This assistant's model can't run here. Ask the team to choose a supported model." }],
  ['grant_activation_missing', { class: 'grant_activation_missing',
    shown: "This assistant couldn't connect to its model. Tell the team; sending again won't help." }],
  ['profile_unsupported', { class: 'profile_unsupported', shown: "This assistant's setup can't run here. Ask the team to update it." }],
])

/** Classes a person reads after a lead line, so a client that recognizes the stored failure prefix still finds them. */
const LED_CLASSES: ReadonlySet<string> = new Set(['funding', 'balance_low', 'model_policy', 'grant_model_unsupported',
  'grant_activation_missing', 'profile_unsupported'])

/** Warnings a person may read, each as a sentence written here; any other warning is dropped. */
const WARNING_SENTENCES = new Map<string, string>([
  ['empty_visible_output_retry', 'The model returned no visible answer, so it is trying once more.'],
  ['OPENCODE_STEP_TRUNCATED', 'A step of this answer was cut short, so the answer may be incomplete.'],
  ['OPENCODE_PROVIDER_RETRY', RETRY_TEXT],
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
  const last = lastAttempt(reason)
  const wait = providerResetSentence(last)
  if (wait) return { class: 'provider_wait', shown: wait }
  if (modelKeyRefusedSentence(last)) return { class: 'model_key_refused', shown: MODEL_KEY_REFUSED_TEXT }
  if (ROUTER_BUDGET.some((phrase) => last.includes(phrase))) return { class: 'budget_exhausted', shown: BUDGET_TEXT }
  if (ROUTER_BALANCE.some((phrase) => last.includes(phrase))) return { class: 'balance_low', shown: BALANCE_TEXT }
  const refusal = REFUSALS.get(code ?? '')
  if (refusal) return refusal
  const recovery = getChatFundingRecovery({ code, message: last })
    ?? (Number(status) === 402 || code === 'PAYMENT_REQUIRED' ? getChatFundingRecovery({ code: 'insufficient_credits' }) : null)
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

/** A closed-set `reason` (`provider_error`, `abort`) names a class, not prose, and stays as it is. */
const CODE_VALUE = /^[a-z0-9_.]+$/

/** The reason a failure carries, wherever its producer put it: in `data`, a nested error, a session error's
 *  properties, the top level, or a raw harness event. Empty when there is none, so a failure always reads its class. */
export function failureReason(event: unknown): string {
  const record = asRecord(event)
  const data = asRecord(record?.data)
  const error = asRecord(data?.error)
  const sessionError = asRecord(asRecord(data?.properties)?.error)
  const raw = asRecord(data?.event)
  const rawError = asRecord(raw?.error)
  const prose = typeof data?.reason === 'string' && !CODE_VALUE.test(data.reason) ? asString(data.reason) : undefined
  return asString(data?.message) ?? asString(data?.error) ?? asString(data?.detail) ?? prose
    ?? asString(error?.message) ?? asString(asRecord(error?.data)?.message)
    ?? asString(sessionError?.message) ?? asString(asRecord(sessionError?.data)?.message)
    ?? asString(record?.error) ?? asString(asRecord(record?.error)?.message) ?? asString(record?.message) ?? asString(record?.details)
    ?? asString(raw?.message) ?? asString(raw?.error) ?? asString(rawError?.message) ?? asString(asRecord(rawError?.data)?.message)
    ?? asString(asRecord(raw?.item)?.message) ?? ''
}

/** Event types that carry a failure reason; `done` and `status` do too when their status is `failed`. */
const FAILURE_TYPES: ReadonlySet<string> = new Set(['error', 'warning', 'session.run.failed', 'session.error'])

/** The only `details` a failure keeps for the client: values, never text. */
const DETAIL_KEYS: ReadonlySet<string> = new Set(['code', 'statusCode', 'retryable', 'retryAt', 'class'])

/** A failure event as the person reads it: every text field reads `shown`, `details` keeps only its value keys, and the
 *  original data, with its reason, rides under `WITHHELD_FAILURE`, which JSON (the wire, the turn buffer) drops. */
function shownFailure(event: JsonRecord, shown: string, reason: string): JsonRecord {
  const data = asRecord(event.data) ?? {}
  const visible: JsonRecord = { ...data }
  const shownError = (value: unknown): unknown => typeof value === 'string' || asRecord(value)
    ? { ...(typeof asRecord(value)?.code === 'string' ? { code: asRecord(value)!.code } : {}), message: shown } : value
  for (const key of ['message', 'detail']) if (key in visible) visible[key] = shown
  if ('error' in visible) visible.error = typeof visible.error === 'string' ? shown : shownError(visible.error)
  if (typeof visible.reason === 'string' && !CODE_VALUE.test(visible.reason)) visible.reason = shown
  const properties = asRecord(data.properties)
  if (properties && 'error' in properties) visible.properties = { ...properties, error: shownError(properties.error) }
  if (event.type === 'error' || event.type === 'session.run.failed') visible.message = shown
  const details = Object.entries(asRecord(data.details) ?? {}).filter(([key]) => DETAIL_KEYS.has(key))
  delete visible.details
  if (details.length > 0) visible.details = Object.fromEntries(details)
  const original = typeof data.message === 'string' ? data : { ...data, message: reason }
  const out: JsonRecord = { ...event, data: Object.assign(visible, { [WITHHELD_FAILURE]: original }) }
  if ('error' in event) out.error = typeof event.error === 'string' ? shown : shownError(event.error)
  if ('message' in event) out.message = shown
  delete out.details
  return out
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
    const key = [reason, code, Number(status) === 402].join('\n')
    const known = views.get(key)
    if (known) return known
    const settled = code?.startsWith('settlement_') ?? false
    // A settlement check that fails after a charged answer leaves that answer whole: sending again would charge again.
    const seen = classify(reason, code, status)
      ?? (settled && options.hasAnswer?.() ? { class: 'settlement', shown: ANSWER_COMPLETE_TEXT } : undefined)
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
      if (part?.type === 'tool') return { ...event, data: { ...data, event: { ...raw, part: withoutToolList(part) } } }
      const item = asRecord(raw.item)?.type === 'error' ? asRecord(raw.item) : undefined
      if (raw.type !== 'error' && raw.type !== 'retry' && raw.type !== 'turn.failed' && !('error' in raw) && !item) return event
      const shown = raw.type === 'retry' ? RETRY_TEXT : view(failureReason(event), undefined, undefined, failureIds(data)).shown
      return { ...event, data: { ...data, event: { ...raw, ...('message' in raw ? { message: shown } : {}),
        ...('error' in raw ? { error: { message: shown } } : {}), ...(item ? { item: { type: 'error', message: shown } } : {}) } } }
    }
    const failed = (event.type === 'done' || event.type === 'status') && data?.status === 'failed'
    if (!failed && !FAILURE_TYPES.has(String(event.type))) return event
    const reason = failureReason(event)
    if (event.type === 'warning') {
      const shown = warning(asString(data?.code), reason, failureIds(data))
      return shown ? shownFailure(event, shown, reason) : undefined
    }
    const status = data?.statusCode ?? (failed ? undefined : data?.status)
    return shownFailure(event, view(reason, asString(data?.code), status, failureIds(data)).shown, reason)
  }
  return { view, warning, event }
}

/** Every model in the chain was refused by the product's model policy (`checkModelPolicy`'s refusal words), so a
 *  retry admits none. */
function noModelAllowed(error: ModelFailoverExhaustedError): boolean {
  return error.attempts.length > 0 && error.attempts.every((attempt) => attempt.reason?.includes(' is not admitted by policy: '))
}

/** A thrown sandbox stream as the operator's failure note, its code and its raw reason. */
export function sandboxStreamFailureDiagnostic(error: unknown): { failureNote: string; code: string; reason: string } {
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
  } else if (ownCode && (REFUSALS.has(ownCode) || ownCode === 'PAYMENT_REQUIRED' || ownCode.startsWith('settlement_'))) {
    code = ownCode
  }
  if (modelKeyRefusedSentence(message)) code = MODEL_KEY_REFUSED_CODE
  return { failureNote, code, reason: message }
}

/** The typed reason a sandbox `error` event carries, or a generic stream-error code. */
export function sandboxStreamErrorCode(data: unknown): string {
  return asString(asRecord(data)?.code) ?? 'sandbox.stream_error'
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
  const state = asRecord(part.state)
  if (!state) return part
  const invalid = part.tool === 'invalid'
  const shown: JsonRecord = { ...state }
  for (const key of ['error', 'output']) {
    if (typeof shown[key] !== 'string' || (key === 'output' && !invalid && state.status !== 'error')) continue
    shown[key] = invalid ? UNAVAILABLE_TOOL_TEXT : withoutToolListTail(shown[key] as string)
  }
  if (invalid) shown.input = { ...asRecord(state.input), error: UNAVAILABLE_TOOL_TEXT }
  return { ...part, state: shown }
}
