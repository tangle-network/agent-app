import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_SANDBOX_RECOVERY_ACTIONS,
  WORKSPACE_SANDBOX_RECOVERY_CODES,
  assessWorkspaceSandboxSnapshot,
  createWorkspaceSandboxRecoveryManager,
  isWorkspaceSandboxRecoveryAction,
  isWorkspaceSandboxRecoveryCode,
  isWorkspaceSandboxRecoveryState,
  preferredWorkspaceSandboxRecoveryBoxKey,
  shouldRestoreWorkspaceSandboxRecovery,
  workspaceSandboxRecoveryFromError,
  WorkspaceSandboxRecoveryRequiredError,
  type WorkspaceSandboxRecoveryAction,
  type WorkspaceSandboxRecoveryCode,
  type WorkspaceSandboxRecoveryState,
  type WorkspaceSandboxRecoveryStore,
} from './recovery'

const REPLACEMENT_KEY = 'app:workspace:w1:e2:recovered:abc'

function stateWith(
  action: WorkspaceSandboxRecoveryAction,
  code: WorkspaceSandboxRecoveryCode = 'WORKSPACE_SANDBOX_UNRECOVERABLE',
  snapshot: WorkspaceSandboxRecoveryState['snapshot'] = { availability: 'missing', freshness: 'unknown' },
): WorkspaceSandboxRecoveryState {
  return {
    code,
    sandboxId: 'sandbox-01626d7a7d6b',
    detectedAt: '2026-08-01T00:00:00.000Z',
    snapshot,
    action,
    replacementBoxKey: REPLACEMENT_KEY,
  }
}

function memoryStore(seed?: WorkspaceSandboxRecoveryState): WorkspaceSandboxRecoveryStore & {
  rows: Map<string, WorkspaceSandboxRecoveryState>
} {
  const rows = new Map<string, WorkspaceSandboxRecoveryState>()
  if (seed) rows.set('w1', seed)
  return {
    rows,
    read: async (workspaceId) => rows.get(workspaceId),
    write: async (workspaceId, recovery) => {
      rows.set(workspaceId, recovery)
    },
  }
}

describe('recovery action and code tables', () => {
  // The bug this module exists to prevent: an action that no question knows
  // about. Every declared action must be accepted by the validator and answered
  // by the key resolver, or a recovery recorded under it is written, read back,
  // discarded as malformed, and the workspace re-provisions the dead box.
  it('classifies every declared action, with no unreachable branch', () => {
    expect(WORKSPACE_SANDBOX_RECOVERY_ACTIONS.length).toBeGreaterThan(0)
    for (const action of WORKSPACE_SANDBOX_RECOVERY_ACTIONS) {
      expect(isWorkspaceSandboxRecoveryAction(action)).toBe(true)
      expect(isWorkspaceSandboxRecoveryState(stateWith(action))).toBe(true)
      // Answering is what matters — either the key or a deliberate undefined.
      const key = preferredWorkspaceSandboxRecoveryBoxKey(stateWith(action))
      expect(key === REPLACEMENT_KEY || key === undefined).toBe(true)
    }
  })

  it('answers the snapshot question for every declared code', () => {
    for (const code of WORKSPACE_SANDBOX_RECOVERY_CODES) {
      const fresh = stateWith('replacement_started', code, {
        availability: 'available',
        freshness: 'fresh',
        snapshot: { fromSandboxId: 'sandbox-01626d7a7d6b', createdAt: '2026-08-01T00:00:00.000Z' },
      })
      expect(typeof shouldRestoreWorkspaceSandboxRecovery(fresh)).toBe('boolean')
    }
  })

  it('rejects an action or code that was never declared', () => {
    expect(isWorkspaceSandboxRecoveryAction('replacement_probably')).toBe(false)
    expect(isWorkspaceSandboxRecoveryCode('WORKSPACE_SANDBOX_VIBES')).toBe(false)
    expect(isWorkspaceSandboxRecoveryState({ ...stateWith('replacement_started'), action: 'nope' })).toBe(false)
  })
})

describe('replacement box key', () => {
  it('hands back the key once a replacement box has been chosen', () => {
    expect(preferredWorkspaceSandboxRecoveryBoxKey(stateWith('unrecoverable_replacement_started')))
      .toBe(REPLACEMENT_KEY)
    expect(preferredWorkspaceSandboxRecoveryBoxKey(stateWith('missing_replacement_started')))
      .toBe(REPLACEMENT_KEY)
  })

  it('withholds it while an owner has not agreed to lose the box', () => {
    expect(preferredWorkspaceSandboxRecoveryBoxKey(stateWith('confirmation_required'))).toBeUndefined()
    expect(preferredWorkspaceSandboxRecoveryBoxKey(stateWith('deletion_declined'))).toBeUndefined()
  })

  it('withholds it when no key was recorded at all', () => {
    const { replacementBoxKey: _dropped, ...withoutKey } = stateWith('replacement_started')
    expect(preferredWorkspaceSandboxRecoveryBoxKey(withoutKey)).toBeUndefined()
  })
})

