import { describe, expect, it, vi } from 'vitest'

import {
  acquireDurableTurnLock,
  broadcastThreadCreated,
  broadcastWorkspaceActivity,
  createDurableObjectTurnEventStore,
  releaseDurableTurnLock,
  releaseInterruptedDurableTurnLock,
  type TurnStreamAuth,
} from '../../src/turn-stream/adapters'
import {
  threadChannelKey,
  workspaceChannelKey,
  mintTurnStreamToken,
  TURN_STREAM_PATHS,
  TURN_STREAM_TOKEN_HEADER,
  verifyTurnStreamToken,
} from '../../src/turn-stream/core'
import { TurnStreamDO, type TurnStreamDOState } from '../../src/turn-stream/do'
import { MEMORY_TURN_STREAM_AUTH_SECRET, createMemoryTurnStreamHarness } from '../../src/turn-stream/memory'

const WS = 'ws-1'
const THREAD = 'th-1'
const AUTH: TurnStreamAuth = { secret: MEMORY_TURN_STREAM_AUTH_SECRET }

function harness() {
  return createMemoryTurnStreamHarness()
}

describe('capability-token gate (issue #746)', () => {
  it('refuses an unauthenticated request with 401', async () => {
    const h = harness()
    const stub = h.namespace.get(h.namespace.idFromName('ws-1:th-1'))
    const response = await stub.fetch(`https://turn-stream.internal${TURN_STREAM_PATHS.turnStatusGet}`, {
      method: 'POST',
      body: '{}',
    })
    expect(response.status).toBe(401)
  })

  it('refuses a token minted for a DIFFERENT channel (cross-channel replay)', async () => {
    const h = harness()
    const stub = h.namespace.get(h.namespace.idFromName('ws-1:th-1'))
    const foreign = await mintTurnStreamToken('ws-1:th-other', AUTH.secret)
    const response = await stub.fetch(`https://turn-stream.internal${TURN_STREAM_PATHS.turnStatusGet}`, {
      method: 'POST',
      headers: { [TURN_STREAM_TOKEN_HEADER]: foreign },
      body: '{}',
    })
    expect(response.status).toBe(401)
  })

  it('refuses a garbage / tampered token', async () => {
    const h = harness()
    const stub = h.namespace.get(h.namespace.idFromName('ws-1:th-1'))
    for (const token of ['', 'v1.ws-1:th-1.zz.notamc', 'garbage', 'v1..9999.abc']) {
      const response = await stub.fetch(`https://turn-stream.internal${TURN_STREAM_PATHS.turnStatusGet}`, {
        method: 'POST',
        headers: { [TURN_STREAM_TOKEN_HEADER]: token },
        body: '{}',
      })
      expect(response.status).toBe(401)
    }
  })

  it('refuses an expired token', async () => {
    const expired = await mintTurnStreamToken('ws-1:th-1', AUTH.secret, () => Date.now() - 1000, 10)
    const h = harness()
    const stub = h.namespace.get(h.namespace.idFromName('ws-1:th-1'))
    const response = await stub.fetch(`https://turn-stream.internal${TURN_STREAM_PATHS.turnStatusGet}`, {
      method: 'POST',
      headers: { [TURN_STREAM_TOKEN_HEADER]: expired },
      body: '{}',
    })
    expect(response.status).toBe(401)
  })

  it('fails closed with 500 when no secret is configured', async () => {
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
      id: { name: 'ws-1:th-1' },
    }
    const response = await new TurnStreamDO(state).fetch(
      new Request(`https://turn-stream.internal${TURN_STREAM_PATHS.turnStatusGet}`, { method: 'POST', body: '{}' }),
    )
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('TURN_STREAM_AUTH_SECRET') })
  })

  it('fails closed with 500 when the DO has no channel name', async () => {
    const state: TurnStreamDOState = {
      storage: {
        async get() {
          return undefined
        },
        async put() {},
        async delete() {
          return false
        },
        async list() {
          return new Map()
        },
      },
      acceptWebSocket: () => {},
      getWebSockets: () => [],
    }
    const response = await new TurnStreamDO(state, undefined, { authSecret: AUTH.secret }).fetch(
      new Request(`https://turn-stream.internal${TURN_STREAM_PATHS.turnStatusGet}`, { method: 'POST', body: '{}' }),
    )
    expect(response.status).toBe(500)
  })

  it('accepts an internal header and refuses credentials passed in the URL', async () => {
    const h = harness()
    const name = 'ws-1:th-1'
    const stub = h.namespace.get(h.namespace.idFromName(name))
    const viaHeader = await stub.fetch(`https://turn-stream.internal${TURN_STREAM_PATHS.turnStatusGet}`, {
      method: 'POST',
      headers: { [TURN_STREAM_TOKEN_HEADER]: await mintTurnStreamToken(name, AUTH.secret) },
      body: '{}',
    })
    expect(viaHeader.status).toBe(200)
    const viaQuery = await stub.fetch(
      `https://turn-stream.internal${TURN_STREAM_PATHS.turnStatusGet}?token=${encodeURIComponent(await mintTurnStreamToken(name, AUTH.secret))}`,
      { method: 'POST', body: '{}' },
    )
    expect(viaQuery.status).toBe(401)
  })

  it('the gate also covers subclass product endpoints (single choke point)', async () => {
    class ProductDO extends TurnStreamDO {
      protected override async handleProductRequest(request: Request, url: URL): Promise<Response | null> {
        if (url.pathname === '/vault/ping' && request.method === 'POST') {
          return Response.json({ pong: true })
        }
        return null
      }
    }
    const h = createMemoryTurnStreamHarness((state, secret) => new ProductDO(state, undefined, { authSecret: secret }))
    const stub = h.namespace.get(h.namespace.idFromName('ws-1:th-1'))

    const unauthenticated = await stub.fetch('https://turn-stream.internal/vault/ping', { method: 'POST', body: '{}' })
    expect(unauthenticated.status).toBe(401)

    const authenticated = await stub.fetch('https://turn-stream.internal/vault/ping', {
      method: 'POST',
      headers: { [TURN_STREAM_TOKEN_HEADER]: await mintTurnStreamToken('ws-1:th-1', AUTH.secret) },
      body: '{}',
    })
    expect(await authenticated.json()).toEqual({ pong: true })
  })

  it.each(['customer.example:thread.2', 'workspace/équipe:東京'])('round-trips the exact channel name %s', async (name) => {
    const token = await mintTurnStreamToken(name, AUTH.secret)
    expect(await verifyTurnStreamToken(name, token, AUTH.secret)).toBe(true)
  })

  it('verifyTurnStreamToken: mint/verify round-trip rejects secret under 32 chars', async () => {
    const token = await mintTurnStreamToken('ch', AUTH.secret)
    await expect(verifyTurnStreamToken('ch', token, AUTH.secret)).resolves.toBe(true)
    await expect(verifyTurnStreamToken('ch', token, 'short')).resolves.toBe(false)
    await expect(mintTurnStreamToken('ch', 'short')).rejects.toThrow(/32 characters/)
  })
})

