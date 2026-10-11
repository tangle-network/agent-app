import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createD1WarmLeaseStore, WARM_LEASE_TABLE_DDL, type WarmLeaseD1Like } from './warm-lease-d1'
import {
  createWarmLeases,
  predictColdArrival,
  warmBinOf,
  warmWeekdayOf,
  type WarmBoxOutcome,
  type WarmLeaseEvent,
  type WarmLeasesOptions,
} from './warm-lease'

const MIN = 60_000
// Wednesday 2026-10-07 12:00:00Z.
const T0 = Date.UTC(2026, 9, 7, 12, 0, 0)

/** Real SQLite behind the D1 shape, so the upserts' race semantics are the engine's, not a fake's. */
function d1(db: DatabaseSync): WarmLeaseD1Like {
  return {
    prepare(query: string) {
      const stmt = db.prepare(query)
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              return (stmt.get(...(values as never[])) as T | undefined) ?? null
            },
            async run() {
              return stmt.run(...(values as never[]))
            },
            async all<T>() {
              return { results: stmt.all(...(values as never[])) as T[] }
            },
          }
        },
      }
    },
  }
}

function harness(overrides: Partial<WarmLeasesOptions> = {}, box: WarmBoxOutcome = 'resumed') {
  const db = new DatabaseSync(':memory:')
  db.exec(WARM_LEASE_TABLE_DDL)
  const store = createD1WarmLeaseStore(d1(db))
  const clock = { now: T0 }
  const events: WarmLeaseEvent[] = []
  const warms: string[] = []
  const pings: string[] = []
  let ids = 0
  const make = () =>
    createWarmLeases({
      store,
      async warm(key) {
        warms.push(key)
        clock.now += 3_000
        return box
      },
      async keepAlive(key) {
        pings.push(key)
      },
      boxIdleMs: 10 * MIN,
      onEvent: (e) => events.push(e),
      now: () => clock.now,
      newId: () => `lease-${++ids}`,
      ...overrides,
    })
  return { db, store, clock, events, warms, pings, leases: make(), make }
}

