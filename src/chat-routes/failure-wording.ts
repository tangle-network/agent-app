/**
 * What a person reads when a sandbox turn fails. A reason the producer can word plainly (a provider wait, a refused
 * model key, the Router's own budget or balance refusal) becomes that sentence. A refusal that would fail the same way
 * again, and a funding, billing or admission refusal the client's recovery UI reads, keep their own words, without the
 * harness's wrapper. Any other reason (a harness error, a tool list, a repeated-call loop, a stack) is withheld: the
 * person reads one plain sentence and the server keeps the reason, in its log and under a Symbol key the route's own
 * failure hooks read. `personFacing` applies this to every event the sandbox producer yields.
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

/** The list of every tool a harness appends to a refused or repeated tool call, to the end of its text. */
const TOOL_LIST_TAIL = /\s*Available tools:[\s\S]*$/

/** A reason without the harness's wrapper: its `<harness> execution failed:` prefix, a tool list and an exit status. */
function unwrapped(reason: string): string {
  return reason.replace(/^[\w.-]+ execution failed:\s*/, '').replace(TOOL_LIST_TAIL, '')
    .replace(/\s*\((?:exit code|killed by)[^)]*\)\s*$/, '').trim()
}

/** The Router's budget and balance refusals: a key's monthly or lifetime budget is exhausted, or the remaining budget
 *  or balance is below the cost of one answer. */
const ROUTER_REFUSAL = new RegExp([
  "This key's (?:monthly|lifetime) budget is exhausted",
  "(?:This key's remaining budget|Your available balance), after other in-flight requests, is below \\$",
].join('|'))

/** A failure reason as the plain sentence the person reads, when the producer has one for it. */
function plainFailureSentence(message: string): string | undefined {
  const router = message.search(ROUTER_REFUSAL)
  return providerResetSentence(message) ?? modelKeyRefusedSentence(message)
    ?? (router < 0 ? undefined : unwrapped(message.slice(router).split('\n')[0]!))
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

/** A harness's raw event as the person may read it: a raw tool part without its tool list, a raw error behind `view`. */
function shownRaw(event: JsonRecord, view: (reason: string) => FailureView): JsonRecord {
  const data = asRecord(event.data)
  const raw = asRecord(data?.event)
  if (!data || !raw) return event
  const part = asRecord(raw.part)
  if (part?.type === 'tool') return { ...event, data: { ...data, event: { ...raw, part: withoutToolList(part) } } }
  const error = asRecord(raw.error)
  const reason = raw.type === 'error'
    ? asString(raw.error) ?? asString(asRecord(error?.data)?.message) ?? asString(error?.message) : undefined
  return reason ? { ...event, data: { ...data, event: { ...raw, error: { message: view(reason).shown } } } } : event
}

/** One turn's person-facing filter. `view` says how a failure reason reads to the person; a withheld reason is logged
 *  once, at warn (`log`, else `console.warn`), under one class with the ids the failure carries. `event` is every event
 *  the producer yields as it may reach the client. Passing through: a plainly worded reason; HTTP 402; a
 *  {@link REFUSAL_CODES} refusal; and what the client's recovery UI reads (`getChatFundingRecovery`:
 *  `insufficient_credits`, `paid_access_required`, `funding_required`, or its words). */
export function personFacing(options: { log?: Log; failedTurnText: string }) {
  const logged = new Set<string>()
  const view = (reason: string, code?: string, status?: unknown, meta: Record<string, unknown> = {}): FailureView => {
    const plain = plainFailureSentence(reason)
    if (plain) return { kind: 'plain', shown: plain }
    if (Number(status) === 402 || REFUSAL_CODES.has(code ?? '')
      || getChatFundingRecovery({ code, message: reason })) return { kind: 'own', shown: unwrapped(reason) || reason }
    if (!logged.has(reason)) {
      logged.add(reason)
      const warn = options.log ?? console.warn
      warn('[chat-routes] turn failure withheld from the person', { failureClass: 'runtime_failure', code, error: reason, ...meta })
    }
    // A settlement check that fails after a charged answer leaves that answer whole: sending again would charge again.
    if (code?.startsWith('settlement_')) return { kind: 'plain', shown: ANSWER_COMPLETE_TEXT }
    return { kind: 'withheld', shown: options.failedTurnText }
  }
  /** An event as it may reach the client, or `undefined` for a withheld warning, which leaves nothing to show. */
  const event = (event: JsonRecord): JsonRecord | undefined => {
    const data = asRecord(event.data)
    if (event.type === 'raw') return shownRaw(event, (reason) => view(reason, undefined, undefined, failureIds(data)))
    const failed = (event.type === 'done' || event.type === 'status') && data?.status === 'failed'
    if (!failed && !FAILURE_TYPES.has(String(event.type))) return event
    const reason = failureReason(event)
    if (!reason) return event
    const shown = view(reason, asString(data?.code), data?.statusCode ?? (failed ? undefined : data?.status), failureIds(data))
    if (event.type === 'warning' && shown.kind === 'withheld') return undefined
    return shownFailure(event, shown.shown, reason)
  }
  return { view, event }
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