describe('TurnStreamDO lock endpoints', () => {
  it('single-flight: second acquire on the same channel 409s with the active lock', async () => {
    const { namespace } = harness()
    const first = await acquireDurableTurnLock(
      namespace,
      {
        workspaceId: WS,
        threadId: THREAD,
        scope: 'thread',
        executionId: 'exec-1',
        turnId: 'turn-1',
      },
      AUTH,
    )
    expect(first.acquired).toBe(true)

    const second = await acquireDurableTurnLock(
      namespace,
      {
        workspaceId: WS,
        threadId: 'th-other',
        scope: 'thread',
        executionId: 'exec-2',
      },
      AUTH,
    )
    // Different thread, thread scope → different channel → acquires fine.
    expect(second.acquired).toBe(true)

    const contended = await acquireDurableTurnLock(
      namespace,
      {
        workspaceId: WS,
        threadId: THREAD,
        scope: 'thread',
        executionId: 'exec-3',
      },
      AUTH,
    )
    expect(contended.acquired).toBe(false)
    if (!contended.acquired) {
      expect(contended.active.executionId).toBe('exec-1')
      expect(contended.active.turnId).toBe('turn-1')
    }
  })

  it('workspace scope serializes every thread in the workspace', async () => {
    const { namespace } = harness()
    const first = await acquireDurableTurnLock(
      namespace,
      { workspaceId: WS, threadId: THREAD, scope: 'workspace', executionId: 'exec-1' },
      AUTH,
    )
    expect(first.acquired).toBe(true)
    const other = await acquireDurableTurnLock(
      namespace,
      { workspaceId: WS, threadId: 'th-2', scope: 'workspace', executionId: 'exec-2' },
      AUTH,
    )
    expect(other.acquired).toBe(false)
  })

  it('cooperative release frees the channel; wrong lockId does not', async () => {
    const { namespace } = harness()
    const acquired = await acquireDurableTurnLock(
      namespace,
      { workspaceId: WS, threadId: THREAD, scope: 'thread', executionId: 'exec-1' },
      AUTH,
    )
    if (!acquired.acquired) throw new Error('expected acquire')

    const wrong = await releaseDurableTurnLock(
      namespace,
      {
        workspaceId: WS,
        threadId: THREAD,
        scope: 'thread',
        executionId: 'exec-1',
        lockId: 'not-the-lock',
      },
      AUTH,
    )
    expect(wrong.released).toBe(false)

    const right = await releaseDurableTurnLock(
      namespace,
      {
        workspaceId: WS,
        threadId: THREAD,
        scope: 'thread',
        executionId: 'exec-1',
        lockId: acquired.lock.lockId,
      },
      AUTH,
    )
    expect(right.released).toBe(true)

    const again = await acquireDurableTurnLock(
      namespace,
      { workspaceId: WS, threadId: THREAD, scope: 'thread', executionId: 'exec-2' },
      AUTH,
    )
    expect(again.acquired).toBe(true)
  })

  it('an expired lock is dead: a new acquire succeeds', async () => {
    const h = createMemoryTurnStreamHarness(
      (state, secret) => new TurnStreamDO(state, undefined, { lockTtlMs: 1, authSecret: secret }),
    )
    const first = await acquireDurableTurnLock(
      h.namespace,
      { workspaceId: WS, threadId: THREAD, scope: 'thread', executionId: 'exec-1' },
      AUTH,
    )
    expect(first.acquired).toBe(true)
    await new Promise((r) => setTimeout(r, 5))
    const second = await acquireDurableTurnLock(
      h.namespace,
      { workspaceId: WS, threadId: THREAD, scope: 'thread', executionId: 'exec-2' },
      AUTH,
    )
    expect(second.acquired).toBe(true)
  })

  it('interrupted release honors the successor fence and turn matching', async () => {
    const { namespace } = harness()
    const acquired = await acquireDurableTurnLock(
      namespace,
      { workspaceId: WS, threadId: THREAD, scope: 'thread', executionId: 'exec-1', turnId: 'turn-1' },
      AUTH,
    )
    if (!acquired.acquired) throw new Error('expected acquire')

    // Evidence observed BEFORE the lock started → successor survives.
    const stale = await releaseInterruptedDurableTurnLock(
      namespace,
      { workspaceId: WS, threadId: THREAD, interruptedAt: acquired.lock.startedAt - 1, turnId: 'turn-1' },
      AUTH,
    )
    expect(stale).toBe(false)

    // Wrong turn → refused.
    const wrongTurn = await releaseInterruptedDurableTurnLock(
      namespace,
      { workspaceId: WS, threadId: THREAD, interruptedAt: Date.now() + 1000, turnId: 'turn-2' },
      AUTH,
    )
    expect(wrongTurn).toBe(false)

    // Right turn, evidence after start → released (scope omitted: tries both).
    const released = await releaseInterruptedDurableTurnLock(
      namespace,
      { workspaceId: WS, threadId: THREAD, interruptedAt: Date.now() + 1000, turnId: 'turn-1' },
      AUTH,
    )
    expect(released).toBe(true)
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
    const h = createMemoryTurnStreamHarness((state, secret) => new DeferringDO(state, undefined, { authSecret: secret }))
    const channel = h.channel(threadChannelKey(WS, THREAD))
    const doInstance = channel.instance as DeferringDO
    doInstance.deferring.add('exec-1')

    const acquired = await acquireDurableTurnLock(
      h.namespace,
      { workspaceId: WS, threadId: THREAD, scope: 'thread', executionId: 'exec-1' },
      AUTH,
    )
    if (!acquired.acquired) throw new Error('expected acquire')

    // Cooperative release defers…
    const releasing = await releaseDurableTurnLock(
      h.namespace,
      {
        workspaceId: WS,
        threadId: THREAD,
        scope: 'thread',
        executionId: 'exec-1',
        lockId: acquired.lock.lockId,
      },
      AUTH,
    )
    expect(releasing).toEqual({ released: false, deferred: true })

    // …the channel stays held (even against an interrupted release)…
    const interrupted = await releaseInterruptedDurableTurnLock(
      h.namespace,
      { workspaceId: WS, threadId: THREAD, scope: 'thread', interruptedAt: Date.now() + 1000 },
      AUTH,
    )
    expect(interrupted).toBe(false)
    const blocked = await acquireDurableTurnLock(
      h.namespace,
      { workspaceId: WS, threadId: THREAD, scope: 'thread', executionId: 'exec-2' },
      AUTH,
    )
    expect(blocked.acquired).toBe(false)

    // …until the product task settles.
    expect(await doInstance.settle('exec-1')).toBe(true)
    const after = await acquireDurableTurnLock(
      h.namespace,
      { workspaceId: WS, threadId: THREAD, scope: 'thread', executionId: 'exec-2' },
      AUTH,
    )
    expect(after.acquired).toBe(true)
  })
})

