import assert from 'node:assert/strict'
import { it } from 'vitest'
import { consumeTurnStream, observeTurnEvent, parseTurnObservation } from '../../src/stream/turn-observation'

const encode = (s: string) => new TextEncoder().encode(s)
async function* chunks(...values: string[]) { for (const value of values) yield encode(value) }
const marker = { type: 'turn', turnId: 'stream-1' }
const observed = () => observeTurnEvent(parseTurnObservation(), marker).checkpoint

it('learns the replay ID independently of the client request ID', () => {
  assert.equal(observed().streamId, 'stream-1')
  assert.equal(observed().lastSeq, 0)
})
it('does not mutate the previously committed checkpoint', () => {
  const before = observed()
  observeTurnEvent(before, { seq: 1, ...marker })
  assert.equal(before.lastSeq, 0)
})
it('ignores repeated ordinals without reapplying output', () => {
  const first = observeTurnEvent(observed(), { seq: 1, ...marker }).checkpoint
  const repeat = observeTurnEvent(first, { seq: 1, ...marker })
  assert.equal(repeat.accepted, false)
  assert.equal(repeat.checkpoint.eventCount, first.eventCount)
})
it('never moves the replay cursor using unsequenced live frames', () => {
  const next = observeTurnEvent(observed(), { type: 'text', text: 'hello' })
  assert.equal(next.checkpoint.lastSeq, 0)
})
it('rejects a missing replay interval', () => {
  assert.throws(() => observeTurnEvent(observed(), { seq: 2, type: 'text' }), /gap/)
})
it('requires identity before advancing a replay ordinal', () => {
  assert.throws(() => observeTurnEvent(parseTurnObservation(), { seq: 1, type: 'text' }), /identity/)
})
it('rejects a changed identity even on an already observed ordinal', () => {
  const state = observeTurnEvent(observed(), { seq: 1, ...marker }).checkpoint
  assert.throws(() => observeTurnEvent(state, { seq: 1, type: 'turn', turnId: 'another' }), /identity changed/)
})
for (const seq of [0, -2, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
  it(`rejects invalid ordinal ${seq}`, () => {
    assert.throws(() => observeTurnEvent(observed(), { type: 'text', seq }))
  })
}
for (const status of ['complete', 'completed']) {
  it(`understands the ${status} terminal protocol`, () => {
    assert.equal(observeTurnEvent(observed(), { type: 'turn_status', status, seq: -1 }).checkpoint.outcome, 'completed')
  })
}
for (const status of ['timeout', 'running', 'unknown']) {
  it(`does not mistake ${status} for completion`, () => {
    const result = observeTurnEvent(observed(), { type: 'turn_status', status })
    assert.equal(result.checkpoint.outcome, null)
    assert.equal(result.checkpoint.lastSeq, 0)
  })
}
for (const status of ['error', 'failed', 'cancelled', 'aborted']) {
  it(`preserves terminal ${status}`, () => {
    const failed = observeTurnEvent(observed(), { type: 'turn_status', status }).checkpoint
    assert.equal(observeTurnEvent(failed, { type: 'session.run.completed' }).checkpoint.outcome, 'failed')
  })
}
it('accepts wrapped native events and the outer replay cursor', () => {
  const update = observeTurnEvent(observed(), { kind: 'event', seq: 1, event: { type: 'session.run.completed' } })
  assert.equal(update.checkpoint.lastSeq, 1)
  assert.equal(update.checkpoint.outcome, 'completed')
})
it('allows sentinel -1 only for turn status', () => {
  assert.throws(() => observeTurnEvent(observed(), { seq: -1, type: 'text' }), /sentinel/)
})
for (const raw of [null, [], {}, { type: 4 }, { kind: 'event', event: null }, { type: 'turn', turnId: '../other' }]) {
  it('rejects malformed events', () => assert.throws(() => observeTurnEvent(observed(), raw)))
}
it('commits each frame before consuming the next', async () => {
  const calls: string[] = []
  const result = await consumeTurnStream(chunks(`${JSON.stringify(marker)}\n`, '{"type":"session.run.completed"}\n'), {
    commit: async update => { calls.push(update.event.type as string) },
  })
  assert.deepEqual(calls, ['turn', 'session.run.completed'])
  assert.equal(result.outcome, 'completed')
})
it('retains incomplete state when the socket ends without a terminal event', async () => {
  const result = await consumeTurnStream(chunks(`${JSON.stringify(marker)}\n`, '{"type":"text","text":"still working"}\n'), { commit: async () => {} })
  assert.equal(result.outcome, null)
})
it('resumes after a lost stream using only committed sequenced state', async () => {
  let saved = parseTurnObservation()
  const commit = async (update: ReturnType<typeof observeTurnEvent>) => { saved = update.checkpoint }
  async function* lost() {
    yield encode(JSON.stringify({ ...marker, seq: 1 }) + '\n')
    yield encode('{"seq":2,"type":"text","text":"first"}\n')
    throw new Error('network dropped')
  }
  await assert.rejects(consumeTurnStream(lost(), { commit }), /network dropped/)
  assert.equal(saved.lastSeq, 2)
  const result = await consumeTurnStream(chunks('{"seq":2,"type":"text","text":"first"}\n', '{"seq":3,"type":"session.run.completed"}\n'), { checkpoint: saved, commit })
  assert.equal(result.lastSeq, 3)
  assert.equal(result.eventCount, 3)
  assert.equal(result.outcome, 'completed')
})
it('does not acknowledge evidence whose durable commit failed', async () => {
  const state = observed()
  await assert.rejects(consumeTurnStream(chunks('{"seq":1,"type":"text"}\n'), {
    checkpoint: state, commit: async () => { throw new Error('disk full') },
  }), /disk full/)
  assert.equal(state.lastSeq, 0)
})
it('handles UTF-8 split at every byte, CRLF and a final line without newline', async () => {
  const wire = encode(JSON.stringify(marker) + '\r\n' + JSON.stringify({ type: 'text', text: 'café 🌊' }))
  async function* bytes() { for (const byte of wire) yield new Uint8Array([byte]) }
  const values: string[] = []
  await consumeTurnStream(bytes(), { commit: async update => { if (update.event.text) values.push(String(update.event.text)) } })
  assert.deepEqual(values, ['café 🌊'])
})
it('bounds one unterminated frame rather than the entire run', async () => {
  await assert.rejects(consumeTurnStream(chunks('x'.repeat(40), 'x'.repeat(40)), { maxFrameBytes: 64, commit: async () => {} }), /byte limit/)
  const result = await consumeTurnStream(chunks(Array(100).fill('{"type":"text"}\n').join('')), { maxFrameBytes: 32, commit: async () => {} })
  assert.equal(result.eventCount, 100)
})
it('rejects malformed UTF-8 and a truncated final event', async () => {
  async function* bad() { yield new Uint8Array([0xff]) }
  await assert.rejects(consumeTurnStream(bad(), { commit: async () => {} }))
  await assert.rejects(consumeTurnStream(chunks('{"type":'), { commit: async () => {} }))
})
for (const value of [null, {}, { ...observed(), lastSeq: -1 }, { ...observed(), outcome: 'done' }, { ...observed(), streamId: null, lastSeq: 1 }]) {
  it('validates checkpoints read from durable storage', () => assert.throws(() => parseTurnObservation(value)))
}
