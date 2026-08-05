/**
 * The ceiling is only useful if it is an UPPER bound under everything the
 * product cannot observe. These pin each blind spot named in
 * `computeExpectedCeiling`'s contract, and the two places the bound tightens.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_CEILING_TOLERANCE_MS, computeExpectedCeiling } from './ceiling'
import type { SpendBoxRecord } from './types'

const T0 = Date.parse('2026-07-01T00:00:00.000Z')
const HOUR = 3_600_000

function record(over: Partial<SpendBoxRecord> = {}): SpendBoxRecord {
  return {
    sandboxId: 'sb_1',
    workspaceId: 'ws_1',
    createdAt: T0,
    idleTimeoutSeconds: 3600,
    maxLifetimeSeconds: 86_400,
    lastActivityAt: T0 + HOUR,
    openDetachedRunIds: [],
    stoppedAt: null,
    deletedAt: null,
    ...over,
  }
}

describe('the default tolerance', () => {
  it('matches the platform\'s own settlement-staleness threshold, 900 s', () => {
    expect(DEFAULT_CEILING_TOLERANCE_MS).toBe(900_000)
  })
})

describe('computeExpectedCeiling — the ordinary case', () => {
  it('bounds an abandoned box at its activity span plus one idle window', () => {
    const ceiling = computeExpectedCeiling(record(), { asOf: T0 + 200 * HOUR })
    expect(ceiling.basis).toBe('idle-timeout')
    // one hour of work + one hour of idle + fifteen minutes of slack
    expect(ceiling.ceilingMs).toBe(2 * HOUR + DEFAULT_CEILING_TOLERANCE_MS)
    expect(ceiling.bounded).toBe(true)
  })

  it('is not fooled by a huge settled duration — the bound does not move', () => {
    const wide = computeExpectedCeiling(record(), { asOf: T0 + 10_000 * HOUR })
    expect(wide.ceilingMs).toBe(2 * HOUR + DEFAULT_CEILING_TOLERANCE_MS)
  })
})

describe('what tightens the ceiling', () => {
  it('an observed stop replaces the idle window', () => {
    const ceiling = computeExpectedCeiling(
      record({ stoppedAt: T0 + 90 * 60_000 }),
      { asOf: T0 + 200 * HOUR },
    )
    expect(ceiling.basis).toBe('stopped')
    expect(ceiling.ceilingMs).toBe(90 * 60_000 + DEFAULT_CEILING_TOLERANCE_MS)
  })

  it('an observed delete wins over an observed stop', () => {
    const ceiling = computeExpectedCeiling(
      record({ stoppedAt: T0 + 90 * 60_000, deletedAt: T0 + 30 * 60_000 }),
      { asOf: T0 + 200 * HOUR },
    )
    expect(ceiling.basis).toBe('deleted')
    expect(ceiling.ceilingMs).toBe(30 * 60_000 + DEFAULT_CEILING_TOLERANCE_MS)
  })

  it('unelapsed time cannot have been billed, so a future idle horizon clamps to now', () => {
    // Reconciled ten minutes after the last activity: the idle window still has
    // fifty minutes to run, but none of it has happened yet.
    const ceiling = computeExpectedCeiling(record(), { asOf: T0 + HOUR + 10 * 60_000 })
    expect(ceiling.horizonAt).toBe(T0 + HOUR + 10 * 60_000)
    expect(ceiling.ceilingMs).toBe(70 * 60_000 + DEFAULT_CEILING_TOLERANCE_MS)
  })

  it('never produces a negative ceiling from a horizon before creation', () => {
    const ceiling = computeExpectedCeiling(
      record({ lastActivityAt: T0, deletedAt: T0 - HOUR }),
      { asOf: T0 + HOUR },
    )
    expect(ceiling.ceilingMs).toBe(DEFAULT_CEILING_TOLERANCE_MS)
  })
})

describe('the blind spots the product cannot observe', () => {
  it('an unfinished detached run abandons the activity bound rather than overstating confidence', () => {
    const ceiling = computeExpectedCeiling(
      record({ maxLifetimeSeconds: null, openDetachedRunIds: ['run_1'] }),
      { asOf: T0 + 200 * HOUR },
    )
    expect(ceiling.basis).toBe('open-detached-run')
    expect(ceiling.bounded).toBe(false)
    expect(ceiling.ceilingMs).toBe(200 * HOUR + DEFAULT_CEILING_TOLERANCE_MS)
  })

  it('a max lifetime rescues that case — the platform destroys the box regardless', () => {
    const ceiling = computeExpectedCeiling(
      record({ openDetachedRunIds: ['run_1'] }),
      { asOf: T0 + 200 * HOUR },
    )
    expect(ceiling.basis).toBe('max-lifetime')
    expect(ceiling.bounded).toBe(true)
    expect(ceiling.ceilingMs).toBe(24 * HOUR + DEFAULT_CEILING_TOLERANCE_MS)
  })

  it('a resolved detached run returns the box to its activity bound', () => {
    const ceiling = computeExpectedCeiling(record({ openDetachedRunIds: [] }), {
      asOf: T0 + 200 * HOUR,
    })
    expect(ceiling.basis).toBe('idle-timeout')
  })

  it('a reconnect needs no special case — later activity widens the bound on its own', () => {
    const before = computeExpectedCeiling(record(), { asOf: T0 + 200 * HOUR })
    const after = computeExpectedCeiling(record({ lastActivityAt: T0 + 5 * HOUR }), {
      asOf: T0 + 200 * HOUR,
    })
    expect(after.ceilingMs).toBe(before.ceilingMs + 4 * HOUR)
  })

  it('a platform-side suspend the product never sees cannot break the bound, because it only removes billable time', () => {
    // Nothing widens for a suspend: the same record yields the same ceiling
    // whether or not the platform parked the box inside that window.
    const ceiling = computeExpectedCeiling(record(), { asOf: T0 + 200 * HOUR })
    expect(ceiling.ceilingMs).toBe(2 * HOUR + DEFAULT_CEILING_TOLERANCE_MS)
  })
})
