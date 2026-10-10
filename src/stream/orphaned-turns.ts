/**
 * Settle turn streams whose owner is gone.
 *
 * A running turn row is a lease: the buffer renews it every 30 s while a
 * producer lives, and a durable observer renews it on each pass. A row nothing
 * renewed past its lease has no producer left; the Worker that streamed it
 * died. Left alone it stays `running` forever: a reconnecting client waits on
 * it, discovery offers it, and reports count it as in flight. On 2026-10-10
 * GTM held 51 such rows, some for hours, and its failure notices arrived 8–11 h
 * after the turns had stopped.
 *
 * {@link settleOrphanedTurns} ends each one the way the buffer ends a failed
 * turn: a terminal `error` event naming the phase it stopped in, then status
 * `error`, written only while the row is still running and still stale, and
 * without moving its update time (reports place a stream by it). It returns
 * each turn's detection lag, the time from its lease expiring to this
 * settlement, so a product can report how late it noticed. Run it from its own
 * scheduled invocation at least every 15 minutes.
 */
import { DEFAULT_RUNNING_TURN_LEASE_MS, type BufferedTurnEvent, type StaleRunningTurn, type TurnEventStore } from './turn-buffer'

/** The failure code carried by the terminal event of a settled orphan. */
export const ORPHANED_TURN_CODE = 'turn.orphaned'

/** How many tail events are read to name the phase a turn stopped in. */
const TAIL_EVENTS = 50
const DEFAULT_LIMIT = 50

export interface SettleOrphanedTurnsOptions {
  store: TurnEventStore
  now?: number
  /** A row older than this since its last renewal is orphaned. Default the running lease, 5 minutes. */
  staleAfterMs?: number
  /** Most rows settled per run; the next run takes the rest. Default 50. */
  limit?: number
  /**
   * Whether something still owns this turn although it stopped renewing the
   * row, such as an open completion admission with a live lease. An owned turn
   * is skipped. A product whose durable owner does not renew the row must
   * answer this, or its live turns are settled as orphans.
   */
  isOwned?: (turn: StaleRunningTurn) => Promise<boolean>
}

export interface SettledOrphanedTurn {
  turnId: string
  scopeId: string | null
  /** Unix ms the row was last renewed. */
  lastRenewedAt: number
  /** From its lease expiring to this settlement. */
  detectionLagMs: number
  /** The run phase the stream last reported, when it reported one. */
  phase: string | null
}

export interface SettleOrphanedTurnsResult {
  settled: SettledOrphanedTurn[]
  /** Stale rows an owner still held. */
  owned: string[]
  /** Most detection lag among the settled turns, in ms. */
  maxDetectionLagMs: number
}

/** End every running turn stream nothing has renewed past its lease. */
export async function settleOrphanedTurns(options: SettleOrphanedTurnsOptions): Promise<SettleOrphanedTurnsResult> {
  const { store } = options
  if (!store.listStaleRunning) throw new Error('settleOrphanedTurns needs a TurnEventStore with listStaleRunning (the D1 and memory stores have it)')
  const now = options.now ?? Date.now()
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_RUNNING_TURN_LEASE_MS
  const cutoff = now - staleAfterMs
  const stale = await store.listStaleRunning(cutoff, options.limit ?? DEFAULT_LIMIT)
  const settled: SettledOrphanedTurn[] = []
  const owned: string[] = []
  for (const turn of stale) {
    if (options.isOwned && await options.isOwned(turn)) {
      owned.push(turn.turnId)
      continue
    }
    const tail = (await store.readTail?.(turn.turnId, TAIL_EVENTS)) ?? []
    const { seq, at, phase } = describeTail(tail)
    await store.append(turn.turnId, [{
      seq: seq + 1,
      event: JSON.stringify({
        type: 'error',
        data: { message: `The turn stopped without finishing during ${phase ?? 'the turn'}. Retry to send it again.`, code: ORPHANED_TURN_CODE, orphaned: true, retryable: true },
        _t: at,
      }),
    }])
    // Only a row still running and still stale: a producer that came back keeps its stream.
    await store.setStatus(turn.turnId, 'error', undefined, { preserveUpdatedAt: true, onlyIfRunningBefore: cutoff })
    settled.push({
      turnId: turn.turnId,
      scopeId: turn.scopeId,
      lastRenewedAt: turn.updatedAt,
      detectionLagMs: Math.max(0, now - (turn.updatedAt + DEFAULT_RUNNING_TURN_LEASE_MS)),
      phase,
    })
  }
  return { settled, owned, maxDetectionLagMs: settled.reduce((max, turn) => Math.max(max, turn.detectionLagMs), 0) }
}

interface TailEvent {
  type?: unknown
  _t?: unknown
  data?: { phase?: unknown }
}

function describeTail(tail: readonly BufferedTurnEvent[]): { seq: number; at: number; phase: string | null } {
  let seq = 0
  let at = 0
  let phase: string | null = null
  for (const row of tail) {
    seq = Math.max(seq, row.seq)
    let event: TailEvent | null
    try {
      event = JSON.parse(row.event) as TailEvent | null
    } catch {
      continue
    }
    if (typeof event?._t === 'number') at = Math.max(at, event._t)
    if (phase === null && event?.type === 'session.run.phase' && typeof event.data?.phase === 'string') phase = event.data.phase
  }
  return { seq, at, phase }
}
