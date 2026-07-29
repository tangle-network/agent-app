import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import {
  coalesceDeltas,
  coalesceChatStreamEvents,
  pumpBufferedTurn,
  createBufferedTurnTap,
  createD1TurnEventStore,
  replayTurnEvents,
  createMemoryTurnEventStore,
  stampReplaySeq,
  TURN_EVENTS_MIGRATION_SQL,
  type D1LikeForTurns,
  type TurnEventStoreOptions,
} from '../src/stream/turn-buffer'

function d1TurnStore(options: TurnEventStoreOptions = {}) {
  const sqlite = new DatabaseSync(':memory:')
  type Prepared = ReturnType<D1LikeForTurns['prepare']>
  type Bound = ReturnType<Prepared['bind']>
  const prepared = (query: string, bound: unknown[] = []): Prepared & Bound => ({
    bind(...values: unknown[]) {
      return prepared(query, values)
    },
    async run() {
      return sqlite.prepare(query).run(...(bound as never[]))
    },
    async all<T = Record<string, unknown>>() {
      return { results: sqlite.prepare(query).all(...(bound as never[])) as T[] }
    },
    async first<T = Record<string, unknown>>() {
      return (sqlite.prepare(query).get(...(bound as never[])) as T | undefined) ?? null
    },
  })
  sqlite.exec(TURN_EVENTS_MIGRATION_SQL)
  return {
    store: createD1TurnEventStore({ prepare: (query) => prepared(query) }, options),
    close: () => sqlite.close(),
  }
}

function text(t: string) {
  return { kind: 'event', event: { type: 'text', text: t } }
}
function reasoning(t: string) {
  return { kind: 'event', event: { type: 'reasoning', text: t } }
}

async function* gen(events: unknown[], opts?: { failAfter?: number }) {
  let i = 0
  for (const e of events) {
    if (opts?.failAfter != null && i++ >= opts.failAfter) throw new Error('model died')
    yield e
  }
}

async function collect<T>(it: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of it) out.push(v)
  return out
}

describe('coalesceDeltas', () => {
  it('merges consecutive same-type deltas, preserving concatenation', () => {
    const out = coalesceDeltas([text('a'), text('b'), reasoning('x'), reasoning('y'), text('c')])
    expect(out).toHaveLength(3)
    expect((out[0] as any).event.text).toBe('ab')
    expect((out[1] as any).event.text).toBe('xy')
    expect((out[2] as any).event.text).toBe('c')
  })

  it('leaves non-delta events alone and does not merge across them', () => {
    const toolCall = { kind: 'event', event: { type: 'tool_call', call: { toolName: 'x', args: {} } } }
    const out = coalesceDeltas([text('a'), toolCall, text('b')])
    expect(out).toHaveLength(3)
  })
})

// ── #42: ChatStreamEvent coalescer + the pluggable coalesce seam ────────────

function partUpdate(id: string, delta: string, cumulative: string) {
  return { type: 'message.part.updated', data: { part: { id, type: 'text', text: cumulative }, delta } }
}

describe('coalesceChatStreamEvents', () => {
  it('merges consecutive deltas for the same part, summing delta and keeping the latest cumulative part', () => {
    const out = coalesceChatStreamEvents([
      partUpdate('p1', 'Hel', 'Hel'),
      partUpdate('p1', 'lo', 'Hello'),
      partUpdate('p1', '!', 'Hello!'),
    ])
    expect(out).toHaveLength(1)
    const data = (out[0] as any).data
    expect(data.delta).toBe('Hello!') // append-consumers reconstruct the full text
    expect(data.part.text).toBe('Hello!') // cumulative-consumers see the latest part
  })

  it('does not merge across different part ids', () => {
    const out = coalesceChatStreamEvents([
      partUpdate('p1', 'a', 'a'),
      partUpdate('p2', 'b', 'b'),
      partUpdate('p2', 'c', 'bc'),
    ])
    expect(out).toHaveLength(2)
    expect((out[1] as any).data.delta).toBe('bc')
  })

  it('leaves unrecognized shapes untouched (no silent drop)', () => {
    const other = { type: 'message.completed', data: {} }
    const out = coalesceChatStreamEvents([partUpdate('p1', 'a', 'a'), other, partUpdate('p1', 'b', 'b')])
    expect(out).toHaveLength(3)
  })
})

