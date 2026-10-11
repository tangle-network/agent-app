/**
 * `createWarmLeases`: warm a workspace's box shortly before a member needs it,
 * hold it while the conversation continues, and let the platform suspend it
 * afterwards. One primitive for every warm signal, so a page open, a composer
 * focus, an inbound line message and a learned weekly pattern share one
 * dedupe, one budget and one event stream.
 *
 * WHY A LEASE. Drew cancelled always-on keep-warm (2026-10-11): a warm box must
 * be earned by a signal and must cost a bounded amount when the signal was
 * wrong. Measured on Hospitality (2026-10-04..10-11, timestamps only): every
 * human first message after 30 min of quiet landed on a suspended box, and the
 * cold first reply took 68 s on the web and 76 s on a line.
 *
 * WHO SUSPENDS. Not this module. `POST /v1/sandboxes/:id/stop` suspends a box
 * even while a turn runs in it (agent-dev-container
 * `routes/projects/lifecycle.ts`), whereas the platform's idle reaper re-checks
 * the sidecar for live work before it suspends. So a lease only ever resumes
 * and, during a burst hold, pings. An unused warm ends when the box's own idle
 * timeout passes; create boxes with `idleTimeoutSeconds` near the warm hold
 * (600 s) to make a wrong warm cost about ten minutes, and tell this module that
 * value through `boxIdleMs` so its accounting matches the platform.
 *
 * WHAT IT COSTS. Each lease that ends without a turn charges the box time it
 * caused (until the box's idle timeout after its last warm activity) to that
 * key's UTC day. Signals listed in `budgetedReasons` are refused once the day's
 * charge reaches `dailyBudgetMs`. A box that was already running when a signal
 * arrived is charged nothing: the warm did not cause that time.
 *
 * PREDICTION. Every turn that arrives after `boxIdleMs` of quiet (a cold
 * arrival) adds to a decayed count for its ten-minute bin of the day and its
 * weekday. Hour-of-week bins were too coarse: one arrival a day in an hour is
 * a 15% chance for any ten-minute warm, so a shift-start ramp never crossed a
 * useful threshold. `sweep()` warms a key when the predicted chance of a cold
 * arrival in the next `holdMs` reaches that key's threshold, at most once per
 * hour, within the budget. The threshold tunes itself: a predicted warm that is used lowers it,
 * one that is wasted raises it.
 *
 * EVENTS. `warm_started`, `warm_hit`, `warm_wasted`, `warm_declined` and
 * `warm_failed` each carry the key and the reason, so a product can compute hit
 * rate and wasted minutes per workspace from its logs alone.
 */

/** Why a warm was requested. Products may add their own reasons. */
export type WarmReason =
  | 'page-open'
  | 'composer-focus'
  | 'line-ingress'
  | 'member-activity'
  | 'predicted'
  | 'scheduled'
  | (string & {})

/** What the product's `warm` did to the box. */
export type WarmBoxOutcome =
  /** The box was stopped and is now running: this warm caused its up-time. */
  | 'resumed'
  /** The box was already running: nothing to warm, nothing charged. */
  | 'running'
  /** No box exists for this key. Leases never create boxes. */
  | 'absent'

export type WarmLeaseEvent =
  | { type: 'warm_started'; key: string; reason: WarmReason; outcome: WarmBoxOutcome; ms: number }
  | { type: 'warm_hit'; key: string; reason: WarmReason; leadMs: number }
  | { type: 'warm_wasted'; key: string; reason: WarmReason; minutes: number }
  | { type: 'warm_declined'; key: string; reason: WarmReason; why: 'budget' | 'absent' }
  | { type: 'warm_failed'; key: string; reason: WarmReason; error: string }

export type WarmSignalOutcome =
  /** This call started a lease and ran the product's warm. */
  | 'started'
  /** A lease was already live (here or in another isolate); its hold was extended. */
  | 'extended'
  | 'declined'
  | 'failed'

export interface WarmSignalResult {
  outcome: WarmSignalOutcome
  box?: WarmBoxOutcome
}

export interface WarmTurnResult {
  /** The turn landed on a box a lease had already warmed. */
  hit: boolean
  /** The turn arrived after `boxIdleMs` of quiet on this key. */
  coldArrival: boolean
}

export interface WarmSweepReport {
  ended: number
  wasted: number
  pinged: number
  predicted: number
  /** Keys whose ping or predicted warm threw; the rest of the batch still ran. */
  errors: number
}

