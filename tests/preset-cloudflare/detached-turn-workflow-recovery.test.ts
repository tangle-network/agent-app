import assert from 'node:assert/strict'
import { it } from 'vitest'
import {
  runDetachedTurnWorkflowTick,
  type CloudflareWorkflowStepLike,
  type DetachedTurnDriveOutcome,
} from '../../src/preset-cloudflare/detached-turn-workflow'

/** A durable step stores only successful callback results, as Workflow replay does. */
function steps() {
  const values = new Map<string, unknown>()
  const sleeps: string[] = []
  const step: CloudflareWorkflowStepLike = {
    async do<T>(name: string, callback: (context: unknown) => Promise<T>): Promise<T> {
      if (values.has(name)) return values.get(name) as T
      const value = await callback({})
      values.set(name, structuredClone(value))
      return value
    },
    async sleep(name) { if (!sleeps.includes(name)) sleeps.push(name) },
  }
  return { step, values, sleeps }
}
const event = () => ({ payload: { sessionId: 'session', turnId: 'turn' } })
const running = { succeeded: true, value: { state: 'running' } } as DetachedTurnDriveOutcome
const failed = { succeeded: true, value: { state: 'failed', error: 'fixture terminal failure' } } as DetachedTurnDriveOutcome

it('does not poison a durable step with a malformed provider response', async () => {
  const state = steps()
  let calls = 0
  const drive = async () => {
    calls++
    return calls === 1 ? { succeeded: true, value: { state: 'invalid' } } as unknown as DetachedTurnDriveOutcome : failed
  }
  const options = { event: event(), step: state.step, drive, settle: async () => 'settled' }
  await assert.rejects(runDetachedTurnWorkflowTick(options), /unknown state/)
  assert.equal(state.values.size, 0)
  assert.equal(await runDetachedTurnWorkflowTick(options), 'settled')
  assert.equal(calls, 2)
})

it('resumes committed passes after the owner process disappears', async () => {
  const state = steps()
  let calls = 0
  const identities: string[] = []
  const options = { event: event(), step: state.step,
    drive: async (payload: { sessionId: string; turnId: string }) => {
      identities.push(`${payload.sessionId}/${payload.turnId}`)
      calls++
      if (calls === 2) throw new Error('owner process disappeared')
      return calls < 4 ? running : failed
    }, settle: async () => 'settled' }
  await assert.rejects(runDetachedTurnWorkflowTick(options), /owner process disappeared/)
  assert.equal(state.values.size, 1)
  assert.equal(await runDetachedTurnWorkflowTick(options), 'settled')
  assert.deepEqual(identities, Array(4).fill('session/turn'))
  assert.deepEqual([...state.values.keys()], ['detached-turn:drive:0', 'detached-turn:drive:1', 'detached-turn:drive:2', 'detached-turn:settle'])
  assert.deepEqual(state.sleeps, ['detached-turn:wait:0', 'detached-turn:wait:1'])
})

it('does not repeat a committed terminal read when settlement retries', async () => {
  const state = steps()
  let reads = 0, writes = 0
  const options = { event: event(), step: state.step,
    drive: async () => { reads++; return failed },
    settle: async () => { writes++; if (writes === 1) throw new Error('settlement unavailable'); return 'settled' } }
  await assert.rejects(runDetachedTurnWorkflowTick(options), /settlement unavailable/)
  assert.equal(await runDetachedTurnWorkflowTick(options), 'settled')
  assert.equal(reads, 1); assert.equal(writes, 2)
  assert.equal(await runDetachedTurnWorkflowTick(options), 'settled')
  assert.equal(reads, 1); assert.equal(writes, 2)
})

it('does not change the stored admission identity when a drive callback mutates its argument', async () => {
  const state = steps(), original = event()
  await assert.rejects(runDetachedTurnWorkflowTick({ event: original, step: state.step,
    drive: async payload => { payload.turnId = 'different'; return failed }, settle: async () => 'unexpected' }), TypeError)
  assert.equal(original.payload.turnId, 'turn')
  assert.equal(state.values.size, 0)
})

it('has no fixed turn-count cliff for a long-running accepted execution', async () => {
  const state = steps()
  let calls = 0
  const result = await runDetachedTurnWorkflowTick({ event: event(), step: state.step,
    drive: async () => ++calls <= 600 ? running : failed, settle: async () => 'settled' })
  assert.equal(result, 'settled'); assert.equal(calls, 601); assert.equal(state.sleeps.length, 600)
})

it('keeps a reported transport failure retryable instead of caching it as completion', async () => {
  const state = steps()
  await assert.rejects(runDetachedTurnWorkflowTick({ event: event(), step: state.step,
    drive: async () => ({ succeeded: false, error: new Error('unavailable') }), settle: async () => 'unexpected' }), /unavailable/)
  assert.equal(state.values.size, 0)
})

it('rejects malformed values already present in an old durable cache', async () => {
  const state = steps()
  state.values.set('detached-turn:drive:0', { state: 'old-invalid-cache' })
  let reads = 0, writes = 0
  await assert.rejects(runDetachedTurnWorkflowTick({ event: event(), step: state.step,
    drive: async () => { reads++; return failed }, settle: async () => { writes++; return 'unexpected' } }), /unknown state/)
  assert.equal(reads, 0); assert.equal(writes, 0)
})
