import { describe, expect, it, vi } from 'vitest'
import {
  createWorkspaceSandboxRecoveryManager, WORKSPACE_SANDBOX_RECOVERY_ACTIONS,
  type WorkspaceSandboxRecoveryAction, type WorkspaceSandboxRecoveryState,
} from './recovery'

const box = 'old-box'
const waiting = ['confirmation_required', 'deletion_declined'] as const
const completed = {
  replacement_started: 'replacement_completed',
  snapshot_replacement_started: 'snapshot_replacement_completed',
  snapshot_restore_failed: 'snapshot_replacement_completed',
  missing_replacement_started: 'missing_replacement_completed',
  unrecoverable_replacement_started: 'unrecoverable_replacement_completed',
} as const
function fixture(action: WorkspaceSandboxRecoveryAction, key: string | undefined = 'new-key') {
  let row: WorkspaceSandboxRecoveryState = {
    code: 'EGRESS_PROXY_RECOVERY_REQUIRED', sandboxId: box, action,
    detectedAt: '2026-09-29T00:00:00Z',
    snapshot: { availability: 'missing', freshness: 'unknown' }, replacementBoxKey: key,
  }
  const store = {
    read: async () => row,
    write: vi.fn(async (_id: string, next: WorkspaceSandboxRecoveryState) => { row = next }),
  }
  return { store, manager: createWorkspaceSandboxRecoveryManager(store) }
}

describe('recovery transitions', () => {
  it.each(WORKSPACE_SANDBOX_RECOVERY_ACTIONS)('an owner decision is admitted only while waiting: %s', async action => {
    const { manager, store } = fixture(action)
    const next = await manager.decide({ workspaceId: 'w', sandboxId: box, decision: 'decline' })
    const allowed = (waiting as readonly string[]).includes(action)
    expect(next?.action).toBe(allowed ? 'deletion_declined' : undefined)
    expect(store.write).toHaveBeenCalledTimes(allowed ? 1 : 0)
  })
  it.each([undefined, '', '   '])('replace requires a fresh explicit nonblank key: %j', async replacementBoxKey => {
    const { manager, store } = fixture('confirmation_required')
    // Exercise JavaScript/untrusted input even though TypeScript rejects an absent key.
    await expect(manager.decide({ workspaceId: 'w', sandboxId: box, decision: 'replace', replacementBoxKey: replacementBoxKey as string }))
      .rejects.toThrow(/replacement box key/)
    expect(store.write).not.toHaveBeenCalled()
  })
  it.each(WORKSPACE_SANDBOX_RECOVERY_ACTIONS)('completion only closes a started replacement: %s', async action => {
    const { manager, store } = fixture(action)
    const next = await manager.complete({ workspaceId: 'w', replacementSandboxId: 'new-box' })
    const expected = completed[action as keyof typeof completed]
    expect(next?.action).toBe(expected)
    expect(store.write).toHaveBeenCalledTimes(expected ? 1 : 0)
  })
  it.each([undefined, '', '   '])('completion cannot invent a chosen key: %j', async key => {
    const { manager, store } = fixture('replacement_started', key)
    // Explicitly remove the fixture default for undefined.
    const row = await store.read(); row.replacementBoxKey = key
    expect(await manager.complete({ workspaceId: 'w', replacementSandboxId: 'new-box' })).toBeUndefined()
    expect(store.write).not.toHaveBeenCalled()
  })
  it.each(['', '   '])('completion requires a nonempty replacement identity: %j', async replacementSandboxId => {
    const { manager, store } = fixture('replacement_started')
    await expect(manager.complete({ workspaceId: 'w', replacementSandboxId })).rejects.toThrow(/replacement sandbox id/)
    expect(store.write).not.toHaveBeenCalled()
  })
  it.each(['decide', 'complete'] as const)('a concurrent recovery cannot be overwritten by %s', async operation => {
    const { store } = fixture(operation === 'decide' ? 'confirmation_required' : 'replacement_started')
    const expected = await store.read()
    const compareAndSet = vi.fn(async () => false)
    const manager = createWorkspaceSandboxRecoveryManager({ ...store, compareAndSet })
    await expect(operation === 'decide'
      ? manager.decide({ workspaceId: 'w', sandboxId: box, decision: 'replace', replacementBoxKey: 'fresh' })
      : manager.complete({ workspaceId: 'w', replacementSandboxId: 'new-box' }))
      .rejects.toThrow(/changed/)
    expect(compareAndSet).toHaveBeenCalledWith('w', expected, expect.any(Object))
    expect(store.write).not.toHaveBeenCalled()
  })
  it('retains caller snapshot metadata through assessment and transition', async () => {
    const { manager, store } = fixture('confirmation_required')
    const row = await store.read()
    row.snapshot = { availability: 'available', freshness: 'fresh',
      snapshot: { fromSandboxId: box, createdAt: '2026-09-29T00:00:00Z', snapshotId: 's1', checksum: 'abc' } }
    const next = await manager.decide({ workspaceId: 'w', sandboxId: box, decision: 'replace', replacementBoxKey: 'fresh' })
    expect(next?.snapshot).toBe(row.snapshot)
    expect(next?.action).toBe('snapshot_replacement_authorized')
  })
})


describe('provisioning attempt identity', () => {
  it.each(['superseded-key', '', '   '])('refuses a result from a different provisioning attempt: %j', async replacementBoxKey => {
    const { manager, store } = fixture('replacement_started', 'current-key')
    expect(await manager.complete({ workspaceId: 'w', replacementSandboxId: 'old-result', replacementBoxKey })).toBeUndefined()
    expect(store.write).not.toHaveBeenCalled()
    expect((await store.read()).action).toBe('replacement_started')
  })
  it('completes the matching attempt and retains its identity', async () => {
    const { manager } = fixture('replacement_started', 'current-key')
    expect(await manager.complete({ workspaceId: 'w', replacementSandboxId: 'new-box', replacementBoxKey: 'current-key' }))
      .toMatchObject({ action: 'replacement_completed', replacementBoxKey: 'current-key', replacementSandboxId: 'new-box' })
  })
})