/** One key's row. Times are epoch milliseconds; 0 means never. */
export interface WarmLeaseRow {
  key: string
  leaseId: string | null
  reason: string | null
  startedAt: number
  holdUntil: number
  warmAt: number
  usedAt: number
  resumed: boolean
  pingAt: number
  lastTurnAt: number
  day: string
  dayWarmMs: number
  threshold: number
  slots: number[]
  slotsAt: number
  firstSeenAt: number
  predictedAt: number
}

/** Persistence for leases. `begin` and `markUsed` must be atomic across isolates. */
export interface WarmLeaseStore {
  read(key: string): Promise<WarmLeaseRow | null>
  /**
   * Start a lease with `leaseId` when none is live, otherwise extend the live
   * one's hold to at least `holdUntil`. Returns the live lease id after the
   * write; the caller started the lease exactly when it equals `leaseId`.
   */
  begin(key: string, leaseId: string, reason: string, now: number, holdUntil: number): Promise<string>
  /** Record the result of this lease's warm. No-op for a superseded lease. */
  markWarm(key: string, leaseId: string, warmAt: number, resumed: boolean): Promise<void>
  /**
   * Record a turn: mark the live lease used (first turn only), extend its hold
   * to `holdUntil`, and store `lastTurnAt`. Returns the row as it was BEFORE
   * the write, so the caller can tell a hit and a cold arrival apart.
   */
  markUsed(key: string, now: number, holdUntil: number): Promise<WarmLeaseRow | null>
  /**
   * End `leaseId`, charging `chargeMs` to `day` and setting the predicted-warm
   * threshold when one is given. No-op for a superseded lease.
   */
  end(key: string, leaseId: string, day: string, chargeMs: number, threshold?: number): Promise<void>
  /** Overwrite the prediction fields. Lossy under races by design: it is a statistic. */
  writeProfile(key: string, slots: number[], slotsAt: number, firstSeenAt: number): Promise<void>
  markPinged(key: string, at: number): Promise<void>
  markPredicted(key: string, at: number): Promise<void>
  /** Bounded batches for `sweep`. */
  listExpired(now: number, limit: number): Promise<WarmLeaseRow[]>
  listHeld(now: number, limit: number): Promise<WarmLeaseRow[]>
  listPredictable(now: number, limit: number): Promise<WarmLeaseRow[]>
}

export interface WarmLeasesOptions {
  store: WarmLeaseStore
  /** Resume the key's box if it is stopped. Never create one. */
  warm(key: string, reason: WarmReason): Promise<WarmBoxOutcome>
  /**
   * Optional: touch the running box through a path the platform counts as
   * activity (an exec of `true`). Needed only when `burstHoldMs` exceeds
   * `boxIdleMs`; without it a burst hold is just the box's own idle timeout.
   */
  keepAlive?(key: string): Promise<void>
  /** The idle timeout the key's boxes were created with. Default 30 min, the platform default. */
  boxIdleMs?: number
  /** How long a warm waits for its first turn. Default 10 min. */
  holdMs?: number
  /** How long the box stays held after a turn. Default `boxIdleMs` (no pings). */
  burstHoldMs?: number
  /** Unused-warm box time allowed per key per UTC day. Default 30 min. */
  dailyBudgetMs?: number
  /** Reasons subject to the budget. Default page-open, member-activity, predicted, scheduled. */
  budgetedReasons?: readonly string[]
  /** Starting predicted-warm threshold, a probability. Default 0.25. */
  initialThreshold?: number
  onEvent?(event: WarmLeaseEvent): void
  now?(): number
  newId?(): string
}

export interface WarmLeases {
  /** A signal that a member may need `key`'s box soon. Awaits the warm when it starts one. */
  signal(key: string, reason: WarmReason): Promise<WarmSignalResult>
  /** Call when a turn is admitted for `key`, before its box is placed. */
  turn(key: string): Promise<WarmTurnResult>
  /** End expired leases, ping held boxes, and start predicted warms. Run from a cron. */
  sweep(options?: { limit?: number }): Promise<WarmSweepReport>
}

/** 144 ten-minute bins of the UTC day, then 7 weekday counts (Monday first). */
export const WARM_SLOTS = 151
const DAY_BINS = 144
const BIN_MS = 10 * 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const SLOT_HALF_LIFE_MS = 14 * DAY_MS
const PING_MARGIN_MS = 2 * 60_000
const THRESHOLD_FLOOR = 0.05
const THRESHOLD_CEILING = 0.95
const DEFAULT_BUDGETED = ['page-open', 'member-activity', 'predicted', 'scheduled'] as const

