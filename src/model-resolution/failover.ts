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
 * Statuses that mean the REQUEST is wrong, so every model in the chain would
 * fail on it identically. Listed explicitly rather than as "any 4xx" because
 * 404 is NOT one of them: a model the endpoint cannot find is model-scoped, and
 * the next model in the chain may well be there. 429 is absent for the same
 * reason in reverse — it is a capacity signal and lives in the list above.
 */
const REQUEST_ERROR_STATUSES: readonly number[] = [400, 401, 403, 405, 413, 422]

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
  // Model-SCOPED unavailability. A different model in the chain can still
  // serve, so this belongs here and not with the client errors. Measured on a
  // real box 2026-07-27: the sandbox now reports an unservable model as a
  // terminal `error` whose data is `{"message":"Session error:
  // {\"error\":{\"name\":\"UnknownError\",\"data\":{\"message\":\"Model not
  // found: openai-compat/zai/glm-4.7.\"}}}"}` — no `code`, no numeric status,
  // and none of the fragments above. The shipped live product-path proof went
  // red on exactly this: `usedFallback:false`, `failed:true`, an error row to
  // the customer where a fallback was available and would have answered.
  'model not found',
  'is not currently available',
]

/**
 * Textual forms an HTTP status arrives in when NO numeric field carries it.
 *
 * The case that forced this is the opaque Cloudflare 502. Captured verbatim
 * from `router.tangle.tools` on 2026-07-27 17:48:12 GMT (cf-ray
 * `a21d793899f6cef3-DEN`): `HTTP/2 502`, `content-type: text/plain;
 * charset=UTF-8`, a 16-byte body reading `error code: 502\n`, `server:
 * cloudflare`, and **zero `x-tangle-*` headers** where a healthy 200 from the
 * same endpoint carries nine of them.
 *
 * That capture was originally read as "zero headers means the origin never
 * executed". It does not, and the correction matters more than the original
 * guess did. Matching client-observed cf-rays against the origin's own access
 * log (tangle-router #307) showed all 62 of those responses WERE produced by
 * the router — `content-type: application/json`, an `X-Generation-Id`, and a
 * routing trace showing the upstream had returned 200 — and Cloudflare
 * replaced the body and every response header with its own error page, because
 * an origin 502 reads to the edge as the origin having failed.
 *
 * The classifier's BEHAVIOR here was right for the wrong reason, and stays
 * exactly as it is. What changes is why: the rescue is needed not because the
 * origin is unreachable, but because a response the origin carefully
 * structured arrives at the client as sixteen unlabelled bytes. The router now
 * emits 503 instead of 502 on those paths so the body survives, but this
 * pattern must remain — it is the client's only handle on any origin 5xx the
 * edge decides to rewrite, including from a router that has not deployed the
 * fix yet.
 *
 * Every pattern below matches a string a real producer emits:
 * - `error code: 502` — Cloudflare's edge body (the capture above).
 * - `(HTTP 502)` — `src/runtime/openai-stream.ts` wrapping a non-ok response.
 * - `returned 502` — `src/runtime/model-catalog.ts`.
 * - `failed with status 502` — `src/turn-stream/adapters.ts`.
 * - `502 Bad Gateway` — an HTTP/1.1 status line. HTTP/2 carries no reason
 *   phrase at all, which is precisely why matching the phrase alone (the
 *   `'bad gateway'` fragment below) read the capture as a non-outage.
 */
const HTTP_STATUS_HINT_PATTERNS: readonly RegExp[] = [
  /\berror\s+code:?\s*([1-5]\d{2})\b/i,
  /\bhttp(?:\/[\d.]+)?[\s:]\s*([1-5]\d{2})\b/i,
  /\bstatus(?:\s*code)?[\s:=]\s*([1-5]\d{2})\b/i,
  /\b(?:returned|responded(?:\s+with)?)\s+([1-5]\d{2})\b/i,
  /\b([1-5]\d{2})\s+(?:bad\s+gateway|service\s+unavailable|gateway\s+time-?out|internal\s+server\s+error|too\s+many\s+requests)\b/i,
]

/**
 * The HTTP status a message states in prose, or `undefined` when it states
 * none. Deliberately NOT "any three digits in the string" — an unanchored digit
 * scan would read a token count or a duration as a status.
 */
export function readHttpStatusHint(text: string): number | undefined {
  for (const pattern of HTTP_STATUS_HINT_PATTERNS) {
    const match = pattern.exec(text)
    if (match?.[1]) return Number(match[1])
  }
  return undefined
}

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

  // A status carried as PROSE, checked before the fragment list because it is
  // the stronger signal and it cuts BOTH ways. An edge 502 names no exception
  // type and sets no numeric field, so without this the shipped classifier read
  // `error code: 502` as a non-outage and handed the customer a Bad Gateway
  // instead of trying the next model — the exact failure the router cannot
  // rescue from inside its own origin.
  const hinted = readHttpStatusHint(message)
  if (hinted !== undefined) {
    if (UPSTREAM_UNAVAILABLE_STATUSES.includes(hinted)) return true
    // An explicit REQUEST-error status is decisive the OTHER way. A 400
    // carrying a validation message must surface rather than walk the chain,
    // even when its body happens to contain a word from the fragment list —
    // the router's own `Function tools with reasoning_effort are not supported`
    // 400 is a request-shaping bug that fails identically on every model.
    if (REQUEST_ERROR_STATUSES.includes(hinted)) return false
  }

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