describe('TurnStreamDO viewer channel (workspace signals)', () => {
  it('workspace channel: sync replays the responding set and recent thread.created markers', async () => {
    const h = harness()
    await broadcastWorkspaceActivity(h.namespace, WS, THREAD, 'start', AUTH)
    await broadcastThreadCreated(h.namespace, WS, { threadId: 'th-new', title: 'New thread' }, AUTH)

    const viewer = await h.channel(workspaceChannelKey(WS)).connect({ sessionId: WS, scope: 'workspace' })
    const types = viewer.frames.map((f) => (JSON.parse(f) as { type: string }).type)
    expect(types).toContain('thread.activity')
    expect(types).toContain('thread.created')

    // `end` clears the responding set for late joiners.
    await broadcastWorkspaceActivity(h.namespace, WS, THREAD, 'end', AUTH)
    const later = await h.channel(workspaceChannelKey(WS)).connect({ sessionId: WS, scope: 'workspace' })
    const laterTypes = later.frames.map((f) => (JSON.parse(f) as { type: string }).type)
    expect(laterTypes).not.toContain('thread.activity')
  })

  it('live signals reach synced sockets; a dead socket must not break fanout', async () => {
    const h = harness()
    const channel = h.channel(workspaceChannelKey(WS))
    const socket = await channel.connect({ sessionId: WS, scope: 'workspace' })
    const frames0 = socket.frames.length

    socket.close()
    await broadcastThreadCreated(h.namespace, WS, { threadId: 'th-2', title: 't' }, AUTH)
    expect(socket.frames.length).toBe(frames0)

    const fresh = await channel.connect({ sessionId: WS, scope: 'workspace' })
    expect(fresh.frames.map((f) => (JSON.parse(f) as { type: string }).type)).toContain('thread.created')
  })

  it('a broadcast event for another sessionId is not delivered to this socket', async () => {
    const h = harness()
    const viewer = await h.channel(workspaceChannelKey(WS)).connect({ sessionId: WS, scope: 'workspace' })
    const before = viewer.frames.length
    // A product event addressed to a different session id on the same channel.
    const stub = h.namespace.get(h.namespace.idFromName(workspaceChannelKey(WS)))
    await stub.fetch(`https://turn-stream.internal${TURN_STREAM_PATHS.broadcast}`, {
      method: 'POST',
      headers: { [TURN_STREAM_TOKEN_HEADER]: await mintTurnStreamToken(workspaceChannelKey(WS), AUTH.secret) },
      body: JSON.stringify({
        type: 'product.custom',
        timestamp: Date.now(),
        data: { sessionId: 'someone-else', payload: 1 },
      }),
    })
    expect(viewer.frames.length).toBe(before)
  })
})