/** UTC ten-minute bin of the day, 0..143. */
export function warmBinOf(at: number): number {
  return Math.floor((((at % DAY_MS) + DAY_MS) % DAY_MS) / BIN_MS)
}

/** UTC weekday, Monday = 0. */
export function warmWeekdayOf(at: number): number {
  return (new Date(at).getUTCDay() + 6) % 7
}

export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

/** Decay every slot to `at` with a 14-day half-life. */
export function decaySlots(slots: readonly number[], from: number, at: number): number[] {
  const factor = from > 0 && at > from ? 0.5 ** ((at - from) / SLOT_HALF_LIFE_MS) : 1
  return Array.from({ length: WARM_SLOTS }, (_, i) => (slots[i] ?? 0) * factor)
}

/** Record one cold arrival at `at`. */
export function addColdArrival(slots: readonly number[], slotsAt: number, at: number): number[] {
  const next = decaySlots(slots, slotsAt, at)
  next[warmBinOf(at)] = (next[warmBinOf(at)] ?? 0) + 1
  next[DAY_BINS + warmWeekdayOf(at)] = (next[DAY_BINS + warmWeekdayOf(at)] ?? 0) + 1
  return next
}

/**
 * Chance of at least one cold arrival in `[at, at + windowMs)`.
 *
 * Each ten-minute bin's rate is its decayed count over the effective days
 * observed, smoothed over its neighbours (a shift that starts at 07:00 sends
 * its first message anywhere from 06:55 to 07:15), and scaled by how busy the
 * window's weekday is against the average weekday. The weekday factor is
 * smoothed toward 1 because two weeks hold only two of each weekday.
 */
