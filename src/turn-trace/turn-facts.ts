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
  requestReceivedAt?: number
  admissionMs?: number
  firstVisibleMs?: number
  firstTextMs?: number
  /** The model that served the turn. */
  model?: string
  /** The terminal event's readable code and explanation, before product serialization. */
  failureCode?: string
}

/** Serializable route observations for an admission that transfers terminal authority to a durable native owner. */
export interface NativeTurnTimingFacts extends Pick<MeasuredTurnFacts, 'admissionMs' | 'firstVisibleMs' | 'firstTextMs'> {
  turnStreamId: string
  /** The route trace's origin, never the native owner's registration time. */
  requestReceivedAt: number
  /** Absent if the route has not yet entered its lifecycle. Later visible durations are relative to this origin. */
  lifecycleStartedAt?: number
}

/** Validate the one clock contract shared by terminal-row patches and pure-read recovery. */
export function nativeTimingObservationValues(facts: NativeTurnTimingFacts) {
  const valid = (value: number | undefined) => value === undefined || (Number.isFinite(value) && value >= 0)
  if (!facts.turnStreamId || !valid(facts.requestReceivedAt) || !Number.isFinite(facts.requestReceivedAt)
    || !valid(facts.admissionMs) || !valid(facts.firstVisibleMs) || !valid(facts.firstTextMs)) {
    throw new Error('Native timing facts require finite nonnegative observations and an exact request origin')
  }
  if ((facts.firstVisibleMs !== undefined || facts.firstTextMs !== undefined) && (facts.lifecycleStartedAt === undefined || facts.admissionMs === undefined)) {
    throw new Error('Native timing observations require their lifecycle origin and admission offset')
  }
  if (facts.firstTextMs !== undefined && facts.firstVisibleMs === undefined) {
    throw new Error('Native timing first text requires its first visible observation')
  }
  if (facts.firstVisibleMs !== undefined && facts.firstTextMs !== undefined && facts.firstTextMs < facts.firstVisibleMs) {
    throw new Error('Native timing text precedes the first visible observation')
  }
  if (facts.lifecycleStartedAt !== undefined && (!valid(facts.lifecycleStartedAt)
    || facts.lifecycleStartedAt < facts.requestReceivedAt
    || (facts.admissionMs !== undefined && facts.lifecycleStartedAt - facts.requestReceivedAt !== facts.admissionMs))) {
    throw new Error('Native timing facts have conflicting request and lifecycle origins')
  }
  return { admissionMs: facts.admissionMs, firstVisibleMs: facts.firstVisibleMs, firstTextMs: facts.firstTextMs }
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
