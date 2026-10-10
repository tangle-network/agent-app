import { describe, expect, it, vi } from 'vitest'
import {
  SANDBOX_TRANSIENT_DEADLINE_MS,
  SandboxTransientDeadlineError,
  classifySandboxTransientFailure,
  retrySandboxTransient,
  sandboxTransientBackoffMs,
} from './transient-failure'

const notReady = () => Object.assign(new Error('Sandbox filesystem incarnation is not ready'), {
  name: 'StateError', code: 'FILESYSTEM_INCARNATION_NOT_READY',
})

describe('classifySandboxTransientFailure', () => {
  it('names a not-ready box, a refused dispatch and a control-plane server error', () => {
    expect(classifySandboxTransientFailure(notReady())?.code).toBe('sandbox.filesystem_not_ready')
    expect(classifySandboxTransientFailure(new Error('wrapped', { cause: new Error('Sandbox filesystem incarnation is not ready') }))?.code)
      .toBe('sandbox.filesystem_not_ready')
    expect(classifySandboxTransientFailure(Object.assign(new Error('error code: 503'), {
      status: 503, endpoint: '/v1/sandboxes/box-1/runtime/agents/run/stream', origin: 'sandbox-api',
    }))?.code).toBe('sandbox.dispatch_refused')
    expect(classifySandboxTransientFailure(Object.assign(new Error('backend did not answer'), {
      status: 503, endpoint: '/v1/sandboxes/box-1/resume', origin: 'sandbox-api',
    }))?.code).toBe('sandbox.control_plane_transient')
  })

  it('leaves the failures that need another action alone', () => {
    expect(classifySandboxTransientFailure(new Error('runtime exploded'))).toBeNull()
    // A 500 from inside a live box is the run's own failure.
    expect(classifySandboxTransientFailure(Object.assign(new Error('boom'), {
      status: 500, endpoint: '/v1/sandboxes/box-1/runtime/agents/run/stream', origin: 'sandbox-api',
    }))).toBeNull()
    expect(classifySandboxTransientFailure(Object.assign(new Error('not found'), { name: 'NotFoundError', status: 404 }))).toBeNull()
  })
})

describe('retrySandboxTransient', () => {
  it('backs off from 5 s to a 60 s ceiling', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(sandboxTransientBackoffMs)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000])
  })

  it('returns once the box answers, and fails typed once a stretch outlasts the deadline', async () => {
    let clock = 0
    const sleep = vi.fn(async (ms: number) => { clock += ms })
    let failures = 3
    await expect(retrySandboxTransient(async () => {
      if (failures-- > 0) throw notReady()
      return 'answered'
    }, { now: () => clock, sleep })).resolves.toBe('answered')
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5_000, 10_000, 20_000])

    clock = 0
    const failure = await retrySandboxTransient(async () => { throw notReady() }, { now: () => clock, sleep })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SandboxTransientDeadlineError)
    expect(clock).toBeLessThanOrEqual(SANDBOX_TRANSIENT_DEADLINE_MS)
    expect(clock).toBeGreaterThan(SANDBOX_TRANSIENT_DEADLINE_MS - 60_000)
  })

  it('rethrows a failure the policy does not cover at once', async () => {
    const sleep = vi.fn()
    const error = new Error('runtime exploded')
    await expect(retrySandboxTransient(async () => { throw error }, { sleep })).rejects.toBe(error)
    expect(sleep).not.toHaveBeenCalled()
  })
})