export function predictColdArrival(
  row: Pick<WarmLeaseRow, 'slots' | 'slotsAt' | 'firstSeenAt'>,
  at: number,
  windowMs: number,
): number {
  if (row.firstSeenAt <= 0 || row.slots.length !== WARM_SLOTS) return 0
  const slots = decaySlots(row.slots, row.slotsAt, at)
  const decay = Math.LN2 / SLOT_HALF_LIFE_MS
  const observedMs = Math.max(DAY_MS, at - row.firstSeenAt)
  const days = (1 - Math.exp(-decay * observedMs)) / decay / DAY_MS
  const weekdays = slots.slice(DAY_BINS)
  const meanWeekday = weekdays.reduce((sum, v) => sum + v, 0) / 7
  const bin = (i: number) => slots[((i % DAY_BINS) + DAY_BINS) % DAY_BINS] ?? 0
  let expected = 0
  for (let start = at; start < at + windowMs; ) {
    const index = warmBinOf(start)
    const binEnd = start - (((start % BIN_MS) + BIN_MS) % BIN_MS) + BIN_MS
    const end = Math.min(binEnd, at + windowMs)
    const smoothed = 0.25 * bin(index - 1) + 0.5 * bin(index) + 0.25 * bin(index + 1)
    const weekday = ((weekdays[warmWeekdayOf(start)] ?? 0) + 1) / (meanWeekday + 1)
    expected += (smoothed / days) * weekday * ((end - start) / BIN_MS)
    start = end
  }
  return 1 - Math.exp(-expected)
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createWarmLeases(options: WarmLeasesOptions): WarmLeases {
  const { store } = options
  const boxIdleMs = options.boxIdleMs ?? 30 * 60_000
  const holdMs = options.holdMs ?? 10 * 60_000
  const burstHoldMs = options.burstHoldMs ?? boxIdleMs
  const dailyBudgetMs = options.dailyBudgetMs ?? 30 * 60_000
  const budgeted = new Set<string>(options.budgetedReasons ?? DEFAULT_BUDGETED)
  const initialThreshold = options.initialThreshold ?? 0.25
  const now = options.now ?? (() => Date.now())
  const newId = options.newId ?? (() => crypto.randomUUID())

  const emit = (event: WarmLeaseEvent): void => {
    try {
      options.onEvent?.(event)
    } catch {
      // Observability must not change a warm's outcome.
    }
  }

  const spentToday = (row: WarmLeaseRow | null, at: number): number =>
    row && row.day === utcDay(at) ? row.dayWarmMs : 0

  /** Box time this lease caused: up until the box's idle timeout after its last warm activity. */
  function chargeOf(row: WarmLeaseRow): number {
    if (!row.resumed || row.usedAt > 0 || row.warmAt <= 0) return 0
    const lastActivity = Math.max(row.warmAt, row.pingAt)
    return Math.max(row.holdUntil, lastActivity + boxIdleMs) - row.warmAt
  }

  async function signal(key: string, reason: WarmReason): Promise<WarmSignalResult> {
    const at = now()
    if (budgeted.has(reason)) {
      const row = await store.read(key)
      if (!(row?.leaseId) && spentToday(row, at) >= dailyBudgetMs) {
        emit({ type: 'warm_declined', key, reason, why: 'budget' })
        return { outcome: 'declined' }
      }
    }
    const leaseId = newId()
    const live = await store.begin(key, leaseId, reason, at, at + holdMs)
    if (live !== leaseId) return { outcome: 'extended' }

    let box: WarmBoxOutcome
    try {
      box = await options.warm(key, reason)
    } catch (err) {
      await store.end(key, leaseId, utcDay(at), 0)
      emit({ type: 'warm_failed', key, reason, error: errText(err) })
      return { outcome: 'failed' }
    }
    const warmAt = now()
    if (box === 'absent') {
      await store.end(key, leaseId, utcDay(at), 0)
      emit({ type: 'warm_declined', key, reason, why: 'absent' })
      return { outcome: 'declined', box }
    }
    await store.markWarm(key, leaseId, warmAt, box === 'resumed')
    emit({ type: 'warm_started', key, reason, outcome: box, ms: warmAt - at })
    return { outcome: 'started', box }
  }

  async function turn(key: string): Promise<WarmTurnResult> {
    const at = now()
    const before = await store.markUsed(key, at, at + burstHoldMs)
    const coldArrival = !before || before.lastTurnAt <= 0 || at - before.lastTurnAt > boxIdleMs
    const hit = Boolean(
      before?.leaseId && before.usedAt <= 0 && before.resumed && before.warmAt > 0 && before.warmAt <= at,
    )
    if (hit && before) {
      emit({ type: 'warm_hit', key, reason: before.reason ?? 'unknown', leadMs: at - before.startedAt })
    }
    if (coldArrival) {
      const slots = addColdArrival(before?.slots ?? [], before?.slotsAt ?? 0, at)
      await store.writeProfile(key, slots, at, before?.firstSeenAt || at)
    }
    return { hit, coldArrival }
  }

  async function sweep(sweepOptions: { limit?: number } = {}): Promise<WarmSweepReport> {
    const limit = sweepOptions.limit ?? 50
    const at = now()
    const report: WarmSweepReport = { ended: 0, wasted: 0, pinged: 0, predicted: 0, errors: 0 }

    for (const row of await store.listExpired(at, limit)) {
      if (!row.leaseId) continue
      const charge = chargeOf(row)
      let threshold: number | undefined
      if (row.reason === 'predicted' && row.resumed) {
        const current = row.threshold > 0 ? row.threshold : initialThreshold
        threshold = Math.min(THRESHOLD_CEILING, Math.max(THRESHOLD_FLOOR, current * (row.usedAt > 0 ? 0.85 : 1.3)))
      }
      await store.end(row.key, row.leaseId, utcDay(row.warmAt || row.startedAt), charge, threshold)
      report.ended += 1
      if (charge > 0) {
        report.wasted += 1
        emit({ type: 'warm_wasted', key: row.key, reason: row.reason ?? 'unknown', minutes: Math.round(charge / 60_000) })
      }
    }

    if (options.keepAlive && burstHoldMs > boxIdleMs) {
      for (const row of await store.listHeld(at, limit)) {
        const lastActivity = Math.max(row.pingAt, row.lastTurnAt, row.warmAt)
        if (lastActivity + boxIdleMs - PING_MARGIN_MS > at) continue
        if (row.holdUntil <= lastActivity + boxIdleMs) continue
        try {
          await options.keepAlive(row.key)
          await store.markPinged(row.key, at)
          report.pinged += 1
        } catch {
          report.errors += 1
        }
      }
    }

    for (const row of await store.listPredictable(at, limit)) {
      if (row.leaseId || at - row.predictedAt < HOUR_MS) continue
      if (row.lastTurnAt > 0 && at - row.lastTurnAt < boxIdleMs) continue
      const threshold = row.threshold > 0 ? row.threshold : initialThreshold
      if (predictColdArrival(row, at, holdMs) < threshold) continue
      await store.markPredicted(row.key, at)
      try {
        const result = await signal(row.key, 'predicted')
        if (result.outcome === 'started') report.predicted += 1
        if (result.outcome === 'failed') report.errors += 1
      } catch {
        report.errors += 1
      }
    }
    return report
  }

  return { signal, turn, sweep }
}
