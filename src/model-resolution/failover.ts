/**
 * Model failover — the answer to "one upstream hit a quota wall and the customer
 * got a Bad Gateway even though the router had abundant healthy capacity".
 *
 * This is deliberately NOT a health probe. Probing before every turn buys a
 * round-trip of latency on the happy path and still races the outage (a model
 * healthy at probe time can 502 a second later). Failover is REACTIVE: run the
 * preferred model, and on an upstream-outage signal move to the next model in
 * the chain. Zero added latency when the preferred model works.
 *
 * Two facts drive the design, both measured against a live box during the
 * 2026-07-25 Anthropic/DeepSeek outage:
 *
 * 1. An outage is NOT always a thrown error. The sandbox resolves with a
 *    payload — `{ success: false, errorCode: 'provider_inference_unavailable' }`
 *    — so a classifier that only inspects `catch` misses the customer-visible
 *    case entirely. `isUpstreamUnavailable` inspects resolved values too.
 * 2. Catalog membership is NOT liveness. The router's `/v1/models` still listed
 *    every dead model during the outage, so `validateChatModelId` admitted
 *    `claude-sonnet-4-6` while every call to it returned 502. Nothing upstream
 *    of the actual call can be trusted to tell you a model is serving.
 *
 * Substrate-free: the caller injects `run`, so this composes with a sandbox
 * turn, a router chat completion, or a test fake without importing any of them.
 */

/**
 * Error codes that mean "this model's upstream is unavailable — a different
 * model may still work". Deliberately excludes codes that would fail identically
 * on every model (bad request, auth, content filter): retrying those down a
 * chain burns latency and money to reach the same failure.
 */
export const UPSTREAM_UNAVAILABLE_CODES: readonly string[] = [
  'provider_inference_unavailable',
  'upstream_unavailable',
  'insufficient_quota',
  'model_not_available',
  'server_error',
  'bad_gateway',
  'service_unavailable',
]

/** HTTP statuses that indicate an upstream capacity/availability problem. */
export const UPSTREAM_UNAVAILABLE_STATUSES: readonly number[] = [429, 500, 502, 503, 504]

/**
 * Message fragments emitted by real upstreams during this class of outage.
 * Matched case-insensitively as a last resort, after code and status.
 */
const UPSTREAM_UNAVAILABLE_MESSAGES: readonly string[] = [
  'bad gateway',
  'service unavailable',
  'inference temporarily unavailable',
  'provider inference is unavailable',
  'insufficient balance',
  'usage limits',
  'quota exceeded',
  'rate limit',
  'overloaded',
  'temporarily unavailable',
]

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/**
 * True when `signal` — a thrown error OR a resolved result payload — indicates
 * the model's upstream is unavailable and another model is worth trying.
 *
 * Checked in order of decreasing confidence: explicit code, HTTP status, then
 * message text. A resolved payload only counts as a failure when it carries an
 * explicit failure marker (`success: false`, or an `error`/`errorCode` field) —
 * a successful result is never misread as an outage.
 */
export function isUpstreamUnavailable(signal: unknown): boolean {
  if (signal === null || typeof signal !== 'object') return false
  const record = signal as Record<string, unknown>

  // A resolved payload that explicitly reports success is never an outage.
  if (record.success === true) return false

  const nested = record.error
  const nestedRecord = nested !== null && typeof nested === 'object' ? (nested as Record<string, unknown>) : undefined

  const code =
    readString(record, 'errorCode') ??
    readString(record, 'code') ??
    (nestedRecord ? (readString(nestedRecord, 'code') ?? readString(nestedRecord, 'type')) : undefined)
  if (code && UPSTREAM_UNAVAILABLE_CODES.includes(code)) return true

  for (const key of ['status', 'statusCode', 'httpStatus']) {
    const value = record[key]
    if (typeof value === 'number' && UPSTREAM_UNAVAILABLE_STATUSES.includes(value)) return true
  }

  const message =
    readString(record, 'message') ??
    readString(record, 'error') ??
    (nestedRecord ? readString(nestedRecord, 'message') : undefined)
  if (!message) return false
  const lowered = message.toLowerCase()
  return UPSTREAM_UNAVAILABLE_MESSAGES.some((fragment) => lowered.includes(fragment))
}

