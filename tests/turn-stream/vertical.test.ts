/**
 * Composition proof for issue #221's acceptance criteria: the shared
 * DO-backed adapters plugged into the REAL `createChatTurnRoutes` assembly.
 *
 *   1. Reconnect-replay — a turn buffered through the DO turnStore is
 *      replayable from a cursor after the client drops, and a live WS viewer
 *      on the thread channel receives the fanout.
 *   2. Stale-lock recovery — a dead holder's lock 409s a second turn; the
 *      reconcile pass (unreachable sandbox past grace) force-releases with
 *      the successor fence, and the retried acquire wins.
 */

import { describe, expect, it } from 'vitest'

import {
  createChatTurnRoutes,
  type ChatTurnMessageStore,
  type ChatTurnRouteProducer,
} from '../../src/chat-routes/index'
import {
  broadcastTurnStreamEvent,
  createDurableObjectTurnEventStore,
  createDurableTurnLock,
  createMemoryTurnStreamHarness,
  reconcileStaleDurableTurnLock,
  threadChannelKey,
} from '../../src/turn-stream/index'
import type { ChatMessagePart } from '../../src/chat-store/parts'

const WS = 'ws-1'
const THREAD = 'th-1'

function memoryMessageStore(): { store: ChatTurnMessageStore; rows: Array<{ role: string; content: string }> } {
  const rows: Array<{ id: string; threadId: string; role: 'user' | 'assistant' | 'system' | 'tool'; content: string; parts?: ChatMessagePart[] }> = []
  let nextId = 1
  return {
    rows,
    store: {
      async listMessages(threadId) {
        return rows.filter((row) => row.threadId === threadId)
      },
      async appendMessage(input) {
        const row = { id: `m${nextId++}`, ...input }
        rows.push(row as (typeof rows)[number])
        return row
      },
    },
  }
}

