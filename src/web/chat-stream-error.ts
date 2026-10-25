/**
 * Typed chat-turn failures for a product's chat client: a non-ok HTTP response
 * from the chat submit route, or an `error` event inside the turn stream.
 * Product vocabulary (readiness-gap labels, per-code fallback messages) is
 * injected; everything else is the shared wire shape.
 */

/** A chat failure the UI can render as a structured error. */
export interface ChatStreamError {
  message: string
  code?: string
  /** HTTP status when the failure came from a non-ok response, not a stream event. */
  status?: number
  /** Seconds to wait before retrying, parsed from a 429 Retry-After header. */
  retryAfterSeconds?: number
  /** Present on seat/billing errors so the caller can route to checkout. */
  checkoutUrl?: string
  /** SSO start route carried by a 402 `platform_link_required`. */
  connectUrl?: string
  priceUsd?: number
  includedCreditsUsd?: number
  blockingGapIds?: string[]
  recommendedActions?: string[]
  recovery?: {
    sandboxId: string
    action: string
    snapshotAvailability: string
    snapshotFreshness: string
  }
  /** Operator-facing diagnostics, rendered behind a details disclosure, never
   *  inline with the human message. */
  supportDetails?: string
  /** User-facing guidance shown alongside the failure message. */
  hint?: string
  /** The turn failed mid-stream (`sandbox.stream_failed`) but the same message
   *  is safe to re-send verbatim, so the caller can offer a Retry affordance. */
  retryable?: boolean
}

/** Product vocabulary for chat failures. */
export interface ChatStreamErrorOptions {
  /** CTA label per readiness gap id, used when `code === 'readiness.blocked'`.
   *  Kept client-side so known gaps render even when the server sends no
   *  `details.recommendedAction`. */
  readinessGapLabels?: Readonly<Record<string, string>>
  /** Message for an HTTP failure whose body carries a code but no message. */
  codeMessages?: Readonly<Record<string, string>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function numericField(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = source?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringArrayField(source: Record<string, unknown> | undefined, key: string): string[] | undefined {
  const value = source?.[key]
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  return strings.length > 0 ? strings : undefined
}

/** Parse a Retry-After header in either delta-seconds or HTTP-date form. */
export function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return undefined
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000))
}

/** Read status / code / Retry-After / checkout and connect routes /
 *  recommended actions from a non-ok chat response body, which may nest them
 *  under `error` or carry them top-level. */
