/**
 * The fold is the store's whole contract: it is what lets the port skip
 * compare-and-set without a concurrent writer producing a WRONG record. These
 * pin each merge rule, and the asymmetry the design rests on — a lost race can
 * only ever tighten the derived ceiling, never loosen it.
 */
import { describe, expect, it } from 'vitest'
import { createInMemorySpendLedgerStore, createSpendLedger, foldSpendBoxRecord } from './store'
import type { SpendBoxRecord } from './types'

const T0 = Date.parse('2026-07-01T00:00:00.000Z')
const MIN = 60_000

function record(over: Partial<SpendBoxRecord> = {}): SpendBoxRecord {
  return {
    sandboxId: 'sb_1',
    workspaceId: 'ws_1',
    createdAt: T0,
    idleTimeoutSeconds: 3600,
    maxLifetimeSeconds: 86_400,
    lastActivityAt: T0,
    openDetachedRunIds: [],
    stoppedAt: null,
    deletedAt: null,
    ...over,
  }
}

describe('foldSpendBoxRecord', () => {
  it('moves activity forward only — a replayed older event cannot rewind the ceiling', () => {
    const base = record({ lastActivityAt: T0 + 10 * MIN })
    expect(foldSpendBoxRecord(base, { observedActivityAt: T0 + 20 * MIN }).lastActivityAt).toBe(
      T0 + 20 * MIN,
    )
    expect(foldSpendBoxRecord(base, { observedActivityAt: T0 + 5 * MIN }).lastActivityAt).toBe(
      T0 + 10 * MIN,
    )
  })

  it('is idempotent and order-independent for activity, which is why the port needs no CAS', () => {
    const events = [T0 + 30 * MIN, T0 + 10 * MIN, T0 + 30 * MIN, T0 + 20 * MIN]
    const forward = events.reduce((acc, at) => foldSpendBoxRecord(acc, { observedActivityAt: at }), record())
    const reversed = [...events]
      .reverse()
      .reduce((acc, at) => foldSpendBoxRecord(acc, { observedActivityAt: at }), record())
    expect(forward).toEqual(reversed)
    expect(forward.lastActivityAt).toBe(T0 + 30 * MIN)
  })

  it('treats open detached runs as a set', () => {
    let row = foldSpendBoxRecord(record(), { openDetachedRunAdd: 'run_a' })
    row = foldSpendBoxRecord(row, { openDetachedRunAdd: 'run_a' })
    row = foldSpendBoxRecord(row, { openDetachedRunAdd: 'run_b' })
    expect(row.openDetachedRunIds).toEqual(['run_a', 'run_b'])
    row = foldSpendBoxRecord(row, { openDetachedRunRemove: 'run_a' })
    row = foldSpendBoxRecord(row, { openDetachedRunRemove: 'run_missing' })
    expect(row.openDetachedRunIds).toEqual(['run_b'])
  })

  it('clears a stop when work is later observed — the box came back', () => {
    const stopped = foldSpendBoxRecord(record(), { stoppedAt: T0 + 10 * MIN })
    expect(stopped.stoppedAt).toBe(T0 + 10 * MIN)
    const resumed = foldSpendBoxRecord(stopped, { observedActivityAt: T0 + 20 * MIN })
    expect(resumed.stoppedAt).toBeNull()
  })

  it('ignores a stop that predates observed work, which is not the stop that closed this box', () => {
    const busy = record({ lastActivityAt: T0 + 30 * MIN })
    expect(foldSpendBoxRecord(busy, { stoppedAt: T0 + 10 * MIN }).stoppedAt).toBeNull()
  })

  it('sets delete once — a duplicate delivery is not a second deletion', () => {
    const deleted = foldSpendBoxRecord(record(), { deletedAt: T0 + 5 * MIN })
    expect(foldSpendBoxRecord(deleted, { deletedAt: T0 + 50 * MIN }).deletedAt).toBe(T0 + 5 * MIN)
  })
})

describe('createSpendLedger', () => {
  it('inserts on first sight and records activity on every later sight', async () => {
    const store = createInMemorySpendLedgerStore()
    const ledger = createSpendLedger({ store, now: () => T0 })

    const first = await ledger.observeSandbox({
      sandboxId: 'sb_1',
      workspaceId: 'ws_1',
      idleTimeoutSeconds: 3600,
      maxLifetimeSeconds: 86_400,
    })
    expect(first.createdAt).toBe(T0)
    expect(store.records()).toHaveLength(1)

    const second = await ledger.observeSandbox({
      sandboxId: 'sb_1',
      workspaceId: 'ws_1',
      idleTimeoutSeconds: 3600,
      at: T0 + 40 * MIN,
    })
    // Reuse and resume are both "billable again"; neither restarts the clock.
    expect(second.createdAt).toBe(T0)
    expect(second.lastActivityAt).toBe(T0 + 40 * MIN)
    expect(store.records()).toHaveLength(1)
  })

  it('tracks a detached run from dispatch to confirmed end', async () => {
    const store = createInMemorySpendLedgerStore()
    const ledger = createSpendLedger({ store, now: () => T0 })
    await ledger.observeSandbox({ sandboxId: 'sb_1', workspaceId: 'ws_1', idleTimeoutSeconds: 3600 })

    const started = await ledger.recordDetachedRunStarted('sb_1', 'run_1', T0 + MIN)
    expect(started?.openDetachedRunIds).toEqual(['run_1'])
    const ended = await ledger.recordDetachedRunEnded('sb_1', 'run_1', T0 + 90 * MIN)
    expect(ended?.openDetachedRunIds).toEqual([])
    expect(ended?.lastActivityAt).toBe(T0 + 90 * MIN)
  })

  it('records stop and delete, and reports null for a box it has never seen', async () => {
    const store = createInMemorySpendLedgerStore()
    const ledger = createSpendLedger({ store, now: () => T0 })
    expect(await ledger.recordStopped('sb_missing')).toBeNull()

    await ledger.observeSandbox({ sandboxId: 'sb_1', workspaceId: 'ws_1', idleTimeoutSeconds: 3600 })
    expect((await ledger.recordStopped('sb_1', T0 + 5 * MIN))?.stoppedAt).toBe(T0 + 5 * MIN)
    expect((await ledger.recordDeleted('sb_1', T0 + 9 * MIN))?.deletedAt).toBe(T0 + 9 * MIN)
  })

  it('hands back copies, so a caller cannot mutate stored state through a returned row', async () => {
    const store = createInMemorySpendLedgerStore()
    const ledger = createSpendLedger({ store })
    const row = await ledger.observeSandbox({
      sandboxId: 'sb_1',
      workspaceId: 'ws_1',
      idleTimeoutSeconds: 3600,
      at: T0,
    })
    ;(row as { lastActivityAt: number }).lastActivityAt = T0 + 999 * MIN
    expect((await store.load('sb_1'))?.lastActivityAt).toBe(T0)
  })
})
