import { createWarmCache, type WarmCacheOptions, type WarmCacheSource } from '../sandbox/warm-cache'

/**
 * A billable turn's seat and balance verdict, read from Platform once per user
 * per window instead of on every turn. Lifted from Creative
 * (creative-agent#692): in production on 2026-10-21 its seat and balance reads
 * took 723 ms each, most of the 949 ms of its turn gates.
 *
 * Only a passing verdict is kept. A refusal is never cached, so a seatless or
 * unfunded user always gets the live read and its 402. Within the window the
 * balance stays enforced where money moves: the Tangle Router holds spend
 * before it calls a provider and refuses a balance at or below zero. The entry
 * ends at `windowMs` or at the seat's `paidThrough`, whichever is first, and is
 * dropped on any refusal: a seat or balance refusal read here, or one the
 * product sees elsewhere and reports with `forget` (Creative calls it when
 * Platform refuses to fund a turn's Router key). Only the data center's cache
 * holds it (no isolate copy), so that drop reaches every isolate in the data
 * center where it runs. The Workers cache is per data center: a verdict kept
 * in another data center lives on until its own window ends, and the Tangle
 * Router still refuses an unfunded key there.
 *
 * The verdict is keyed by `userId` unless `key` says otherwise: an app whose
 * seat or balance read depends on more than the user (a workspace, an
 * organization) must pass `key`, or one scope's verdict admits another.
 *
 * `windowMs` has no default. Platform sends apps no billing webhook, so the
 * window is how long a seat or balance change made on Platform can go unseen
 * by admission. Creative ships 5 minutes (`5 * 60_000`); the window for other
 * apps is Drew's call.
 */

/** A Platform read's verdict: only `allowed` decides admission. */
export interface BillableTurnVerdict {
  allowed: boolean
}

/** A seat verdict; `paidThrough` (ISO) ends a kept verdict early, `null` when access is not a dated seat. */
export interface BillableTurnSeatVerdict extends BillableTurnVerdict {
  paidThrough?: string | null
}

export interface BillableTurnAdmissionOptions<
  Input extends { userId: string },
  Seat extends BillableTurnSeatVerdict,
  Balance extends BillableTurnVerdict,
> {
  /** The cache URL's host, one per product, such as `billing-admission.creative.internal`. */
  namespace: string
  /** How long a passing verdict is kept. Required: see the module note. */
  windowMs: number
  readSeat(input: Input): Promise<Seat>
  readBalance(input: Input): Promise<Balance>
  /** The deployment environment in the cache key (see {@link WarmCacheOptions.env}). */
  env?: WarmCacheOptions['env']
  /** What a verdict is kept under: everything `readSeat` and `readBalance` depend on. Default `input.userId`. */
  key?(input: Input): string
}

export interface AdmitBillableTurnOptions {
  /** Turns a Platform read failure into the caller's error. */
  mapError?: (error: unknown) => never
  /** Names each Platform read (`gate_seat`, `gate_balance`) for the turn's timing. */
  track?: <T>(name: string, work: Promise<T>) => Promise<T>
  /** Read Platform even over a kept verdict, so the window starts now (a prewarm step). */
  refresh?: boolean
}

export type BillableTurnAdmissionResult<Seat, Balance> =
  | { source: WarmCacheSource }
  | { source: 'platform'; seat: Seat; balance?: Balance }

export interface BillableTurnAdmission<Input extends { userId: string }, Seat, Balance> {
  /**
   * Seat, then balance, read concurrently: a seat refusal or seat read failure
   * wins over anything the balance read returned. A kept verdict returns
   * without calling Platform. `balance` is absent only when the seat refused.
   */
  admit(input: Input & AdmitBillableTurnOptions): Promise<BillableTurnAdmissionResult<Seat, Balance>>
  /** A refusal seen elsewhere: the next turn under this key (the user id unless `key` is set) reads Platform again. */
  forget(key: string): Promise<void>
  /** How long a verdict read now is kept: the window, or less when `paidThrough` comes first. */
  heldMs(paidThrough: string | null | undefined): number
}

export function createBillableTurnAdmission<
  Input extends { userId: string },
  Seat extends BillableTurnSeatVerdict,
  Balance extends BillableTurnVerdict,
>(options: BillableTurnAdmissionOptions<Input, Seat, Balance>): BillableTurnAdmission<Input, Seat, Balance> {
  if (!(Number.isFinite(options.windowMs) && options.windowMs > 0)) {
    throw new Error('createBillableTurnAdmission: windowMs must be a positive number of milliseconds')
  }
  const verdicts = createWarmCache<{ paidThrough: string | null }>(options.namespace, { isolate: false, env: options.env })
  const keyOf = options.key ?? ((input: Input) => input.userId)
  const heldMs = (paidThrough: string | null | undefined) =>
    Math.min(options.windowMs, paidThrough ? Date.parse(paidThrough) - Date.now() : Infinity)

  return {
    heldMs,
    forget: key => verdicts.forget(key),
    async admit(input) {
      const key = keyOf(input)
      const warm = input.refresh ? null : await verdicts.read(key)
      if (warm && (warm.value.paidThrough === null || Date.parse(warm.value.paidThrough) > Date.now())) {
        return { source: warm.source }
      }
      const track = input.track ?? (<T>(_name: string, work: Promise<T>) => work)
      const mapError = input.mapError ?? ((error: unknown): never => { throw error })
      const [seatSettled, balanceSettled] = await Promise.allSettled([
        track('gate_seat', options.readSeat(input).catch(mapError)),
        track('gate_balance', options.readBalance(input).catch(mapError)),
      ])
      if (seatSettled.status === 'rejected') throw seatSettled.reason
      const seat = seatSettled.value
      if (!seat.allowed) {
        await verdicts.forget(key)
        return { source: 'platform', seat }
      }
      if (balanceSettled.status === 'rejected') throw balanceSettled.reason
      const balance = balanceSettled.value
      if (!balance.allowed) {
        await verdicts.forget(key)
        return { source: 'platform', seat, balance }
      }
      const paidThrough = seat.paidThrough ?? null
      const ttlMs = heldMs(paidThrough)
      if (ttlMs > 0) await verdicts.write(key, { paidThrough }, ttlMs)
      return { source: 'platform', seat, balance }
    },
  }
}
