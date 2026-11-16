/**
 * What a person reads when a sandbox turn fails. A reason the producer can word plainly (a provider wait, a refused
 * model key, the Router's own budget or balance refusal) becomes that sentence. A refusal that would fail the same way
 * again, and a funding, billing or admission refusal the client's recovery UI reads, keep their own words, cleaned of
 * everything a person should not read: the harness's wrapper, a tool list, a request's method and path, a URL, an API
 * path, an HTTP status. A model failover trail is read for its last attempt only, never its model ids. Any other reason
 * (a harness error, a tool list, a repeated-call loop, a stack) is withheld: the person reads one plain sentence and
 * the server keeps the reason, in its log and under a Symbol key the route's own failure hooks read. `personFacing`
 * applies this to every event the sandbox producer yields.
 */

import { ModelFailoverExhaustedError } from '../model-resolution/failover'
import { SandboxRunError } from '../sandbox/sandbox-run-error'
import { asRecord, asString, type JsonRecord } from '../stream/index'
import { getChatFundingRecovery } from '../web/turn-funding-recovery'
import { ModelFailoverTimeoutError, summarizeFailoverReason } from './model-failover-stream'
import { WITHHELD_FAILURE } from './turn-event-stream'

type Log = (message: string, meta?: Record<string, unknown>) => void

const utcTime = (at: Date) => `${at.toISOString().slice(11, 19)} UTC`

/** The list of every tool a harness appends to a refused or repeated tool call, to the end of its text. */
const TOOL_LIST_TAIL = /\s*Available tools:[\s\S]*$/

/** A request's method and path, a URL and a bare API path. */
const REQUEST_DETAIL = /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/\S*|https?:\/\/\S+|(?<![\w.])\/(?:v\d+|api)\/\S*/g

const STATUS_TEXT = 'Bad Gateway|Service Unavailable|Gateway Timeout|Internal Server Error|Too Many Requests|Payment Required'
  + '|Bad Request|Unauthorized|Forbidden|Not Found'

/** An HTTP status (`HTTP 502`, `(status 503)`, `status code 429`) with its text, and a bare status beside its text. */
const STATUS_DETAIL = new RegExp(`\\(?\\b(?:HTTP(?:\\/\\d(?:\\.\\d)?)?|status(?: code)?)\\s*\\d{3}\\b\\)?(?:\\s+(?:${STATUS_TEXT}))?`
  + `|\\b[45]\\d\\d\\s+(?:${STATUS_TEXT})`, 'gi')

/** A reason as a person may read it: without the harness's wrapper (its `<harness> execution failed:` prefix, a tool
 *  list, an exit status), a request's method and path, a URL, an API path, an HTTP status, or the model id a policy
 *  refusal names. */
function cleaned(text: string): string {
  const shown = text.replace(/^[\w.-]+ execution failed:\s*/, '').replace(TOOL_LIST_TAIL, '')
    .replace(/\s*\((?:exit code|killed by)[^)]*\)\s*$/, '')
    .replace(/\bmodel "[^"]+" (?=is not admitted by policy)/g, 'the model ')
    .replace(REQUEST_DETAIL, ' ').replace(STATUS_DETAIL, ' ')
    .replace(/\(\s*\)/g, ' ').replace(/\s+/g, ' ').trim().replace(/\s+([.,;:])/g, '$1')
    // Words left hanging where a removed path or status stood.
    .replace(/\s+(?:at|to|from|on|via|returned|with)(?=[.,;:]|$)/g, '')
    .replace(/^(?:[\s.,;:-]|returned\b|with\b)+/, '').replace(/[\s,;:-]+$/, '')
  return shown.charAt(0).toUpperCase() + shown.slice(1)
}

/** A harness's provider retry wait (OpenCode's raw `retry` status) as one sentence: the provider's words and the next attempt. */
export function providerRetryNotice(event: { type: string; data?: unknown }): string | undefined {
  const retry = event.type === 'raw' ? asRecord(asRecord(event.data)?.event) : undefined
  if (retry?.type !== 'retry' || !(Number(retry.next) > 0)) return undefined
  const message = asString(retry.message)?.trim()
  const cause = (message && cleaned(summarizeFailoverReason(message))) || 'no reason given'
  return `The model provider refused the call (${cause}), so the turn retries at ${utcTime(new Date(Number(retry.next)))}.`
}