describe('snapshot restore decision', () => {
  const freshSnapshot = {
    availability: 'available' as const,
    freshness: 'fresh' as const,
    snapshot: { fromSandboxId: 'sandbox-01626d7a7d6b', createdAt: '2026-08-01T00:00:00.000Z' },
  }

  it('restores from a fresh snapshot when the box is merely being swapped', () => {
    expect(shouldRestoreWorkspaceSandboxRecovery(
      stateWith('replacement_started', 'EGRESS_PROXY_RECOVERY_REQUIRED', freshSnapshot),
    )).toBe(true)
  })

  it.each([
    'WORKSPACE_SANDBOX_MISSING',
    'WORKSPACE_SANDBOX_HOST_EXHAUSTED',
    'WORKSPACE_SANDBOX_UNRECOVERABLE',
  ] as const)('refuses to restore from a box the platform cannot start (%s)', (code) => {
    expect(shouldRestoreWorkspaceSandboxRecovery(
      stateWith('replacement_started', code, freshSnapshot),
    )).toBe(false)
  })
})

describe('snapshot assessment', () => {
  const now = Date.parse('2026-08-01T00:00:00.000Z')

  it('is fresh only for this sandbox and inside the age bound', () => {
    expect(assessWorkspaceSandboxSnapshot(
      { fromSandboxId: 'box-a', createdAt: '2026-07-31T23:00:00.000Z' }, 'box-a', now,
    )).toMatchObject({ availability: 'available', freshness: 'fresh' })
  })

  it('is stale when it came from a different box, however recent', () => {
    expect(assessWorkspaceSandboxSnapshot(
      { fromSandboxId: 'box-b', createdAt: '2026-07-31T23:59:59.000Z' }, 'box-a', now,
    )).toMatchObject({ availability: 'stale' })
  })

  it('is stale past the age bound', () => {
    expect(assessWorkspaceSandboxSnapshot(
      { fromSandboxId: 'box-a', createdAt: '2026-07-30T23:00:00.000Z' }, 'box-a', now,
    )).toMatchObject({ availability: 'stale' })
  })

  it('is missing when there is no snapshot', () => {
    expect(assessWorkspaceSandboxSnapshot(undefined, 'box-a', now))
      .toEqual({ availability: 'missing', freshness: 'unknown' })
  })
})

describe('recovery manager', () => {
  it('records an owner decision against the sandbox it names', async () => {
    const store = memoryStore(stateWith('confirmation_required'))
    const manager = createWorkspaceSandboxRecoveryManager(store)

    const next = await manager.decide({
      workspaceId: 'w1',
      sandboxId: 'sandbox-01626d7a7d6b',
      decision: 'replace',
      replacementBoxKey: REPLACEMENT_KEY,
    })

    expect(next?.action).toBe('replacement_authorized')
    expect(store.rows.get('w1')?.action).toBe('replacement_authorized')
  })

  it('ignores a decision about a sandbox that has already been replaced', async () => {
    const store = memoryStore(stateWith('replacement_completed'))
    const manager = createWorkspaceSandboxRecoveryManager(store)

    const next = await manager.decide({
      workspaceId: 'w1',
      sandboxId: 'sandbox-someone-elses',
      decision: 'replace',
    })

    expect(next).toBeUndefined()
    expect(store.rows.get('w1')?.action).toBe('replacement_completed')
  })

  it('names the box that took over when a replacement finishes', async () => {
    const store = memoryStore(stateWith('unrecoverable_replacement_started'))
    const manager = createWorkspaceSandboxRecoveryManager(store)

    const next = await manager.complete({ workspaceId: 'w1', replacementSandboxId: 'sandbox-new' })

    expect(next?.action).toBe('unrecoverable_replacement_completed')
    expect(next?.replacementSandboxId).toBe('sandbox-new')
  })

  it('does nothing when there is no recovery to complete', async () => {
    const manager = createWorkspaceSandboxRecoveryManager(memoryStore())
    expect(await manager.complete({ workspaceId: 'w1', replacementSandboxId: 'sandbox-new' }))
      .toBeUndefined()
  })
})

describe('recovery carried on an error', () => {
  it('is found through a cause chain', () => {
    const recovery = stateWith('replacement_started')
    const wrapped = new Error('outer', {
      cause: new WorkspaceSandboxRecoveryRequiredError(recovery, new Error('inner')),
    })
    expect(workspaceSandboxRecoveryFromError(wrapped)).toEqual(recovery)
  })

  it('survives a cause cycle instead of hanging', () => {
    const a: { cause?: unknown; message: string } = { message: 'a' }
    const b = { message: 'b', cause: a }
    a.cause = b
    expect(workspaceSandboxRecoveryFromError(a)).toBeUndefined()
  })

  it('returns nothing when no recovery is attached', () => {
    expect(workspaceSandboxRecoveryFromError(new Error('unrelated'))).toBeUndefined()
  })
})
