/** Read-side checkpoints for native chat NDJSON. This never submits or cancels work. */
export interface TurnObservation {
  schema: 'turn-observation-v1'
  streamId: string | null
  /** Replay ordinals only. Unsequenced live frames cannot advance this cursor. */
  lastSeq: number
  outcome: 'completed' | 'failed' | null
  replayStatus: string | null
  eventCount: number
}

export function parseTurnObservation(value?: unknown): TurnObservation {
  if (value === undefined) return {
    schema: 'turn-observation-v1', streamId: null, lastSeq: 0,
    outcome: null, replayStatus: null, eventCount: 0,
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid turn observation')
  const v = value as Record<string, unknown>
  if (v.schema !== 'turn-observation-v1'
    || !(v.streamId === null || (typeof v.streamId === 'string' && /^[A-Za-z0-9_-]+$/.test(v.streamId)))
    || !Number.isSafeInteger(v.lastSeq) || Number(v.lastSeq) < 0
    || !Number.isSafeInteger(v.eventCount) || Number(v.eventCount) < 0
    || !(v.outcome === null || v.outcome === 'completed' || v.outcome === 'failed')
    || !(v.replayStatus === null || typeof v.replayStatus === 'string')
    || (v.streamId === null && Number(v.lastSeq) > 0)) throw new TypeError('Invalid turn observation')
  return {
    schema: 'turn-observation-v1', streamId: v.streamId as string | null,
    lastSeq: Number(v.lastSeq), outcome: v.outcome as TurnObservation['outcome'],
    replayStatus: v.replayStatus as string | null, eventCount: Number(v.eventCount),
  }
}

export interface TurnObservationUpdate {
  checkpoint: TurnObservation
  /** False only for an already-checkpointed replay ordinal. */
  accepted: boolean
  event: Record<string, unknown>
}

/** Reduce an observed frame. Ordered replay gaps are errors, not silent lost work. */
export function observeTurnEvent(previous: TurnObservation, raw: unknown): TurnObservationUpdate {
  const checkpoint = parseTurnObservation(previous)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Turn frame must be an object')
  const outer = raw as Record<string, unknown>
  const inner = outer.kind === 'event' ? outer.event : outer
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) throw new TypeError('Invalid turn event envelope')
  const event = inner as Record<string, unknown>
  if (typeof event.type !== 'string' || !event.type) throw new TypeError('Turn frame requires a type')

  // Even a duplicate marker must not switch which execution we are observing.
  if (event.type === 'turn') {
    if (typeof event.turnId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(event.turnId)) throw new TypeError('Invalid stream identity')
    if (checkpoint.streamId !== null && checkpoint.streamId !== event.turnId) throw new Error('Replay stream identity changed')
    checkpoint.streamId = event.turnId
  }
  const seq = outer.seq
  if (seq !== undefined && seq !== -1) {
    if (!Number.isSafeInteger(seq) || Number(seq) < 1) throw new TypeError('Invalid replay ordinal')
    if (checkpoint.streamId === null) throw new Error('Replay ordinal arrived before stream identity')
    if (Number(seq) <= checkpoint.lastSeq) return { checkpoint, accepted: false, event }
    if (Number(seq) !== checkpoint.lastSeq + 1) throw new Error('Replay has a gap; retain the checkpoint and inspect durable history')
    checkpoint.lastSeq = Number(seq)
  } else if (seq === -1 && event.type !== 'turn_status') {
    throw new TypeError('Only a turn-status sentinel may have ordinal -1')
  }

  if (event.type === 'error' || event.type === 'session.run.failed') checkpoint.outcome = 'failed'
  if (event.type === 'session.run.completed' && checkpoint.outcome !== 'failed') checkpoint.outcome = 'completed'
  if (event.type === 'turn_status') {
    if (typeof event.status !== 'string') throw new TypeError('Turn status requires a value')
    checkpoint.replayStatus = event.status
    if (['error', 'failed', 'aborted', 'cancelled'].includes(event.status)) checkpoint.outcome = 'failed'
    if (['complete', 'completed'].includes(event.status) && checkpoint.outcome !== 'failed') checkpoint.outcome = 'completed'
  }
  checkpoint.eventCount += 1
  return { checkpoint, accepted: true, event }
}

export interface ConsumeTurnStreamOptions {
  checkpoint?: TurnObservation
  /** Commit evidence and its checkpoint durably before acknowledging this frame. */
  commit(update: TurnObservationUpdate): Promise<void>
  /** Bound untrusted frame memory, not total run duration or total transcript size. */
  maxFrameBytes?: number
}

/**
 * Consume one viewing connection. EOF without a terminal event stays incomplete.
 * A disconnect/abort propagates; the last committed checkpoint remains resumable.
 * The caller owns network observation windows separately from execution deadlines.
 */
export async function consumeTurnStream(
  body: AsyncIterable<Uint8Array>,
  options: ConsumeTurnStreamOptions,
): Promise<TurnObservation> {
  const maxFrameBytes = options.maxFrameBytes ?? 4 * 1024 * 1024
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) throw new RangeError('Frame byte limit must be positive')
  let state = parseTurnObservation(options.checkpoint)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  let frameBytes = 0
  async function accept(line: string): Promise<void> {
    if (!line.trim()) return
    const update = observeTurnEvent(state, JSON.parse(line))
    if (update.accepted) await options.commit(update)
    state = update.checkpoint
  }
  for await (const chunk of body) {
    // Count bytes before decoding: a malicious unterminated frame cannot grow
    // without bound, and splitting UTF-8 characters across chunks stays valid.
    let start = 0
    for (let end = 0; end < chunk.length; end += 1) {
      if (chunk[end] !== 10) continue
      frameBytes += end - start
      if (frameBytes > maxFrameBytes) throw new RangeError('Turn frame exceeds byte limit')
      pending += decoder.decode(chunk.subarray(start, end + 1), { stream: true })
      await accept(pending)
      pending = ''; frameBytes = 0; start = end + 1
    }
    frameBytes += chunk.length - start
    if (frameBytes > maxFrameBytes) throw new RangeError('Turn frame exceeds byte limit')
    pending += decoder.decode(chunk.subarray(start), { stream: true })
  }
  pending += decoder.decode()
  await accept(pending)
  return state
}
