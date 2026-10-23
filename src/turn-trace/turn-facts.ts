import { redactErrorMessage } from '../redact/index'

/**
 * What `createChatTurnRoutes` measured for a settled turn, kept in this isolate
 * under the turn's stream id so the rollout timing store can fill the row the
 * product writes from its lifecycle hook. A product's writer that forgot
 * `firstVisibleMs` or `admissionMs` (Legal never wrote first_visible_ms) still
 * records them after a version bump, on every lane.
 *
 * Internal: not exported from a subpath. Values the product passes always win.
 */
export interface MeasuredTurnFacts {
  admissionMs?: number
  firstVisibleMs?: number
  firstTextMs?: number
  /** The model that served the turn. */
  model?: string
  /** The terminal event's readable code and explanation, before product serialization. */
  failureCode?: string
}

/** Turns kept; a lifecycle hook reads its turn's facts within the same request, so a small window is enough. */
const KEEP = 512
const facts = new Map<string, MeasuredTurnFacts>()

export function noteMeasuredTurnFacts(turnStreamId: string, measured: MeasuredTurnFacts): void {
  facts.delete(turnStreamId)
  facts.set(turnStreamId, measured)
  if (facts.size > KEEP) facts.delete(facts.keys().next().value!)
}

export function measuredTurnFacts(turnStreamId: string): MeasuredTurnFacts | undefined {
  return facts.get(turnStreamId)
}

/** One bounded, redacted failure description for live routes and durable/native settlement. */
export function readableTurnFailure(error: unknown, data?: Record<string, unknown>): string {
  let fields = data
  if (!fields && error !== null && typeof error === 'object') fields = error as Record<string, unknown>
  let code: unknown, reason: unknown
  try {
    code = fields?.code
    reason = fields?.message ?? fields?.error ?? fields?.reason
  } catch { /* Untrusted getters must not break telemetry. */ }
  const message = typeof reason === 'string' && reason.length ? reason : redactErrorMessage(error, 'chat turn failed')
  return redactErrorMessage(typeof code === 'string' && code.length && message !== code && !message.startsWith(`${code}:`)
    ? `${code}: ${message}` : message)
}
