import { describe, expect, it } from 'vitest'

import {
  acquireDurableTurnLock,
  broadcastThreadCreated,
  broadcastTurnStreamEvent,
  broadcastWorkspaceActivity,
  createDurableObjectTurnEventStore,
  releaseDurableTurnLock,
  releaseInterruptedDurableTurnLock,
} from '../../src/turn-stream/adapters'
import { threadChannelKey, workspaceChannelKey, TURN_STREAM_PATHS } from '../../src/turn-stream/core'
import { TurnStreamDO, type TurnStreamDOState } from '../../src/turn-stream/do'
import { createMemoryTurnStreamHarness } from '../../src/turn-stream/memory'

const WS = 'ws-1'
const THREAD = 'th-1'

function harness() {
  return createMemoryTurnStreamHarness()
}

describe('TurnStreamDO lock endpoints', () => {
  it('single-flight: second acquire on the same channel 409s with the active lock', async () => {
    const { namespace } = harness()
    const first = await acquireDurableTurnLock(namespace, {
      workspaceId: WS,
      threadId: THREAD,
      scope: 'thread',
      executionId: 'exec-1',
      turnId: 'turn-1',
    })
    expect(first.acquired).toBe(true)

    const second = await acquireDurableTurnLock(namespace, {
      workspaceId: WS,
      threadId: 'th-other',
      scope: 'thread',
      executionId: 'exec-2',
    })
    // Different thread, thread scope → different channel → acquires fine.
    expect(second.acquired).toBe(true)

    const contended = await acquireDurableTurnLock(namespace, {
      workspaceId: WS,
      threadId: THREAD,
      scope: 'thread',
      executionId: 'exec-3',
    })
    expect(contended.acquired).toBe(false)
    if (!contended.acquired) {
      expect(contended.active.executionId).toBe('exec-1')
      expect(contended.active.turnId).toBe('turn-1')
    }
  })

  it('workspace scope serializes every thread in the workspace', async () => {
    const { namespace } = harness()
    const first = await acquireDurableTurnLock(namespace, {
      workspaceId: WS,
      threadId: THREAD,
      scope: 'workspace',
      executionId: 'exec-1',
    })
    expect(first.acquired).toBe(true)
    const other = await acquireDurableTurnLock(namespace, {
      workspaceId: WS,
      threadId: 'th-2',
      scope: 'workspace',
      executionId: 'exec-2',
    })
    expect(other.acquired).toBe(false)
  })

  it('cooperative release frees the channel; wrong lockId does not', async () => {
    const { namespace } = harness()
    const acquired = await acquireDurableTurnLock(namespace, {
      workspaceId: WS,
      threadId: THREAD,
      scope: 'thread',
      executionId: 'exec-1',
    })
    if (!acquired.acquired) throw new Error('expected acquire')

    const wrong = await releaseDurableTurnLock(namespace, {
      workspaceId: WS,
      threadId: THREAD,
      scope: 'thread',
      executionId: 'exec-1',
      lockId: 'not-the-lock',
    })
    expect(wrong.released).toBe(false)

    const right = await releaseDurableTurnLock(namespace, {
      workspaceId: WS,
      threadId: THREAD,
      scope: 'thread',
      executionId: 'exec-1',
      lockId: acquired.lock.lockId,
    })
    expect(right.released).toBe(true)

    const again = await acquireDurableTurnLock(namespace, {
      workspaceId: WS,
      threadId: THREAD,
      scope: 'thread',
      executionId: 'exec-2',
    })
    expect(again.acquired).toBe(true)
  })

  it('an expired lock is dead: a new acquire succeeds', async () => {
    const h = createMemoryTurnStreamHarness((state) => new TurnStreamDO(state, undefined, { lockTtlMs: 1 }))
    const first = await acquireDurableTurnLock(h.namespace, {
      workspaceId: WS,
      threadId: THREAD,
      scope: 'thread',
      executionId: 'exec-1',
    })
    expect(first.acquired).toBe(true)
    await new Promise((r) => setTimeout(r, 5))
    const second = await acquireDurableTurnLock(h.namespace, {
      workspaceId: WS,
      threadId: THREAD,
      scope: 'thread',
      executionId: 'exec-2',
    })
    expect(second.acquired).toBe(true)
  })

  it('interrupted release honors the successor fence and turn matching', async () => {
    const { namespace } = harness()
    const acquired = await acquireDurableTurnLock(namespace, {
      workspaceId: WS,
      threadId: THREAD,
      scope: 'thread',
      executionId: 'exec-1',
      turnId: 'turn-1',
    })
    if (!acquired.acquired) throw new Error('expected acquire')

    // Evidence observed BEFORE the lock started → successor survives.
    const stale = await releaseInterruptedDurableTurnLock(namespace, {
      workspaceId: WS,
      threadId: THREAD,
      interruptedAt: acquired.lock.startedAt - 1,
      turnId: 'turn-1',
    })
    expect(stale).toBe(false)

    // Wrong turn → refused.
    const wrongTurn = await releaseInterruptedDurableTurnLock(namespace, {
      workspaceId: WS,
      threadId: THREAD,
      interruptedAt: Date.now() + 1000,
      turnId: 'turn-2',
    })
    expect(wrongTurn).toBe(false)

    // Right turn, evidence after start → released (scope omitted: tries both).
    const released = await releaseInterruptedDurableTurnLock(namespace, {
      workspaceId: WS,
      threadId: THREAD,
      interruptedAt: Date.now() + 1000,
      turnId: 'turn-1',
    })
    expect(released).toBe(true)
  })

  it('a terminal run event on the thread channel auto-releases that channel lock', async () => {
    const { namespace } = harness()
    const acquired = await acquireDurableTurnLock(namespace, {
      workspaceId: WS,
      threadId: THREAD,
      scope: 'thread',
      executionId: 'exec-1',
    })
    expect(acquired.acquired).toBe(true)

    await broadcastTurnStreamEvent(namespace, {
      workspaceId: WS,
      threadId: THREAD,
      executionId: 'exec-1',
      event: { type: 'session.run.completed' },
    })

    const next = await acquireDurableTurnLock(namespace, {
      workspaceId: WS,
      threadId: THREAD,
      scope: 'thread',
      executionId: 'exec-2',
    })
    expect(next.acquired).toBe(true)
  })
})