describe('pumpBufferedTurn — pluggable coalesce + scope discovery', () => {
  it('uses the supplied coalescer so ChatStreamEvent deltas persist as one row, not per-token', async () => {
    const store = createMemoryTurnEventStore()
    await pumpBufferedTurn({
      source: gen([partUpdate('p1', 'Hel', 'Hel'), partUpdate('p1', 'lo', 'Hello')]),
      store,
      turnId: 'c1',
      // Wide window so both deltas accumulate and the final flush coalesces them
      // (flushIntervalMs:0 would flush each event alone — no batch to coalesce).
      flushIntervalMs: 10_000,
      coalesce: coalesceChatStreamEvents,
    })
    const rows = await store.read('c1', 0)
    expect(rows).toHaveLength(1) // would be 2 with the default tool-loop coalescer
    expect(JSON.parse(rows[0]!.event).data.delta).toBe('Hello')
  })

  it('listRunning finds an in-flight turn by scope and drops it once complete', async () => {
    const store = createMemoryTurnEventStore()
    await store.setStatus('a', 'running', 'thread-9')
    await store.setStatus('b', 'running', 'thread-9')
    await store.setStatus('c', 'running', 'thread-other')
    expect(await store.listRunning!('thread-9')).toEqual(['b', 'a']) // newest first
    await store.setStatus('a', 'complete')
    expect(await store.listRunning!('thread-9')).toEqual(['b'])
  })

  it('expires an abandoned running lease without hiding a concurrent live turn', async () => {
    let now = 0
    const options = { runningTurnLeaseMs: 100, now: () => now }
    const memory = createMemoryTurnEventStore(options)
    const d1 = d1TurnStore(options)

    try {
      const results: Record<string, string[]> = {}
      for (const [name, store] of [
        ['memory', memory],
        ['d1', d1.store],
      ] as const) {
        now = 0
        await store.setStatus('older-live-turn', 'running', 'thread-9')
        now = 10
        await store.setStatus('later-turn', 'running', 'thread-9')
        now = 20
        await store.setStatus('later-turn', 'complete', 'thread-9')
        results[name] = await store.listRunning!('thread-9')
      }
      expect(results).toEqual({ memory: ['older-live-turn'], d1: ['older-live-turn'] })

      now = 101
      expect(await memory.listRunning!('thread-9')).toEqual([])
      expect(await d1.store.listRunning!('thread-9')).toEqual([])
    } finally {
      d1.close()
    }
  })

  it('records the pump scopeId so a reloaded client can rediscover the turn', async () => {
    const store = createMemoryTurnEventStore()
    await pumpBufferedTurn({ source: gen([text('x')]), store, turnId: 'd1', flushIntervalMs: 0, scopeId: 'sess-1' })
    // turn finished, so it is no longer "running"
    expect(await store.listRunning!('sess-1')).toEqual([])
    expect(await store.getStatus('d1')).toBe('complete')
  })
})