/** A terminal provider wait (`…, reset at <ISO>`, agent-container provider-retry-wait.ts) as one sentence. */
export function providerResetSentence(message: string): string | undefined {
  const at = new Date(message.match(/reset at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)?.[1] ?? NaN)
  if (Number.isNaN(at.getTime())) return undefined
  const cause = cleaned(message.split('; the provider asked')[0] ?? '')
  return `The model provider refused the call${cause ? ` (${cause})` : ''}; try again after ${utcTime(at)} on ${at.toISOString().slice(0, 10)}.`
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

/** A failure reason as the plain sentence the person reads, when the producer has one for it. The Router's refusal is
 *  its own first sentence, cleaned. */
function plainFailureSentence(message: string): string | undefined {
  const router = message.slice(Math.max(0, message.search(ROUTER_REFUSAL)))
  const end = router.indexOf('. ')
  return providerResetSentence(message) ?? modelKeyRefusedSentence(message)
    ?? (ROUTER_REFUSAL.test(message) ? cleaned(end < 0 ? router.split('\n')[0]! : router.slice(0, end + 1)) : undefined)
}

/** A model failover trail: `All N model(s) failed. <model>: <reason> | <model>: <reason>`. */
const FAILOVER_TRAIL = /^All \d+ model\(s\) failed\. /

/** A failover trail read for its last attempt only, without its model id; any other reason as it is. */
function lastAttempt(reason: string): string {
  if (!FAILOVER_TRAIL.test(reason)) return reason
  return reason.replace(FAILOVER_TRAIL, '').split(' | ').at(-1)!.replace(/^\S+?: /, '')
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

export const FAILED_TURN_TEXT = 'That answer stopped before it finished. Please send your question again.'

/** What the person reads when a charged answer's settlement check fails after it: sending again would charge again. */
const ANSWER_COMPLETE_TEXT = 'The answer above is complete.'

/** Refusals that fail the same way again, whose product-written words and code the person acts on: a payment refusal;
 *  a model-policy refusal (`MODEL_REFUSED` from the box, `model_policy_denied` when the policy admits no model in the
 *  chain); and the protected lane's refusal of its model, its activation or its profile. */
const REFUSAL_CODES: ReadonlySet<string> = new Set(['PAYMENT_REQUIRED', 'MODEL_REFUSED', 'model_policy_denied',
  'grant_model_unsupported', 'grant_activation_missing', 'profile_unsupported'])

/** Own words shorter than this, once cleaned, say nothing: the person reads the failed-turn text and the code stays. */
const MIN_SHOWN_LENGTH = 12

/** Harness text a warning never shows: the harness's wrapper, a tool list, a stack, a request's method and path, a URL
 *  or API path, or a model failover trail. */
const HARNESS_TEXT = new RegExp([
  '\\b[\\w.-]+ execution failed:', '\\((?:exit code|killed by)[^)]*\\)', 'Available tools:', '\\n\\s+at \\S',
  '\\b(?:GET|POST|PUT|PATCH|DELETE) \\/', 'https?:\\/\\/', '(?<![\\w.])\\/(?:v\\d+|api)\\/', FAILOVER_TRAIL.source,
].join('|'))

/** Event types that carry a failure reason; `done` and `status` do too when their status is `failed`. */
const FAILURE_TYPES: ReadonlySet<string> = new Set(['error', 'warning', 'session.run.failed', 'session.error'])

/** Detail fields a client renders as text (`supportDetails`, `hint`) or that carry the raw reason. */
const TEXT_DETAILS: ReadonlySet<string> = new Set(['supportDetails', 'hint', 'failureNote', 'raw'])

/** A closed-set `reason` (`provider_error`, `abort`) names a class, not prose, and stays as it is. */
const CODE_VALUE = /^[a-z0-9_.]+$/

/** How a failure reads to the person: its plain sentence, its own words, or withheld behind the failed-turn text. */
export interface FailureView {
  kind: 'plain' | 'own' | 'withheld'
  shown: string
}

/** A reason the person may read: its last attempt as a plain sentence, or in its own words when it passes (HTTP 402, a
 *  {@link REFUSAL_CODES} refusal, or what the client's recovery UI reads: `getChatFundingRecovery`'s
 *  `insufficient_credits`, `paid_access_required`, `funding_required` or its words). `undefined` when it is withheld. */
function classify(reason: string, code: string | undefined, status: unknown): FailureView | undefined {
  const last = lastAttempt(reason)
  const plain = plainFailureSentence(last)
  if (plain) return { kind: 'plain', shown: plain }
  const passes = Number(status) === 402 || REFUSAL_CODES.has(code ?? '')
    || getChatFundingRecovery({ code, message: last })
  const own = passes ? cleaned(last) : ''
  return own.length >= MIN_SHOWN_LENGTH ? { kind: 'own', shown: own } : undefined
}

/** The turn, thread, session and execution ids a record carries, for the server log. */
export function failureIds(source: unknown): Record<string, string> {
  const record = asRecord(source)
  return Object.fromEntries(['turnId', 'threadId', 'sessionId', 'executionId']
    .flatMap((key) => typeof record?.[key] === 'string' && record[key] ? [[key, record[key] as string]] : []))
}

/** The text a failure adds to the answer: a plain sentence or the failed-turn text alone, or its own words after a
 *  lead that says whether a partial answer came first. */
export function failureText(view: FailureView, partialAnswer: string): string {
  if (view.kind !== 'own') return view.shown
  const lead = partialAnswer.trim()
    ? 'The sandbox model stream stopped before a clean completion.'
    : 'The sandbox agent returned an error before producing a visible answer.'
  return `${lead}\n\nError: ${view.shown}`
}

/** The reason a failure event carries: in `data` (a session error nests it under `properties.error`), else at the top
 *  level, else (for `error`) the whole data. */
function failureReason(event: JsonRecord): string | undefined {
  const data = asRecord(event.data)
  const prose = (value: unknown) => typeof value === 'string' && value && !CODE_VALUE.test(value) ? value : undefined
  return asString(data?.message) ?? asString(data?.error) ?? asString(data?.detail) ?? prose(data?.reason)
    ?? asString(asRecord(data?.error)?.message) ?? asString(asRecord(asRecord(data?.properties)?.error)?.message)
    ?? asString(event.error) ?? asString(asRecord(event.error)?.message) ?? asString(event.details)
    ?? (event.type === 'error' ? sandboxStreamErrorMessage(data) : undefined)
}

/** A failure event as the person reads it: every reason field reads `shown`, the text detail fields are dropped, and the
 *  original data, with its reason, rides under `WITHHELD_FAILURE`, which JSON (the wire, the turn buffer) drops. */
function shownFailure(event: JsonRecord, shown: string, reason: string): JsonRecord {
  const data = asRecord(event.data) ?? {}
  const visible: JsonRecord = { ...data }
  // An error object keeps only its code beside the shown message.
  const shownError = (value: unknown): unknown => {
    const error = asRecord(value)
    if (typeof value === 'string') return shown
    return error ? { ...(typeof error.code === 'string' ? { code: error.code } : {}), message: shown } : value
  }
  for (const key of ['message', 'detail']) if (typeof visible[key] === 'string') visible[key] = shown
  if ('error' in visible) visible.error = shownError(visible.error)
  const properties = asRecord(data.properties)
  if (properties && 'error' in properties) visible.properties = { ...properties, error: shownError(properties.error) }
  if (typeof visible.reason === 'string' && !CODE_VALUE.test(visible.reason)) visible.reason = shown
  if (event.type === 'error' || event.type === 'session.run.failed') visible.message = shown
  const details = Object.entries(asRecord(data.details) ?? {}).filter(([key]) => !TEXT_DETAILS.has(key))
  delete visible.details
  if (details.length > 0) visible.details = Object.fromEntries(details)
  const original = typeof data.message === 'string' ? data : { ...data, message: reason }
  const out: JsonRecord = { ...event, data: Object.assign(visible, { [WITHHELD_FAILURE]: original }) }
  if ('error' in event) out.error = shownError(event.error)
  delete out.details
  return out
}

/** A harness's raw event as the person may read it: a raw tool part without its tool list, and any raw error (an `error`,
 *  `error.message`, or an error item) behind `view`. */
function shownRaw(event: JsonRecord, view: (reason: string) => FailureView): JsonRecord {
  const data = asRecord(event.data)
  const raw = asRecord(data?.event)
  if (!data || !raw) return event
  const part = asRecord(raw.part)
  if (part?.type === 'tool') return { ...event, data: { ...data, event: { ...raw, part: withoutToolList(part) } } }
  const error = asRecord(raw.error)
  const item = asRecord(raw.item)?.type === 'error' ? asRecord(raw.item) : undefined
  const reason = asString(raw.error) ?? asString(asRecord(error?.data)?.message) ?? asString(error?.message) ?? asString(item?.message)
  if (!reason) return event
  const shown = view(reason).shown
  return { ...event, data: { ...data, event: { ...raw, ...('error' in raw ? { error: { message: shown } } : {}),
    ...(item ? { item: { ...item, message: shown } } : {}) } } }
}

/** One turn's person-facing filter. `view` says how a failure reason reads to the person; a withheld reason is logged
 *  once, at warn (`log`, else `console.warn`), under one class with the ids the failure carries, and the same reason
 *  reads the same wherever it appears. `warning` says how a warning reads. `event` is every event the producer yields as
 *  it may reach the client. `hasAnswer` says whether the turn already shows answer text. */
export function personFacing(options: { log?: Log; failedTurnText: string; hasAnswer?: () => boolean }) {
  const views = new Map<string, FailureView>()
  const droppedWarnings = new Set<string>()
  const warn = (message: string, meta: Record<string, unknown>) => (options.log ?? console.warn)(message, meta)
  const view = (reason: string, code?: string, status?: unknown, meta: Record<string, unknown> = {}): FailureView => {
    const key = [reason, code, Number(status) === 402].join('\n')
    let seen = views.get(key) ?? classify(reason, code, status)
    if (!seen) {
      warn('[chat-routes] turn failure withheld from the person', { failureClass: 'runtime_failure', code, error: reason, ...meta })
      seen = { kind: 'withheld', shown: options.failedTurnText }
      // A settlement check that fails after a charged answer leaves that answer whole: sending again would charge again.
      if (code?.startsWith('settlement_') && options.hasAnswer?.()) seen = { kind: 'plain', shown: ANSWER_COMPLETE_TEXT }
    }
    views.set(key, seen)
    return seen
  }
  /** A warning that words a failure plainly or in its own words reads as that text; one that carries harness text is
   *  dropped (`undefined`) and logged once as a harness warning, never as a turn failure; any other reads as it came. */
  const warning = (message: string, code?: string, status?: unknown, meta: Record<string, unknown> = {}): FailureView | undefined => {
    const seen = classify(message, code, status)
    if (seen) return seen
    if (!HARNESS_TEXT.test(message)) return { kind: 'own', shown: message }
    if (!droppedWarnings.has(message)) {
      droppedWarnings.add(message)
      warn('[chat-routes] harness warning withheld from the person', { failureClass: 'harness_warning', code, error: message, ...meta })
    }
    return undefined
  }
  /** An event as it may reach the client, or `undefined` for a dropped warning, which leaves nothing to show. */
  const event = (event: JsonRecord): JsonRecord | undefined => {
    const data = asRecord(event.data)
    if (event.type === 'raw') return shownRaw(event, (reason) => view(reason, undefined, undefined, failureIds(data)))
    const failed = (event.type === 'done' || event.type === 'status') && data?.status === 'failed'
    if (!failed && !FAILURE_TYPES.has(String(event.type))) return event
    const reason = failureReason(event)
    if (!reason) return event
    const status = data?.statusCode ?? (failed ? undefined : data?.status)
    const seen = event.type === 'warning'
      ? warning(reason, asString(data?.code), status, failureIds(data))
      : view(reason, asString(data?.code), status, failureIds(data))
    return seen ? shownFailure(event, seen.shown, reason) : undefined
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
  } else if (ownCode && (REFUSAL_CODES.has(ownCode) || ownCode.startsWith('settlement_'))) {
    code = ownCode
  }
  if (modelKeyRefusedSentence(message)) code = MODEL_KEY_REFUSED_CODE
  return { failureNote, code, reason: message }
}

const UNAVAILABLE_TOOL_TEXT = "That tool isn't available."

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
    shown[key] = invalid ? UNAVAILABLE_TOOL_TEXT : (shown[key] as string).replace(TOOL_LIST_TAIL, '')
  }
  if (invalid) shown.input = { ...asRecord(state.input), error: UNAVAILABLE_TOOL_TEXT }
  return { ...part, state: shown }
}
