import { describe, expect, it } from 'vitest'
import {
  HarnessSelectionError,
  resolveSessionHarness,
  type HarnessAvailability,
} from './index'
import { selectSessionHarness } from './session-selection'

const availability: HarnessAvailability = {
  newSessions: ['codex'],
  existingSessions: ['codex', 'pi'],
}

describe('retirement-safe public session admission', () => {
  for (const value of ['retired-runner', '', ' pi ', 42, false, {}, []]) {
    for (const [field, source] of [
      ['sessionHarness', 'session'], ['requested', 'requested'], ['workspaceDefault', 'workspace'],
    ] as const) {
      it(`refuses ${field}=${JSON.stringify(value)} without fallback`, () => {
        expect(() => resolveSessionHarness({ [field]: value })).toThrowError(HarnessSelectionError)
        try {
          resolveSessionHarness({ [field]: value })
        } catch (error) {
          expect(error).toMatchObject({ code: 'harness_unknown', source })
        }
      })
    }
  }

  it('does not erase a lock when an identity is physically removed from the recognized set', () => {
    const known = ['opencode', 'codex'] as const
    expect(() => selectSessionHarness({ sessionHarness: 'pi' }, known, 'opencode'))
      .toThrowError('harness_unknown: session harness "pi"')
  })

  it('treats only null and undefined as absent', () => {
    expect(resolveSessionHarness({ sessionHarness: null, requested: null }))
      .toEqual({ harness: 'opencode', locked: false, swapAttempted: false })
  })

  it('refuses an unknown request even when the saved lock is valid', () => {
    expect(() => resolveSessionHarness({ sessionHarness: 'pi', requested: 'retired-runner' }))
      .toThrowError('harness_unknown: requested harness')
  })

  it('preserves the saved lock and ignores an obsolete unused workspace default', () => {
    expect(resolveSessionHarness({ sessionHarness: 'pi', workspaceDefault: 'retired-runner' }))
      .toEqual({ harness: 'pi', locked: true, swapAttempted: false })
  })

  it('starts an enabled harness and resumes a draining one', () => {
    expect(resolveSessionHarness({ requested: 'codex', availability }).harness).toBe('codex')
    expect(resolveSessionHarness({ sessionHarness: 'pi', availability }))
      .toEqual({ harness: 'pi', locked: true, swapAttempted: false })
  })

  it('does not start a draining harness or resume a retired one', () => {
    expect(() => resolveSessionHarness({ requested: 'pi', availability }))
      .toThrowError('harness_unavailable: requested harness "pi"')
    expect(() => resolveSessionHarness({ sessionHarness: 'opencode', availability }))
      .toThrowError('harness_unavailable: session harness "opencode"')
  })

  it('does not choose a different harness when the configured default is unavailable', () => {
    expect(() => resolveSessionHarness({ availability })).toThrowError('harness_unavailable: fallback')
  })

  it('uses the new-session set when no resume set was provided', () => {
    expect(() => resolveSessionHarness({ sessionHarness: 'pi', availability: { newSessions: ['codex'] } }))
      .toThrowError('harness_unavailable: session')
  })

  it('treats empty sets as deny-all, not missing policy', () => {
    expect(() => resolveSessionHarness({ requested: 'codex', availability: { newSessions: [] } }))
      .toThrowError('harness_unavailable: requested')
    expect(() => resolveSessionHarness({ sessionHarness: 'codex', availability: { newSessions: ['codex'], existingSessions: [] } }))
      .toThrowError('harness_unavailable: session')
  })

  it('does not mutate server-owned frozen availability', () => {
    const policy = Object.freeze({ newSessions: Object.freeze(['codex'] as const) })
    const input = Object.freeze({ requested: 'codex', availability: policy })
    expect(resolveSessionHarness(input).harness).toBe('codex')
    expect(policy.newSessions).toEqual(['codex'])
  })
})