describe('TurnStreamDO deferred-release seam', () => {
  class DeferringDO extends TurnStreamDO {
    deferring = new Set<string>()
    protected override async shouldDeferLockRelease(executionId: string): Promise<boolean> {
      return this.deferring.has(executionId)
    }
    async settle(executionId: string): Promise<boolean> {
      this.deferring.delete(executionId)
      return this.completeDeferredLockRelease(executionId)
    }
  }

  it('parks the release while the product task runs, completes it on settle', async () => {
    const h = createMemoryTurnStreamHarness((state) => new DeferringDO(state))
    const channel = h.channel(threadChannelKey(WS, THREAD))
    const doInstance = channel.instance as DeferringDO
    doInstance.deferring.add('exec-1')

    const acquired = await acquireDurableTurnLock(h.namespace, {
      workspaceId: WS,
      threadId: THREAD,
      scope: 'thread',
      executionId: 'exec-1',
    })
    if (!acquired.acquired) throw new Error('expected acquire')

    // Cooperative release defers…
    const releasing = await releaseDurableTurnLock(h.namespace, {
      workspaceId: WS,
      threadId: THREAD,
      scope: 'thread',
      executionId: 'exec-1',
      lockId: acquired.lock.lockId,
    })
    expect(releasing).toEqual({ released: false, deferred: true })

    // …the channel stays held (even against an interrupted release)…
    const interrupted = await releaseInterruptedDurableTurnLock(h.namespace, {
      workspaceId: WS,
      threadId: THREAD,
      scope: 'thread',
      interruptedAt: Date.now() + 1000,
    })
    expect(interrupted).toBe(false)
    const blocked = await acquireDurableTurnLock(h.namespace, {
      workspaceId: WS,
      threadId: THREAD,
      scope: 'thread',
      executionId: 'exec-2',
    })
    expect(blocked.acquired).toBe(false)

    // …until the product task settles.
    expect(await doInstance.settle('exec-1')).toBe(true)
    const after = await acquireDurableTurnLock(h.namespace, {
      workspaceId: WS,
      threadId: THREAD,
      scope: 'thread',
      executionId: 'exec-2',
    })
    expect(after.acquired).toBe(true)
  })
})