export function buildHttpChatStreamError(
  status: number,
  retryAfterSeconds: number | undefined,
  body: unknown,
  fallbackMessage: string,
  options: ChatStreamErrorOptions = {},
): ChatStreamError {
  const topLevel = isRecord(body) ? body : undefined
  const nested = topLevel && isRecord(topLevel.error) ? topLevel.error : undefined
  const source = nested ?? topLevel
  const code = stringField(source, 'code')
  const message = stringField(topLevel, 'error')
    ?? stringField(nested, 'message')
    ?? stringField(topLevel, 'message')
    ?? (code ? options.codeMessages?.[code] : undefined)
    ?? fallbackMessage
  const checkoutUrl = stringField(source, 'checkoutUrl')
  const connectUrl = stringField(source, 'connectUrl')
  const priceUsd = numericField(source, 'priceUsd')
  const includedCreditsUsd = numericField(source, 'includedCreditsUsd')
  const recommendedActions = stringArrayField(source, 'recommendedActions')
  const retryAction = status === 429 && retryAfterSeconds !== undefined
    ? `Try again in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'}.`
    : undefined

  return {
    message,
    status,
    ...(code ? { code } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    ...(recommendedActions || retryAction ? { recommendedActions: recommendedActions ?? [retryAction!] } : {}),
    ...(checkoutUrl ? { checkoutUrl } : {}),
    ...(connectUrl ? { connectUrl } : {}),
    ...(priceUsd !== undefined ? { priceUsd } : {}),
    ...(includedCreditsUsd !== undefined ? { includedCreditsUsd } : {}),
  }
}

/** Turn a non-ok chat submit response into a structured error. */
export async function parseChatHttpErrorResponse(
  res: Response,
  options: ChatStreamErrorOptions = {},
): Promise<ChatStreamError> {
  const fallbackMessage = 'Server error'
  const retryAfterSeconds = parseRetryAfterSeconds(res.headers.get('Retry-After'))
  const text = await res.text().catch(() => fallbackMessage)
  if (!text.trim()) return buildHttpChatStreamError(res.status, retryAfterSeconds, undefined, fallbackMessage, options)
  try {
    return buildHttpChatStreamError(res.status, retryAfterSeconds, JSON.parse(text) as unknown, text, options)
  } catch {
    return buildHttpChatStreamError(res.status, retryAfterSeconds, undefined, text, options)
  }
}

function parseRecovery(details: Record<string, unknown>): ChatStreamError['recovery'] {
  const recovery = isRecord(details.recovery) ? details.recovery : undefined
  const snapshot = recovery && isRecord(recovery.snapshot) ? recovery.snapshot : undefined
  if (!recovery || !snapshot) return undefined
  if (typeof recovery.sandboxId !== 'string' || typeof recovery.action !== 'string') return undefined
  if (typeof snapshot.availability !== 'string' || typeof snapshot.freshness !== 'string') return undefined
  return {
    sandboxId: recovery.sandboxId,
    action: recovery.action,
    snapshotAvailability: snapshot.availability,
    snapshotFreshness: snapshot.freshness,
  }
}

function stringIds(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : undefined
}

/** Parse the data of a stream `error` event. */
export function parseChatStreamError(
  data: Record<string, unknown>,
  options: ChatStreamErrorOptions = {},
): ChatStreamError {
  const message = stringField(data, 'message') ?? stringField(data, 'error') ?? 'Unknown error'
  const code = typeof data.code === 'string' ? data.code : undefined
  const details = isRecord(data.details) ? data.details : {}
  const supportDetails = stringField(details, 'supportDetails')
  const hint = stringField(details, 'hint')
  const annotations = {
    ...(supportDetails ? { supportDetails } : {}),
    ...(hint ? { hint } : {}),
  }

  if (code === 'readiness.blocked') {
    const blockingGapIds = stringIds(details.blockingGapIds) ?? stringIds(data.blockingGapIds) ?? []
    const serverAction = typeof details.recommendedAction === 'string' ? details.recommendedAction : undefined
    const recommendedActions = blockingGapIds.map((id) => options.readinessGapLabels?.[id] ?? serverAction ?? message)
    return { message, code, blockingGapIds, recommendedActions, ...annotations }
  }

  const recommendedActions = stringArrayField(details, 'recommendedActions')
  const recovery = parseRecovery(details)
  return {
    message,
    ...(code ? { code } : {}),
    // A severed sandbox turn: the same message is safe to re-send.
    ...(code === 'sandbox.stream_failed' ? { retryable: true } : {}),
    ...(recommendedActions ? { recommendedActions } : {}),
    ...(recovery ? { recovery } : {}),
    ...annotations,
  }
}

/**
 * Normalize the error-event shapes a stream can carry: `{type:'error',
 * data:{message}}`, `{type:'error',data:{error:'...'}}` and
 * `{type:'error',error:'...'}`, so a failed turn surfaces the real failure
 * text, never 'Unknown error'.
 */
export function parseChatStreamErrorEvent(
  event: Record<string, unknown>,
  options: ChatStreamErrorOptions = {},
): ChatStreamError {
  const data = isRecord(event.data) ? event.data : {}
  const source: Record<string, unknown> = isRecord(event.error) ? { ...event.error, ...data } : { ...data }
  if (!stringField(source, 'message') && typeof event.error === 'string' && event.error.trim()) {
    source.message = event.error
  }
  return parseChatStreamError(source, options)
}