/** One model tried, and how it went. */
export interface ModelFailoverAttempt {
  model: string
  ok: boolean
  /** Why this model was abandoned. Absent when `ok`. */
  reason?: string
}

/** The outcome of a failover run: the value plus the full attempt trail. */
export interface ModelFailoverResult<T> {
  value: T
  /** The model that actually produced `value`. */
  model: string
  attempts: ModelFailoverAttempt[]
  /** True when the preferred (first) model did not serve the request. */
  usedFallback: boolean
}

/** Every model in the chain failed; carries the trail for logging. */
export class ModelFailoverExhaustedError extends Error {
  readonly attempts: ModelFailoverAttempt[]
  constructor(attempts: ModelFailoverAttempt[]) {
    const trail = attempts.map((a) => `${a.model}: ${a.reason ?? 'failed'}`).join(' | ')
    super(`All ${attempts.length} model(s) failed. ${trail}`)
    this.name = 'ModelFailoverExhaustedError'
    this.attempts = attempts
  }
}

/** Inputs to {@link runWithModelFailover}. */
export interface RunWithModelFailoverInput<T> {
  /** Preferred model first, then fallbacks in descending preference. */
  models: readonly string[]
  /** Executes one turn with the given model. */
  run: (model: string) => Promise<T>
  /**
   * Classifies a resolved result as an upstream outage. Defaults to
   * {@link isUpstreamUnavailable}, which understands the sandbox's
   * `{ success: false, errorCode }` payload.
   */
  isUnavailableResult?: (result: T) => boolean
  /** Classifies a thrown error. Defaults to {@link isUpstreamUnavailable}. */
  isUnavailableError?: (error: unknown) => boolean
  /** Observability hook fired each time a model is abandoned. */
  onFallback?: (attempt: ModelFailoverAttempt, nextModel: string) => void
}

function describe(signal: unknown): string {
  if (signal instanceof Error) return signal.message
  if (signal !== null && typeof signal === 'object') {
    const record = signal as Record<string, unknown>
    const message = readString(record, 'error') ?? readString(record, 'message') ?? readString(record, 'errorCode')
    if (message) return message
  }
  return String(signal)
}

/**
 * Run `run` against the first model in `models` that does not report an upstream
 * outage, falling through the chain in order.
 *
 * A non-outage failure (bad request, auth, content filter) is re-thrown
 * immediately rather than retried down the chain — those fail identically on
 * every model, so walking the chain would only multiply latency and spend.
 *
 * @throws ModelFailoverExhaustedError when every model reports an outage.
 */
export async function runWithModelFailover<T>(
  input: RunWithModelFailoverInput<T>,
): Promise<ModelFailoverResult<T>> {
  const models = input.models.map((m) => m.trim()).filter((m) => m.length > 0)
  if (models.length === 0) throw new Error('runWithModelFailover requires at least one model')

  const isUnavailableResult = input.isUnavailableResult ?? ((r: T) => isUpstreamUnavailable(r))
  const isUnavailableError = input.isUnavailableError ?? isUpstreamUnavailable
  const attempts: ModelFailoverAttempt[] = []

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index]!
    let result: T
    try {
      result = await input.run(model)
    } catch (error) {
      if (!isUnavailableError(error)) throw error
      const attempt: ModelFailoverAttempt = { model, ok: false, reason: describe(error) }
      attempts.push(attempt)
      const next = models[index + 1]
      if (next) input.onFallback?.(attempt, next)
      continue
    }

    if (isUnavailableResult(result)) {
      const attempt: ModelFailoverAttempt = { model, ok: false, reason: describe(result) }
      attempts.push(attempt)
      const next = models[index + 1]
      if (next) input.onFallback?.(attempt, next)
      continue
    }

    attempts.push({ model, ok: true })
    return { value: result, model, attempts, usedFallback: index > 0 }
  }

  throw new ModelFailoverExhaustedError(attempts)
}

/**
 * Build a failover chain: the preferred model first, then `fallbacks`, with
 * duplicates removed so a model is never retried twice in one turn.
 */
export function buildModelChain(preferred: string, fallbacks: readonly string[]): string[] {
  const chain: string[] = []
  for (const model of [preferred, ...fallbacks]) {
    const cleaned = typeof model === 'string' ? model.trim() : ''
    if (cleaned.length > 0 && !chain.includes(cleaned)) chain.push(cleaned)
  }
  return chain
}
