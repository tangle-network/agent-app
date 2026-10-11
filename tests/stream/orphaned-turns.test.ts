/**
 * The shared orphaned-turn settlement, against the cases GTM settled by hand
 * on 2026-10-10: a stream left running two hours after its Worker died, a live
 * turn, a turn a durable owner holds without renewing, a producer that came
 * back, and a backlog larger than one run.
 */
import { describe, expect, it } from 'vitest'

import { checkTurnSettlement } from '../../src/launch-invariants/index'
import { createD1TurnEventStore, ORPHANED_TURN_CODE, settleOrphanedTurns, TURN_EVENTS_MIGRATION_SQL } from '../../src/stream/index'
import { sqliteD1 } from '../launch-invariants/sqlite-d1'

const MIN = 60_000
const NOW = Date.UTC(2026, 9, 10, 23, 7)

function fixture() {
  const { d1, sqlite } = sqliteD1(TURN_EVENTS_MIGRATION_SQL)
  let clock = NOW
  const store = createD1TurnEventStore(d1, { now: () => clock })
  const at = async <T>(time: number, run: () => Promise<T>) => {
    const saved = clock
    clock = time
    try { return await run() } finally { clock = saved }
  }
  const status = (turnId: string) => sqlite.prepare('SELECT status, updatedAt FROM turn_status WHERE turnId = ?').get(turnId) as { status: string; updatedAt: string }
  return { store, sqlite, at, status }
}

describe('settleOrphanedTurns', () => {
  it('ends a stream nothing renewed for two hours with a typed, retryable error naming its phase, and keeps its time', async () => {
    const { store, at, status } = fixture()
    await at(NOW - 120 * MIN, async () => {
      await store.setStatus('orphan', 'running', 'thread-1')
      await store.append('orphan', [
        { seq: 1, event: JSON.stringify({ type: 'turn', _t: 0 }) },
        { seq: 2, event: JSON.stringify({ type: 'session.run.phase', data: { phase: 'provisioning' }, _t: 40 }) },
      ])
    })
    const result = await settleOrphanedTurns({ store, now: NOW })
    expect(result.settled).toEqual([{ turnId: 'orphan', scopeId: 'thread-1', lastRenewedAt: NOW - 120 * MIN, detectionLagMs: 115 * MIN, phase: 'provisioning' }])
    expect(status('orphan')).toEqual({ status: 'error', updatedAt: new Date(NOW - 120 * MIN).toISOString() })
    const last = JSON.parse((await store.read('orphan', 0)).at(-1)!.event)
    expect(last).toMatchObject({ type: 'error', data: { code: ORPHANED_TURN_CODE, retryable: true }, _t: 40 })
    expect(last.data.message).toContain('during provisioning')
  })

  it('leaves a renewed turn, and a stale one its owner still holds', async () => {
    const { store, at, status } = fixture()
    await at(NOW - 2 * MIN, () => store.setStatus('live', 'running', 'thread-1'))
    await at(NOW - 30 * MIN, () => store.setStatus('held', 'running', 'thread-2'))
    const result = await settleOrphanedTurns({ store, now: NOW, isOwned: async (turn) => turn.scopeId === 'thread-2' })
    expect([result.settled, result.owned]).toEqual([[], ['held']])
    expect([status('live').status, status('held').status]).toEqual(['running', 'running'])
  })

  it('does not end a stream whose producer renewed it after the listing', async () => {
    const { store, at, status } = fixture()
    await at(NOW - 20 * MIN, () => store.setStatus('back', 'running', 'thread-1'))
    await settleOrphanedTurns({
      store,
      now: NOW,
      // The producer renews between the listing and the write.
      isOwned: async () => { await store.setStatus('back', 'running', 'thread-1'); return false },
    })
    expect(status('back').status).toBe('running')
  })

  it('settles a backlog a bounded run at a time', async () => {
    const { store, at } = fixture()
    for (let n = 0; n < 60; n += 1) await at(NOW - (60 + n) * MIN, () => store.setStatus(`t${n}`, 'running', 'thread'))
    expect((await settleOrphanedTurns({ store, now: NOW })).settled).toHaveLength(50)
    expect((await settleOrphanedTurns({ store, now: NOW })).settled).toHaveLength(10)
    expect((await settleOrphanedTurns({ store, now: NOW })).settled).toHaveLength(0)
  })

  it('run every 15 minutes, settles a turn within 15 minutes of its lease expiring', async () => {
    const { store, at } = fixture()
    // The worst case: the Worker died just after a run, so the next run is 15 minutes later.
    const died = NOW - 20 * MIN
    await at(died, () => store.setStatus('worst', 'running', 'thread'))
    const { settled } = await settleOrphanedTurns({ store, now: NOW })
    const verdict = checkTurnSettlement(settled.map((turn) => ({
      turnId: turn.turnId,
      requestedAt: died,
      terminals: [{ state: 'failed' as const, at: NOW, code: ORPHANED_TURN_CODE, retryable: true, attributedTo: died }],
      ownerEndedAt: turn.lastRenewedAt + 5 * MIN,
    })), { now: NOW })
    expect(verdict.pass, verdict.details.join('\n')).toBe(true)
    expect(settled[0]!.detectionLagMs).toBe(15 * MIN)
  })
})