describe('pumpBufferedTurn + replayTurnEvents', () => {
  it('buffers the full turn and marks complete; replay reproduces the text', async () => {
    const store = createMemoryTurnEventStore()
    await pumpBufferedTurn({
      source: gen([text('Hel'), text('lo'), { kind: 'tool_result', label: 't', outcome: { ok: true } }, text('!')]),
      store,
      turnId: 't1',
      flushIntervalMs: 0,
    })
    expect(await store.getStatus('t1')).toBe('complete')

    const rows = await collect(replayTurnEvents({ store, turnId: 't1', pollMs: 1 }))
    const events = rows.filter((r) => r.seq > 0).map((r) => JSON.parse(r.event))
    const textOut = events
      .filter((e) => e.kind === 'event' && e.event.type === 'text')
      .map((e) => e.event.text)
      .join('')
    expect(textOut).toBe('Hello!')
    expect(rows[rows.length - 1]).toEqual({ seq: -1, event: JSON.stringify({ type: 'turn_status', status: 'complete' }) })
  })

  it('keeps buffering after the live client write starts failing', async () => {
    const store = createMemoryTurnEventStore()
    let writes = 0
    await pumpBufferedTurn({
      source: gen([text('a'), text('b'), text('c'), text('d')]),
      store,
      turnId: 't2',
      flushIntervalMs: 0,
      write: () => {
        writes++
        if (writes > 1) throw new Error('client disconnected')
      },
    })
    expect(await store.getStatus('t2')).toBe('complete')
    const rows = await store.read('t2', 0)
    const all = rows.map((r) => JSON.parse(r.event).event.text).join('')
    expect(all).toBe('abcd') // nothing lost after the disconnect at write #2
  })

  it('resumes strictly after fromSeq', async () => {
    const store = createMemoryTurnEventStore()
    // Disable coalescing effects by interleaving types so each event keeps its own seq
    await pumpBufferedTurn({
      source: gen([text('one'), reasoning('r'), text('two'), reasoning('s'), text('three')]),
      store,
      turnId: 't3',
      flushIntervalMs: 0,
    })
    const all = await collect(replayTurnEvents({ store, turnId: 't3', pollMs: 1 }))
    const dataRows = all.filter((r) => r.seq > 0)
    const resumeFrom = dataRows[1]!.seq
    const tail = await collect(replayTurnEvents({ store, turnId: 't3', fromSeq: resumeFrom, pollMs: 1 }))
    expect(tail.filter((r) => r.seq > 0).map((r) => r.seq)).toEqual(dataRows.slice(2).map((r) => r.seq))
  })

  it('follows a still-running turn until it completes', async () => {
    const store = createMemoryTurnEventStore()
    await store.setStatus('t4', 'running')
    await store.append('t4', [{ seq: 1, event: JSON.stringify(text('partial')) }])

    const follower = collect(replayTurnEvents({ store, turnId: 't4', pollMs: 5, timeoutMs: 2_000 }))
    // Simulate the pump finishing concurrently
    setTimeout(async () => {
      await store.append('t4', [{ seq: 2, event: JSON.stringify(text(' done')) }])
      await store.setStatus('t4', 'complete')
    }, 25)

    const rows = await follower
    const texts = rows.filter((r) => r.seq > 0).map((r) => JSON.parse(r.event).event.text)
    expect(texts.join('')).toBe('partial done')
    expect(JSON.parse(rows[rows.length - 1]!.event)).toEqual({ type: 'turn_status', status: 'complete' })
  })

  it('a source error flushes what was produced and marks the turn error', async () => {
    const store = createMemoryTurnEventStore()
    await expect(
      pumpBufferedTurn({
        source: gen([text('partial '), text('output'), text('never')], { failAfter: 2 }),
        store,
        turnId: 't5',
        flushIntervalMs: 0,
      }),
    ).rejects.toThrow('model died')
    expect(await store.getStatus('t5')).toBe('error')
    const rows = await store.read('t5', 0)
    expect(rows.length).toBeGreaterThan(0)
  })
})

// ── #42: the push-driven tap (handleChatTurn hooks.onEvent path) ────────────