describe('TurnStreamDO viewer channel (sync replay XOR live fanout)', () => {
  it('replays the active segment from afterSeq on sync, then delivers live frames', async () => {
    const h = harness()
    const channelKey = threadChannelKey(WS, THREAD)

    await broadcastTurnStreamEvent(h.namespace, {
      workspaceId: WS,
      threadId: THREAD,
      executionId: 'exec-1',
      event: { type: 'session.run.started' },
    })
    await broadcastTurnStreamEvent(h.namespace, {
      workspaceId: WS,
      threadId: THREAD,
      executionId: 'exec-1',
      event: { type: 'text', data: { text: 'hello' } },
    })

    // Reconnect mid-turn: replay everything after seq 1 (the started marker).
    const viewer = await h.channel(channelKey).connect({ sessionId: THREAD, scope: 'thread', afterSeq: 1 })
    expect(viewer.frames).toHaveLength(1)
    expect(JSON.parse(viewer.frames[0]!)).toMatchObject({ type: 'text', seq: 2 })

    // Live from here on.
    await broadcastTurnStreamEvent(h.namespace, {
      workspaceId: WS,
      threadId: THREAD,
      executionId: 'exec-1',
      event: { type: 'text', data: { text: ' world' } },
    })
    expect(viewer.frames).toHaveLength(2)
    expect(JSON.parse(viewer.frames[1]!)).toMatchObject({ seq: 3 })
  })

  it('an un-synced socket receives no live frames (no drop/duplicate race)', async () => {
    const h = harness()
    const channelKey = threadChannelKey(WS, THREAD)
    const channel = h.channel(channelKey)

    // Attach without syncing: simulate mid-handshake.
    const socket = await channel.connect({ sessionId: THREAD, scope: 'thread' })
    const frames0 = socket.frames.length

    // A dead socket must not break fanout for others either.
    socket.close()
    await broadcastTurnStreamEvent(h.namespace, {
      workspaceId: WS,
      threadId: THREAD,
      executionId: 'exec-1',
      event: { type: 'session.run.started' },
    })
    expect(socket.frames.length).toBe(frames0)
  })

  it('workspace channel: sync replays the responding set and recent thread.created markers', async () => {
    const h = harness()
    await broadcastWorkspaceActivity(h.namespace, WS, THREAD, 'start')
    await broadcastThreadCreated(h.namespace, WS, { threadId: 'th-new', title: 'New thread' })

    const viewer = await h.channel(workspaceChannelKey(WS)).connect({ sessionId: WS, scope: 'workspace' })
    const types = viewer.frames.map((f) => (JSON.parse(f) as { type: string }).type)
    expect(types).toContain('thread.activity')
    expect(types).toContain('thread.created')

    // `end` clears the responding set for late joiners.
    await broadcastWorkspaceActivity(h.namespace, WS, THREAD, 'end')
    const later = await h.channel(workspaceChannelKey(WS)).connect({ sessionId: WS, scope: 'workspace' })
    const laterTypes = later.frames.map((f) => (JSON.parse(f) as { type: string }).type)
    expect(laterTypes).not.toContain('thread.activity')
  })
})

describe('TurnStreamDO turn-event storage (TurnEventStore contract)', () => {
  it('append/read/status round-trip with fromSeq cursor', async () => {
    const { namespace } = harness()
    const store = createDurableObjectTurnEventStore(namespace)

    await store.setStatus('t-1', 'running', THREAD)
    await store.append('t-1', [
      { seq: 1, event: '{"type":"turn"}' },
      { seq: 2, event: '{"type":"text"}' },
    ])
    await store.append('t-1', [{ seq: 3, event: '{"type":"result"}' }])

    expect(await store.read('t-1', 0)).toEqual([
      { seq: 1, event: '{"type":"turn"}' },
      { seq: 2, event: '{"type":"text"}' },
      { seq: 3, event: '{"type":"result"}' },
    ])
    expect(await store.read('t-1', 2)).toEqual([{ seq: 3, event: '{"type":"result"}' }])
    expect(await store.getStatus('t-1')).toBe('running')

    await store.setStatus('t-1', 'complete', THREAD)
    expect(await store.getStatus('t-1')).toBe('complete')
    expect(await store.getStatus('t-unknown')).toBeNull()
  })

  it('listRunning: newest running first, terminal turns drop out', async () => {
    const { namespace } = harness()
    const store = createDurableObjectTurnEventStore(namespace)

    await store.setStatus('t-1', 'running', THREAD)
    await new Promise((r) => setTimeout(r, 2))
    await store.setStatus('t-2', 'running', THREAD)
    expect(await store.listRunning!(THREAD)).toEqual(['t-2', 't-1'])

    await store.setStatus('t-2', 'complete', THREAD)
    expect(await store.listRunning!(THREAD)).toEqual(['t-1'])
    // A scope with no history reports none.
    expect(await store.listRunning!('th-empty')).toEqual([])
  })
})

