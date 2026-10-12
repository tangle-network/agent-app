import { describe, expect, it, vi } from 'vitest'
import { createMemoryTurnStreamHarness, createDurableTurnLock, MEMORY_TURN_STREAM_AUTH_SECRET, TURN_LOCK_TTL_MS } from '@tangle-network/agent-app/turn-stream'
import { TurnStreamDO } from '../src/turn-lock'

describe('detached workspace admission', () => {
  it('does not release an uncertain execution merely because the shared lease elapsed', async () => {
    const clock = vi.spyOn(Date, 'now')
    let now = 1_900_000_000_000
    clock.mockImplementation(() => now)
    try {
      const { namespace } = createMemoryTurnStreamHarness((state, secret) => new TurnStreamDO(state, { TURN_STREAM_AUTH_SECRET: secret }))
      const lock = createDurableTurnLock({ namespace, auth: { secret: MEMORY_TURN_STREAM_AUTH_SECRET }, scopeOf: () => 'workspace' })
      const input = { identity: { tenantId: 'owner', sessionId: 'thread' }, executionId: 'one', context: undefined, body: { turnId: crypto.randomUUID() } }
      const first = await lock.acquire(input)
      expect(first.acquired).toBe(true)
      now += TURN_LOCK_TTL_MS + 1
      expect((await lock.acquire({ ...input, executionId: 'two', body: { turnId: crypto.randomUUID() } })).acquired).toBe(false)
      if (!first.acquired) throw new Error('No lock')
      await lock.release(first.handle)
      expect((await lock.acquire({ ...input, executionId: 'two' })).acquired).toBe(true)
    } finally { clock.mockRestore() }
  })
})