function turnRequest(body: Record<string, unknown>): Request {
  return new Request('http://app.test/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function readLines(body: ReadableStream<Uint8Array>): Promise<Array<Record<string, unknown>>> {
  const text = await new Response(body).text()
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function producerOf(events: Array<{ type: string; data?: Record<string, unknown> }>, finalText: string): ChatTurnRouteProducer {
  return {
    stream: (async function* () {
      for (const event of events) yield event
    })(),
    finalText: () => finalText,
  }
}

describe('turn-stream × createChatTurnRoutes', () => {
  it('reconnect-replay: DO turnStore buffers the turn, replay serves the tail, WS viewer gets live fanout', async () => {
    const harness = createMemoryTurnStreamHarness()
    const { store } = memoryMessageStore()
    const pending: Promise<unknown>[] = []

    const routes = createChatTurnRoutes({
      projectId: 'test-app',
      authorize: async () => ({ ok: true, tenantId: WS, userId: 'u-1', context: undefined }),
      store,
      turnStore: createDurableObjectTurnEventStore(harness.namespace),
      produce: ({ executionId }) =>
        producerOf(
          [
            { type: 'session.run.started', data: { executionId } },
            { type: 'text', data: { text: 'hello' } },
            { type: 'text', data: { text: ' world' } },
            { type: 'session.run.completed', data: { executionId } },
          ],
          'hello world',
        ),
      // The product's broadcast wiring — same contract the reference consumer
      // runs in its onEvent.
      onEvent: async (event, _context) => {
        await broadcastTurnStreamEvent(harness.namespace, {
          workspaceId: WS,
          threadId: THREAD,
          executionId: 'exec-under-test',
          event,
        })
      },
      replay: { pollMs: 5, timeoutMs: 2000 },
    })

    // A viewer connected mid-turn (before the turn starts here — equivalent).
    const viewer = await harness
      .channel(threadChannelKey(WS, THREAD))
      .connect({ sessionId: THREAD, scope: 'thread' })

    const response = await routes.turn(turnRequest({ threadId: THREAD, content: 'hi' }), {
      waitUntil: (p) => void pending.push(p),
    })
    expect(response.status).toBe(200)
    const lines = await readLines(response.body!)
    const turnMarker = lines[0] as { type: string; turnId: string }
    expect(turnMarker.type).toBe('turn')
    await Promise.all(pending)

    // Live fanout reached the WS viewer (seq-stamped, in order). The engine
    // frames the producer's run markers with its own lifecycle envelope, so
    // started/completed appear once from each — assert order + content, not
    // exact multiplicity.
    const viewerTypes = viewer.frames.map((f) => (JSON.parse(f) as { type: string }).type)
    expect(viewerTypes[0]).toBe('session.run.started')
    expect(viewerTypes.filter((t) => t === 'text')).toHaveLength(2)
    expect(viewerTypes[viewerTypes.length - 1]).toBe('session.run.completed')

    // The dropped client replays the buffered tail from its cursor.
    const replay = await routes.replay(
      new Request(`http://app.test/api/chat/replay/${turnMarker.turnId}?fromSeq=0`),
      { turnId: turnMarker.turnId },
    )
    expect(replay.status).toBe(200)
    const replayed = await readLines(replay.body!)
    const texts = replayed.filter((line) => line.type === 'text')
    expect(texts.length).toBeGreaterThan(0)
    const concat = texts.map((line) => (line as { text?: string; data?: { text?: string } }).text ?? (line.data as { text?: string } | undefined)?.text ?? '').join('')
    expect(concat).toBe('hello world')
    expect(replayed[replayed.length - 1]).toMatchObject({ type: 'turn_status', status: 'complete' })

    // Reconnect discovery: the finished turn no longer lists as running.
    const running = await routes.running(new Request(`http://app.test/api/chat/running?threadId=${THREAD}`))
    expect(await running.json()).toEqual({ running: [] })
  })

  it('stale-lock recovery: dead holder 409s the next turn until reconcile force-releases past grace', async () => {
    const harness = createMemoryTurnStreamHarness()
    const { store } = memoryMessageStore()
    const pending: Promise<unknown>[] = []

    // Sandbox probe verdict, controlled per phase of the test.
    let sandboxStatus: 'running' | 'absent' = 'running'
    let sessionTerminal = false

    const turnLock = createDurableTurnLock({
      namespace: harness.namespace,
      scopeOf: () => 'workspace',
      reconcile: async (args, active) =>
        reconcileStaleDurableTurnLock({
          namespace: harness.namespace,
          workspaceId: args.identity.tenantId,
          threadId: active.threadId,
          active,
          probeSandbox: async () => ({ status: sandboxStatus }),
          probeSession: async () => ({ reachable: true, terminal: sessionTerminal }),
          log: () => {},
        }),
    })

    const routes = createChatTurnRoutes({
      projectId: 'test-app',
      authorize: async () => ({ ok: true, tenantId: WS, userId: 'u-1', context: undefined }),
      store,
      turnStore: createDurableObjectTurnEventStore(harness.namespace),
      turnLock,
      produce: () => producerOf([{ type: 'text', data: { text: 'ok' } }], 'ok'),
    })

    // A dead turn's lock: acquired directly (as if its worker crashed), old
    // enough to clear every grace window.
    const wedgedStart = Date.now() - 10 * 60 * 1000
    const doChannel = harness.namespace.get(harness.namespace.idFromName(WS))
    await doChannel.fetch('https://turn-stream.internal/chat-turn-lock/acquire', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: WS,
        threadId: THREAD,
        scope: 'workspace',
        executionId: 'exec-dead',
        lockId: 'lock-dead',
      }),
    })
    // Backdate it so the grace-period rules see a genuinely old lock.
    const backdated = await (async () => {
      const channel = harness.channel(WS)
      const state = (channel.instance as unknown as { state: { storage: { get<T>(k: string): Promise<T | undefined>; put(k: string, v: unknown): Promise<void> } } }).state
      const lock = await state.storage.get<Record<string, unknown>>('chatTurnLock')
      await state.storage.put('chatTurnLock', { ...lock, startedAt: wedgedStart })
      return true
    })()
    expect(backdated).toBe(true)

    // Phase 1: the execution is LIVE → the lock holds, the turn 409s.
    sandboxStatus = 'running'
    sessionTerminal = false
    const refused = await routes.turn(turnRequest({ threadId: THREAD, content: 'hi' }), {
      waitUntil: (p) => void pending.push(p),
    })
    expect(refused.status).toBe(409)
    const refusedBody = (await refused.json()) as { error: { code: string; executionId: string } }
    expect(refusedBody.error.code).toBe('workspace_turn_in_flight')
    expect(refusedBody.error.executionId).toBe('exec-dead')

    // Phase 2: the box is gone → unreachable fallback releases past grace, the
    // retried acquire wins and the turn streams.
    sandboxStatus = 'absent'
    const recovered = await routes.turn(turnRequest({ threadId: THREAD, content: 'hi again' }), {
      waitUntil: (p) => void pending.push(p),
    })
    expect(recovered.status).toBe(200)
    const lines = await readLines(recovered.body!)
    expect(lines.some((line) => line.type === 'text')).toBe(true)
    await Promise.all(pending)

    // The recovered turn released its own lock on settle: a third turn acquires.
    const third = await routes.turn(turnRequest({ threadId: THREAD, content: 'once more' }), {
      waitUntil: (p) => void pending.push(p),
    })
    expect(third.status).toBe(200)
    await readLines(third.body!)
    await Promise.all(pending)
  })

  it('single-flight in the live path: a concurrent second turn 409s while the first streams', async () => {
    const harness = createMemoryTurnStreamHarness()
    const { store } = memoryMessageStore()
    const pending: Promise<unknown>[] = []

    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const routes = createChatTurnRoutes({
      projectId: 'test-app',
      authorize: async () => ({ ok: true, tenantId: WS, userId: 'u-1', context: undefined }),
      store,
      turnStore: createDurableObjectTurnEventStore(harness.namespace),
      turnLock: createDurableTurnLock({ namespace: harness.namespace, scopeOf: () => 'thread' }),
      produce: () => ({
        stream: (async function* () {
          yield { type: 'text', data: { text: 'streaming' } }
          await firstGate
        })(),
        finalText: () => 'streaming',
      }),
    })

    const first = await routes.turn(turnRequest({ threadId: THREAD, content: 'one' }), {
      waitUntil: (p) => void pending.push(p),
    })
    expect(first.status).toBe(200)

    const second = await routes.turn(turnRequest({ threadId: THREAD, content: 'two' }), {
      waitUntil: (p) => void pending.push(p),
    })
    expect(second.status).toBe(409)

    releaseFirst()
    await readLines(first.body!)
    await Promise.all(pending)

    const third = await routes.turn(turnRequest({ threadId: THREAD, content: 'three' }), {
      waitUntil: (p) => void pending.push(p),
    })
    expect(third.status).toBe(200)
    await readLines(third.body!)
    await Promise.all(pending)
  })
})