describe('TurnStreamDO product endpoint seam', () => {
  class ProductDO extends TurnStreamDO {
    protected override async handleProductRequest(request: Request, url: URL): Promise<Response | null> {
      if (url.pathname === '/vault/ping' && request.method === 'POST') {
        return Response.json({ pong: true })
      }
      return null
    }
  }

  it('routes unknown paths to the subclass; base endpoints stay owned by the base', async () => {
    const h = createMemoryTurnStreamHarness((state) => new ProductDO(state))
    const stub = h.namespace.get(h.namespace.idFromName('ws:th'))

    const product = await stub.fetch('https://turn-stream.internal/vault/ping', { method: 'POST', body: '{}' })
    expect(await product.json()).toEqual({ pong: true })

    const unknown = await stub.fetch('https://turn-stream.internal/nope', { method: 'POST', body: '{}' })
    expect(unknown.status).toBe(404)

    const base = await stub.fetch(`https://turn-stream.internal${TURN_STREAM_PATHS.turnStatusGet}`, {
      method: 'POST',
      body: '{}',
    })
    expect(base.status).toBe(200)
  })
})

describe('fixture parity with the reference consumer wire shapes', () => {
  // Lifted from gtm-agent session-broadcast.ts: the exact bodies its worker
  // sends today. The shared DO must accept them unchanged so adoption is a
  // binding swap, not a protocol migration.
  it('accepts the reference acquire/release/interrupted bodies', async () => {
    const { namespace } = harness()
    const stub = namespace.get(namespace.idFromName('ws-1:th-1'))

    const acquire = await stub.fetch('https://session-stream.internal/chat-turn-lock/acquire', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        threadId: 'th-1',
        executionId: 'exec-9',
        scope: 'thread',
        turnId: 'turn-9',
        lockId: 'lock-9',
      }),
    })
    expect(acquire.status).toBe(200)
    const acquireBody = (await acquire.json()) as { acquired: boolean; lock: { lockId: string } }
    expect(acquireBody.acquired).toBe(true)
    expect(acquireBody.lock.lockId).toBe('lock-9')

    const release = await stub.fetch('https://session-stream.internal/chat-turn-lock/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        threadId: 'th-1',
        scope: 'thread',
        executionId: 'exec-9',
        lockId: 'lock-9',
      }),
    })
    expect(release.status).toBe(200)
    expect(((await release.json()) as { released: boolean }).released).toBe(true)

    const interrupted = await stub.fetch('https://session-stream.internal/chat-turn-lock/release-interrupted', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: 'th-1', interruptedAt: Date.now(), turnId: 'turn-9' }),
    })
    expect(interrupted.status).toBe(200)
  })

  it('accepts the reference broadcast envelope (type/timestamp/data with sessionId + executionId)', async () => {
    const h = harness()
    const stub = h.namespace.get(h.namespace.idFromName('ws-1:th-1'))
    const response = await stub.fetch('https://session-stream.internal/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'session.run.started',
        timestamp: Date.now(),
        data: { workspaceId: 'ws-1', threadId: 'th-1', sessionId: 'th-1', executionId: 'exec-9' },
      }),
    })
    expect(response.status).toBe(200)
    const viewer = await h.channel('ws-1:th-1').connect({ sessionId: 'th-1', scope: 'thread' })
    expect(viewer.frames).toHaveLength(1)
    expect(JSON.parse(viewer.frames[0]!)).toMatchObject({ type: 'session.run.started', seq: 1 })
  })
})

describe('structural DO state (no Cloudflare types needed)', () => {
  it('constructs against a hand-rolled state object', async () => {
    const storage = new Map<string, unknown>()
    const state: TurnStreamDOState = {
      storage: {
        async get<T>(key: string) {
          return storage.get(key) as T | undefined
        },
        async put(key, value) {
          storage.set(key, value)
        },
        async delete(key) {
          return storage.delete(key)
        },
        async list<T>({ prefix, start }: { prefix: string; start?: string }) {
          const keys = [...storage.keys()].filter((k) => k.startsWith(prefix) && (!start || k >= start)).sort()
          return new Map(keys.map((k) => [k, storage.get(k) as T]))
        },
      },
      acceptWebSocket: () => {},
      getWebSockets: () => [],
    }
    const doInstance = new TurnStreamDO(state)
    const response = await doInstance.fetch(
      new Request(`https://turn-stream.internal${TURN_STREAM_PATHS.turnStatusGet}`, { method: 'POST', body: '{}' }),
    )
    expect(((await response.json()) as { status: unknown }).status).toBeNull()
  })
})
