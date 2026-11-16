import { expect, it } from 'vitest'
import { createD1TurnEventStore, TURN_EVENTS_MIGRATION_SQL } from '../../src/stream/index'
import { acquireDurableTurnLock, createDurableTurnLock, parkDurableTurnLock } from '../../src/turn-stream/index'
import { createMemoryTurnStreamHarness, MEMORY_TURN_STREAM_AUTH_SECRET } from '../../src/turn-stream/memory'
import { sqliteD1 } from '../launch-invariants/sqlite-d1'

/**
 * Incident 3 (2026-11-16): a turn's Worker invocation was cancelled and its lock release never ran, so every turn in
 * the workspace was refused for the lock's 30 minute TTL. The authenticated TurnStreamDO core, a migrated SQLite D1
 * turn store and the shipped lock adapter, with no reconcile wired by the product: a holder that ran in its Worker and
 * no longer renews a running row is reclaimed past the 60 s terminal grace; a holder a box may outlive, a holder whose
 * turn still renews its row and a parked release all keep their lock. No clock is replaced.
 */
it('reclaims a dead Worker-run holder by default and keeps box-run, live and parked holders', async () => {
  const turns = createD1TurnEventStore(sqliteD1(TURN_EVENTS_MIGRATION_SQL).d1)
  const durable = createMemoryTurnStreamHarness()
  const auth = { secret: MEMORY_TURN_STREAM_AUTH_SECRET }
  const lock = createDurableTurnLock<Record<string, never>>({ namespace: durable.namespace, auth, scopeOf: () => 'workspace', turnStore: turns })
  const hold = async (workspaceId: string, workerExecution: boolean) => {
    const held = await acquireDurableTurnLock(durable.namespace, { workspaceId, threadId: `${workspaceId}-earlier`, scope: 'workspace',
      executionId: crypto.randomUUID(), ...(workerExecution ? { workerExecution: true } : {}) }, auth)
    if (!held.acquired) throw new Error(`${workspaceId}: the holder could not take the lock`)
    return held.lock
  }
  const ask = (workspaceId: string) => lock.acquire({ identity: { tenantId: workspaceId, sessionId: `${workspaceId}-new` },
    executionId: crypto.randomUUID(), context: {}, body: {}, workerExecution: true })
  const refusal = async (workspaceId: string) => {
    const result = await ask(workspaceId)
    if (result.acquired) return 'acquired'
    return `${result.response.status} ${((await result.response.json()) as { error: { code: string } }).error.code}`
  }

  expect((await hold('dead', true)).workerExecution).toBe(true)
  expect((await hold('box', false)).workerExecution).toBeUndefined()
  await hold('live', true)
  await turns.setStatus('live-turn', 'running', 'live-earlier')
  const parked = await hold('parked', true)
  expect(await parkDurableTurnLock(durable.namespace, { workspaceId: 'parked', threadId: 'parked-earlier', scope: 'workspace',
    executionId: parked.executionId, lockId: parked.lockId }, auth)).toBe(true)

  expect(await refusal('dead')).toBe('409 workspace_turn_in_flight') // inside the terminal grace
  await new Promise(resolve => setTimeout(resolve, 61_000))
  expect(await refusal('dead')).toBe('acquired')
  expect(await refusal('box')).toBe('409 workspace_turn_in_flight')
  expect(await refusal('live')).toBe('409 workspace_turn_in_flight')
  expect(await refusal('parked')).toBe('409 workspace_turn_in_flight')
}, 120_000)