describe('createBufferedTurnTap', () => {
  it('buffers pushed events and completes via done(); replay reproduces the text', async () => {
    const store = createMemoryTurnEventStore()
    // Simulate agent-runtime handleChatTurn: it owns iteration and pushes to a
    // hook. We DON'T own an AsyncIterable here — only the per-event callback.
    const tap = createBufferedTurnTap({ store, turnId: 'k1', flushIntervalMs: 0, scopeId: 'thread-1' })
    async function handleChatTurn(hooks: { onEvent: (e: unknown) => Promise<void> }) {
      for (const t of ['Hel', 'lo', '!']) await hooks.onEvent(text(t))
    }
    try {
      await handleChatTurn({ onEvent: tap.onEvent })
      await tap.done('complete')
    } catch {
      await tap.done('error')
    }
    expect(await store.getStatus('k1')).toBe('complete')
    const rows = await collect(replayTurnEvents({ store, turnId: 'k1', pollMs: 1 }))
    const out = rows
      .filter((r) => r.seq > 0)
      .map((r) => JSON.parse(r.event).event.text)
      .join('')
    expect(out).toBe('Hello!')
  })

  it('marks the turn running on first event so listRunning can find it mid-flight', async () => {
    const store = createMemoryTurnEventStore()
    const tap = createBufferedTurnTap({ store, turnId: 'k2', flushIntervalMs: 10_000, scopeId: 'sess-A' })
    expect(await store.getStatus('k2')).toBeNull() // nothing until first event
    await tap.onEvent(text('mid'))
    expect(await store.getStatus('k2')).toBe('running')
    expect(await store.listRunning!('sess-A')).toEqual(['k2'])
    await tap.done('complete')
    expect(await store.listRunning!('sess-A')).toEqual([])
  })

  it('renews the running lease until the turn settles', async () => {
    vi.useFakeTimers()
    try {
      const base = createMemoryTurnEventStore()
      const setStatus = vi.fn(base.setStatus.bind(base))
      const tap = createBufferedTurnTap({
        store: { ...base, setStatus },
        turnId: 'lease-turn',
        scopeId: 'lease-thread',
        runningTurnRenewIntervalMs: 50,
      })

      await tap.onEvent(text('working'))
      await vi.advanceTimersByTimeAsync(50)
      expect(setStatus.mock.calls.map((call) => call[1])).toEqual(['running', 'running'])

      await tap.done('complete')
      await vi.advanceTimersByTimeAsync(100)
      expect(setStatus.mock.calls.map((call) => call[1])).toEqual(['running', 'running', 'complete'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('done("error") flushes what was produced and marks error', async () => {
    const store = createMemoryTurnEventStore()
    const tap = createBufferedTurnTap({ store, turnId: 'k3', flushIntervalMs: 10_000 })
    await tap.onEvent(text('partial'))
    await tap.done('error')
    expect(await store.getStatus('k3')).toBe('error')
    expect((await store.read('k3', 0)).length).toBeGreaterThan(0)
  })

  it('coalesces ChatStreamEvent deltas pushed through onEvent (no per-token rows)', async () => {
    const store = createMemoryTurnEventStore()
    const tap = createBufferedTurnTap({ store, turnId: 'k4', flushIntervalMs: 10_000, coalesce: coalesceChatStreamEvents })
    await tap.onEvent(partUpdate('p1', 'Hel', 'Hel'))
    await tap.onEvent(partUpdate('p1', 'lo', 'Hello'))
    await tap.done('complete')
    const rows = await store.read('k4', 0)
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]!.event).data.delta).toBe('Hello')
  })
})

describe('stampReplaySeq', () => {
  it('stamps the buffer ordinal onto a replayed line without disturbing it', () => {
    const line = JSON.stringify({ kind: 'event', event: { type: 'text', text: 'hi' } })
    const stamped = stampReplaySeq({ seq: 7, event: line })
    const parsed = JSON.parse(stamped) as Record<string, unknown>
    expect(parsed.seq).toBe(7)
    expect(parsed.kind).toBe('event')
    expect(parsed.event).toEqual({ type: 'text', text: 'hi' })
  })

  it('leaves the turn_status sentinel unstamped — it is a terminator, not a cursor', () => {
    const line = JSON.stringify({ type: 'turn_status', status: 'complete' })
    expect(stampReplaySeq({ seq: -1, event: line })).toBe(line)
  })

  it('handles an empty object payload', () => {
    expect(JSON.parse(stampReplaySeq({ seq: 3, event: '{}' }))).toEqual({ seq: 3 })
  })

  it('passes a non-object line through verbatim rather than corrupting it', () => {
    // Fail-soft: a stamping bug must degrade to today's behaviour, never break
    // a replay.
    expect(stampReplaySeq({ seq: 4, event: '"just a string"' })).toBe('"just a string"')
    expect(stampReplaySeq({ seq: 4, event: 'not json' })).toBe('not json')
  })

  it('round-trips through the real tap + replay path with usable cursors', async () => {
    const store = createMemoryTurnEventStore()
    const tap = createBufferedTurnTap({ store, turnId: 'k-seq', flushIntervalMs: 0 })
    await tap.onEvent(text('a '))
    await tap.onEvent(text('b'))
    await tap.done('complete')

    const wire: Array<Record<string, unknown>> = []
    for await (const row of replayTurnEvents({ store, turnId: 'k-seq' })) {
      wire.push(JSON.parse(stampReplaySeq(row)) as Record<string, unknown>)
    }
    const events = wire.slice(0, -1)
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => typeof e.seq === 'number' && (e.seq as number) > 0)).toBe(true)
    expect(wire.at(-1)).toEqual({ type: 'turn_status', status: 'complete' })

    // Resuming past the last stamped seq yields only the sentinel.
    const last = events.at(-1)!.seq as number
    const resumed: unknown[] = []
    for await (const row of replayTurnEvents({ store, turnId: 'k-seq', fromSeq: last })) {
      resumed.push(JSON.parse(stampReplaySeq(row)))
    }
    expect(resumed).toEqual([{ type: 'turn_status', status: 'complete' }])
  })
})
