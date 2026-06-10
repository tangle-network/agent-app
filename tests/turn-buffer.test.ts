import { describe, it, expect } from 'vitest'
import {
  coalesceDeltas,
  pumpBufferedTurn,
  replayTurnEvents,
  createMemoryTurnEventStore,
} from '../src/stream/turn-buffer'

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