describe('TurnStreamDO turn-event storage (TurnEventStore contract)', () => {
  it('append/read/status round-trip with fromSeq cursor', async () => {
    const { namespace } = harness()
    const store = createDurableObjectTurnEventStore(namespace, AUTH)

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
    const store = createDurableObjectTurnEventStore(namespace, AUTH)

    await store.setStatus('t-1', 'running', THREAD)
    await new Promise((r) => setTimeout(r, 2))
    await store.setStatus('t-2', 'running', THREAD)
    expect(await store.listRunning!(THREAD)).toEqual(['t-2', 't-1'])

    await store.setStatus('t-2', 'complete', THREAD)
    expect(await store.listRunning!(THREAD)).toEqual(['t-1'])
    // A scope with no history reports none.
    expect(await store.listRunning!('th-empty')).toEqual([])
  })

  it('listRunning expires an unrenewed running lease', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0)
    try {
      const h = createMemoryTurnStreamHarness(
        (state, secret) => new TurnStreamDO(state, undefined, { runningTurnLeaseMs: 100, authSecret: secret }),
      )
      const store = createDurableObjectTurnEventStore(h.namespace, AUTH)
      await store.setStatus('abandoned-turn', 'running', THREAD)
      expect(await store.listRunning!(THREAD)).toEqual(['abandoned-turn'])

      now.mockReturnValue(101)
      expect(await store.listRunning!(THREAD)).toEqual([])
    } finally {
      now.mockRestore()
    }
  })

  it.each(['complete', 'error'] as const)('fences appends after %s through the real adapter and DO', async (status) => {
    const { namespace } = harness()
    const store = createDurableObjectTurnEventStore(namespace, AUTH)

    await store.setStatus(`terminal-${status}`, 'running', THREAD)
    await store.append(`terminal-${status}`, [{ seq: 1, event: 'before' }])
    await store.setStatus(`terminal-${status}`, status, THREAD)
    await store.append(`terminal-${status}`, [{ seq: 2, event: 'too-late' }])

    expect(await store.read(`terminal-${status}`, 0)).toEqual([{ seq: 1, event: 'before' }])
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
    const h = createMemoryTurnStreamHarness((state, secret) => new ProductDO(state, undefined, { authSecret: secret }))
    const stub = h.namespace.get(h.namespace.idFromName('ws:th'))
    const token = await mintTurnStreamToken('ws:th', AUTH.secret)

    const product = await stub.fetch('https://turn-stream.internal/vault/ping', {
      method: 'POST',
      headers: { [TURN_STREAM_TOKEN_HEADER]: token },
      body: '{}',
    })
    expect(await product.json()).toEqual({ pong: true })

    const unknown = await stub.fetch('https://turn-stream.internal/nope', {
      method: 'POST',
      headers: { [TURN_STREAM_TOKEN_HEADER]: token },
      body: '{}',
    })
    expect(unknown.status).toBe(404)

    const base = await stub.fetch(`https://turn-stream.internal${TURN_STREAM_PATHS.turnStatusGet}`, {
      method: 'POST',
      headers: { [TURN_STREAM_TOKEN_HEADER]: token },
      body: '{}',
    })
    expect(base.status).toBe(200)
  })
})