describe('warm leases', () => {
  it('starts one warm per key across isolates and extends the live lease', async () => {
    const h = harness()
    const other = h.make()
    const [a, b] = await Promise.all([h.leases.signal('ws-1', 'page-open'), other.signal('ws-1', 'composer-focus')])
    expect([a.outcome, b.outcome].sort()).toEqual(['extended', 'started'])
    expect(h.warms).toEqual(['ws-1'])
    expect(h.events.filter((e) => e.type === 'warm_started')).toHaveLength(1)
  })

  it('counts a turn on a warmed box as a hit once', async () => {
    const h = harness()
    await h.leases.signal('ws-1', 'page-open')
    h.clock.now += 2 * MIN
    expect(await h.leases.turn('ws-1')).toMatchObject({ hit: true, coldArrival: true })
    expect(await h.leases.turn('ws-1')).toMatchObject({ hit: false, coldArrival: false })
    const hits = h.events.filter((e) => e.type === 'warm_hit')
    expect(hits).toEqual([{ type: 'warm_hit', key: 'ws-1', reason: 'page-open', leadMs: 2 * MIN + 3_000 }])
  })

  it('charges an unused resumed warm until the box idle timeout and then refuses budgeted signals', async () => {
    const h = harness({ dailyBudgetMs: 15 * MIN })
    await h.leases.signal('ws-1', 'page-open')
    h.clock.now += 11 * MIN
    expect(await h.leases.sweep()).toMatchObject({ ended: 1, wasted: 1 })
    expect(h.events.at(-1)).toEqual({ type: 'warm_wasted', key: 'ws-1', reason: 'page-open', minutes: 10 })

    await h.leases.signal('ws-1', 'page-open')
    h.clock.now += 11 * MIN
    await h.leases.sweep()
    // 20 min charged against a 15 min budget: a page open is now refused, a composer focus is not.
    expect(await h.leases.signal('ws-1', 'page-open')).toEqual({ outcome: 'declined' })
    expect(h.events.at(-1)).toMatchObject({ type: 'warm_declined', why: 'budget' })
    expect((await h.leases.signal('ws-1', 'composer-focus')).outcome).toBe('started')
  })

  it('resets the budget on a new UTC day', async () => {
    const h = harness({ dailyBudgetMs: 5 * MIN })
    await h.leases.signal('ws-1', 'page-open')
    h.clock.now += 11 * MIN
    await h.leases.sweep()
    expect((await h.leases.signal('ws-1', 'page-open')).outcome).toBe('declined')
    h.clock.now += 24 * 60 * MIN
    expect((await h.leases.signal('ws-1', 'page-open')).outcome).toBe('started')
  })

  it('charges nothing when the box was already running', async () => {
    const h = harness({}, 'running')
    expect(await h.leases.signal('ws-1', 'page-open')).toEqual({ outcome: 'started', box: 'running' })
    h.clock.now += 11 * MIN
    expect(await h.leases.sweep()).toMatchObject({ ended: 1, wasted: 0 })
    expect((await h.leases.turn('ws-1')).hit).toBe(false)
  })

  it('clears the lease when there is no box or the warm throws', async () => {
    const absent = harness({}, 'absent')
    expect(await absent.leases.signal('ws-1', 'line-ingress')).toEqual({ outcome: 'declined', box: 'absent' })
    expect((await absent.store.read('ws-1'))?.leaseId).toBeNull()

    let fail = true
    const h = harness({
      async warm() {
        if (fail) throw new Error('resume refused')
        return 'resumed'
      },
    })
    expect((await h.leases.signal('ws-1', 'page-open')).outcome).toBe('failed')
    expect(h.events.at(-1)).toEqual({ type: 'warm_failed', key: 'ws-1', reason: 'page-open', error: 'resume refused' })
    fail = false
    expect((await h.leases.signal('ws-1', 'page-open')).outcome).toBe('started')
  })

  it('pings a held box only when the burst hold outlasts its idle timeout', async () => {
    const h = harness({ burstHoldMs: 30 * MIN })
    await h.leases.turn('ws-1')
    h.clock.now += 5 * MIN
    expect((await h.leases.sweep()).pinged).toBe(0)
    h.clock.now += 4 * MIN
    expect((await h.leases.sweep()).pinged).toBe(1)
    h.clock.now += 1 * MIN
    expect((await h.leases.sweep()).pinged).toBe(0)
    // Past the hold, the box is left to suspend.
    h.clock.now += 30 * MIN
    expect((await h.leases.sweep()).pinged).toBe(0)
    expect(h.pings).toEqual(['ws-1'])

    const plain = harness()
    await plain.leases.turn('ws-1')
    plain.clock.now += 9 * MIN
    expect((await plain.leases.sweep()).pinged).toBe(0)
  })

  it('learns a daily ramp, warms ahead of it, and raises the threshold after a wasted prediction', async () => {
    const h = harness()
    // A cold arrival at 15:00Z on seven consecutive days.
    for (let day = 0; day < 7; day++) {
      h.clock.now = T0 + day * 24 * 60 * MIN + 3 * 60 * MIN
      await h.leases.turn('ws-1')
    }
    // Next day at 14:55Z, five minutes before the usual first message.
    h.clock.now = T0 + 7 * 24 * 60 * MIN + 2 * 60 * MIN + 55 * MIN
    const row = await h.store.read('ws-1')
    expect(predictColdArrival(row!, h.clock.now, 10 * MIN)).toBeGreaterThan(0.25)
    expect(predictColdArrival(row!, h.clock.now - 6 * 60 * MIN, 10 * MIN)).toBeLessThan(0.05)
    expect((await h.leases.sweep()).predicted).toBe(1)
    expect(h.events.at(-1)).toMatchObject({ type: 'warm_started', reason: 'predicted' })
    // At most one predicted warm per key per hour.
    h.clock.now += MIN
    expect((await h.leases.sweep()).predicted).toBe(0)

    h.clock.now += 15 * MIN
    await h.leases.sweep()
    expect((await h.store.read('ws-1'))?.threshold).toBeCloseTo(0.325)
  })

  it('maps UTC ten-minute bins and weekdays from Monday', () => {
    expect(warmBinOf(Date.UTC(2026, 9, 5, 0, 0))).toBe(0)
    expect(warmBinOf(T0 + 9 * MIN)).toBe(72)
    expect(warmBinOf(Date.UTC(2026, 9, 11, 23, 59))).toBe(143)
    expect(warmWeekdayOf(Date.UTC(2026, 9, 5, 0, 0))).toBe(0)
    expect(warmWeekdayOf(T0)).toBe(2)
    expect(predictColdArrival({ slots: [], slotsAt: 0, firstSeenAt: 0 }, T0, 10 * MIN)).toBe(0)
  })
})
