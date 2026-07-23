import { describe, expect, it } from 'vitest'

import {
  activeTurnLock,
  appendSegmentEvent,
  createSegmentStore,
  createTurnLock,
  interruptedReleaseApplies,
  pruneStaleThreads,
  replayActiveSegment,
  scopeIndexChannelKey,
  threadChannelKey,
  turnEventStorageKey,
  turnLockChannelKey,
  turnLockMatchesRelease,
  turnStorageChannelKey,
  TURN_LOCK_TTL_MS,
  type DurableTurnLock,
  type TurnStreamEvent,
} from '../../src/turn-stream/core'

function event(type: string, data: unknown = {}): TurnStreamEvent {
  return { type, data, timestamp: 1 }
}

describe('segment store', () => {
  it('stamps a monotonic seq per execution and replays only after the cursor', () => {
    const store = createSegmentStore()
    appendSegmentEvent(store, 'exec-1', event('session.run.started'))
    appendSegmentEvent(store, 'exec-1', event('text', { text: 'a' }))
    const third = appendSegmentEvent(store, 'exec-1', event('text', { text: 'b' }))
    expect(third.seq).toBe(3)

    const replayed = replayActiveSegment(store, 1)
    expect(replayed.map((e) => e.seq)).toEqual([2, 3])
  })

  it('a new turn evicts prior segments so a resumer replays only the active turn', () => {
    const store = createSegmentStore()
    appendSegmentEvent(store, 'exec-1', event('session.run.started'))
    appendSegmentEvent(store, 'exec-1', event('text'))
    appendSegmentEvent(store, 'exec-2', event('session.run.started'))
    expect(store.segments.has('exec-1')).toBe(false)
    expect(store.activeExecutionId).toBe('exec-2')
  })

  it('a terminal run event closes the segment: replay returns nothing', () => {
    const store = createSegmentStore()
    appendSegmentEvent(store, 'exec-1', event('session.run.started'))
    appendSegmentEvent(store, 'exec-1', event('session.run.completed'))
    expect(replayActiveSegment(store, 0)).toEqual([])
  })

  it('caps buffered events per segment, dropping the earliest', () => {
    const store = createSegmentStore()
    for (let i = 0; i < 5; i++) appendSegmentEvent(store, 'exec-1', event('text', { i }), 3)
    const replayed = replayActiveSegment(store, 0)
    expect(replayed).toHaveLength(3)
    expect(replayed[0]!.seq).toBe(3)
  })

  it('pruneStaleThreads removes only entries past the ttl', () => {
    const active = new Map([
      ['t1', 1000],
      ['t2', 5000],
    ])
    const removed = pruneStaleThreads(active, 8000, 3000)
    expect(removed).toEqual(['t1'])
    expect([...active.keys()]).toEqual(['t2'])
  })
})

describe('turn lock record', () => {
  const base = {
    workspaceId: 'ws',
    threadId: 'th',
    scope: 'thread' as const,
    executionId: 'exec-1',
    lockId: 'lock-1',
  }

  it('createTurnLock stamps start + TTL expiry', () => {
    const lock = createTurnLock({ ...base, turnId: 'turn-1' }, 1000)
    expect(lock.startedAt).toBe(1000)
    expect(lock.expiresAt).toBe(1000 + TURN_LOCK_TTL_MS)
    expect(lock.turnId).toBe('turn-1')
  })

  it('activeTurnLock treats an expired lock as absent and defaults a missing scope to thread', () => {
    const lock = createTurnLock(base, 1000, 500)
    expect(activeTurnLock(lock, 1400)).not.toBeNull()
    expect(activeTurnLock(lock, 1600)).toBeNull()
    const legacy = { ...lock, scope: undefined } as unknown as DurableTurnLock
    expect(activeTurnLock(legacy, 1400)?.scope).toBe('thread')
  })

  it('cooperative release requires the execution and, when given, the lockId', () => {
    const lock = createTurnLock(base, 1000)
    expect(turnLockMatchesRelease(lock, { executionId: 'exec-1', lockId: 'lock-1' })).toBe(true)
    expect(turnLockMatchesRelease(lock, { executionId: 'exec-1', lockId: 'other' })).toBe(false)
    expect(turnLockMatchesRelease(lock, { executionId: 'other', lockId: 'lock-1' })).toBe(false)
    // The DO's terminal-event auto-release knows only the execution.
    expect(turnLockMatchesRelease(lock, { executionId: 'exec-1' })).toBe(true)
  })

  describe('interrupted-release fence', () => {
    it('releases a lock started before the observed instant', () => {
      const lock = createTurnLock(base, 1000)
      expect(interruptedReleaseApplies(lock, { threadId: 'th', interruptedAt: 2000 })).toBe(true)
    })

    it('refuses a SUCCESSOR lock started after the observation', () => {
      const lock = createTurnLock(base, 3000)
      expect(interruptedReleaseApplies(lock, { threadId: 'th', interruptedAt: 2000 })).toBe(false)
    })

    it('refuses a different thread', () => {
      const lock = createTurnLock(base, 1000)
      expect(interruptedReleaseApplies(lock, { threadId: 'other', interruptedAt: 2000 })).toBe(false)
    })

    it('when both sides name a turn, they must match; a turnless lock refuses a turn-specific release', () => {
      const withTurn = createTurnLock({ ...base, turnId: 'turn-1' }, 1000)
      expect(interruptedReleaseApplies(withTurn, { threadId: 'th', interruptedAt: 2000, turnId: 'turn-1' })).toBe(true)
      expect(interruptedReleaseApplies(withTurn, { threadId: 'th', interruptedAt: 2000, turnId: 'turn-2' })).toBe(false)
      expect(interruptedReleaseApplies(withTurn, { threadId: 'th', interruptedAt: 2000 })).toBe(false)
      const withoutTurn = createTurnLock(base, 1000)
      expect(interruptedReleaseApplies(withoutTurn, { threadId: 'th', interruptedAt: 2000, turnId: 'turn-1' })).toBe(false)
    })
  })
})

describe('channel keys', () => {
  it('locks contend on the reference-consumer keying: workspace scope shares the workspace channel', () => {
    expect(turnLockChannelKey('ws', 'th', 'workspace')).toBe('ws')
    expect(turnLockChannelKey('ws', 'th', 'thread')).toBe('ws:th')
    expect(threadChannelKey('ws', 'th')).toBe('ws:th')
  })

  it('turn/scope storage channels are namespaced away from thread channels', () => {
    expect(turnStorageChannelKey('t-1')).toBe('turn:t-1')
    expect(scopeIndexChannelKey('th')).toBe('scope:th')
  })

  it('turn-event storage keys sort in seq order', () => {
    expect(turnEventStorageKey(2) < turnEventStorageKey(10)).toBe(true)
  })
})