describe('fixture parity with the reference consumer wire shapes', () => {
  // Lifted from gtm-agent session-broadcast.ts: the exact bodies its worker
  // sends. The shared DO must accept them unchanged — adoption is a binding
  // swap plus a capability token, not a protocol migration.
  it('accepts the reference acquire/release/interrupted bodies', async () => {
    const h = harness()
    const name = 'ws-1:th-1'
    const stub = h.namespace.get(h.namespace.idFromName(name))
    const token = () => mintTurnStreamToken(name, AUTH.secret)

    const acquire = await stub.fetch('https://session-stream.internal/chat-turn-lock/acquire', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TURN_STREAM_TOKEN_HEADER]: await token() },
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
      headers: { 'Content-Type': 'application/json', [TURN_STREAM_TOKEN_HEADER]: await token() },
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
      headers: { 'Content-Type': 'application/json', [TURN_STREAM_TOKEN_HEADER]: await token() },
      body: JSON.stringify({ threadId: 'th-1', interruptedAt: Date.now(), turnId: 'turn-9' }),
    })
    expect(interrupted.status).toBe(200)
  })

  it('accepts the reference workspace broadcast envelope (type/timestamp/data)', async () => {
    const h = harness()
    const name = workspaceChannelKey('ws-1')
    const stub = h.namespace.get(h.namespace.idFromName(name))
    const response = await stub.fetch('https://session-stream.internal/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TURN_STREAM_TOKEN_HEADER]: await mintTurnStreamToken(name, AUTH.secret) },
      body: JSON.stringify({
        type: 'thread.updated',
        timestamp: Date.now(),
        data: { workspaceId: 'ws-1', threadId: 'th-1', sessionId: 'ws-1' },
      }),
    })
    expect(response.status).toBe(200)
    const viewer = await h.channel(name).connect({ sessionId: 'ws-1', scope: 'workspace' })
    // Sync replays activity/created markers; the live thread.updated frame was
    // broadcast BEFORE the socket synced, so it is not re-delivered (sync
    // snapshot covers workspace state, not arbitrary prior events).
    expect(viewer.frames.map((f) => (JSON.parse(f) as { type: string }).type)).not.toContain('thread.updated')
  })
})

describe('structural DO state (no Cloudflare types needed)', () => {
  it('constructs against a hand-rolled state object; without a channel name it fails closed', async () => {
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
    const doInstance = new TurnStreamDO(state, undefined, { authSecret: AUTH.secret })
    const response = await doInstance.fetch(
      new Request(`https://turn-stream.internal${TURN_STREAM_PATHS.turnStatusGet}`, { method: 'POST', body: '{}' }),
    )
    expect(response.status).toBe(500)
  })
})
