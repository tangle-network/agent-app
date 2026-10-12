import { canonicalCandidateBytes, snapshotAgentProfile } from '@tangle-network/agent-interface'
import { describe, expect, it, vi } from 'vitest'
import { admitProfileTurn, bindProfileText, readProfileAdmission, switchProfile, type ProfileRevision, type ProfileRevisionStore } from './index'

const baseline = snapshotAgentProfile({
  name: 'GTM Agent', harness: 'opencode', prompt: { systemPrompt: 'base' },
  model: { default: 'deepseek/deepseek-v4.1-flash' },
})

function undefinedKeys(value: object | undefined): string[] {
  return Object.entries(value ?? {}).filter(([, entry]) => entry === undefined).map(([key]) => key)
}

describe('bindProfileText', () => {
  it('returns canonical JSON when the selected profile omits text fields', () => {
    const bound = bindProfileText(baseline, baseline)
    expect(undefinedKeys(bound)).toEqual([])
    expect(undefinedKeys(bound.prompt)).toEqual([])
    // Hosts digest a profile derived from the bound one before dispatch.
    expect(() => canonicalCandidateBytes({ profile: { ...bound, prompt: { ...bound.prompt, systemPrompt: 'composed' } } })).not.toThrow()
  })

  it('overlays selected text and clears baseline text the selection removes', () => {
    const withText = snapshotAgentProfile({ ...baseline, description: 'old', prompt: { systemPrompt: 'base', instructions: ['old'] } })
    const selected = snapshotAgentProfile({ ...baseline, description: 'new', prompt: { systemPrompt: 'next' } })
    const bound = bindProfileText(withText, selected)
    expect(bound.description).toBe('new')
    expect(bound.prompt).toEqual({ systemPrompt: 'next' })
    expect('instructions' in (bound.prompt ?? {})).toBe(false)
  })

  it('removes the prompt when no text remains', () => {
    const bare = snapshotAgentProfile({ name: 'GTM Agent', harness: 'opencode', model: { default: 'deepseek/deepseek-v4.1-flash' } })
    const bound = bindProfileText(bare, bare)
    expect('prompt' in bound).toBe(false)
    expect('description' in bound).toBe(false)
  })
})

describe('switchProfile', () => {
  const key = { workspaceId: 'ws-1', memberId: 'm-1', channel: 'chat' }
  const revision = { id: 'rev-1', profileId: 'p-1', profile: { name: 'Gateway' }, planDigest: 'sha256:plan',
    authorityDigest: 'sha256:auth' } as unknown as ProfileRevision
  const store = {
    getSwitchReceipt: async () => null, getBinding: async () => null,
    getActiveRevision: async () => revision,
    recordSwitch: async (receipt: object) => receipt,
  } as unknown as ProfileRevisionStore
  const refused = (onPrepareFailure?: (error: unknown, profileId: string) => void) => switchProfile({
    store, key, messageId: 'msg-1', content: 'Switch to Gateway', choice: { profileId: 'p-1' },
    profiles: [{ id: 'p-1', name: 'Gateway', status: 'active' }], canSelect: async () => true,
    prepareAuthority: async () => { throw new Error('This profile requires different network access') },
    onPrepareFailure,
  })

  it('keeps the person-facing refusal generic but hands the reason to the host', async () => {
    const reasons: string[] = []
    const receipt = await refused((error, profileId) => reasons.push(`${profileId}: ${(error as Error).message}`))
    expect(receipt).toMatchObject({ outcome: 'refused', message: 'Could not prepare Gateway; your current agent is unchanged.' })
    expect(reasons).toEqual(['p-1: This profile requires different network access'])
  })

  it('logs the reason by default', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await refused()
      expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({ event: 'profile-switch-prepare-failed',
        profileId: 'p-1', error: 'Error: This profile requires different network access' })
    } finally { log.mockRestore() }
  })
})

describe('admitProfileTurn with an admission read', () => {
  const key = { workspaceId: 'ws-1', memberId: 'm-1', channel: 'chat' }
  const plan = `sha256:${'a'.repeat(64)}`
  const revision = (id: string, authority: string) => ({ id, profileId: 'p-1', profile: { name: 'Gateway' }, planDigest: plan,
    authorityDigest: authority }) as unknown as ProfileRevision
  function fixture() {
    const state = { binding: { ...key, profileId: 'p-1', pinnedRevisionId: null as string | null, authorityDigest: 'sha256:auth-1',
      planDigest: plan, version: 1 }, active: revision('rev-1', 'sha256:auth-1') }
    const pins: unknown[] = []
    const store = {
      getTurnPin: vi.fn(async () => null),
      getBinding: vi.fn(async () => ({ ...state.binding })),
      getRevision: vi.fn(async () => state.active),
      getActiveRevision: vi.fn(async () => state.active),
      pinTurn: vi.fn(async (pin: object, expectedVersion: number) => {
        if (expectedVersion !== state.binding.version) throw new Error('binding moved')
        pins.push(pin)
        return pin
      }),
    } as unknown as ProfileRevisionStore & Record<string, ReturnType<typeof vi.fn>>
    return { state, pins, store }
  }

  it('admits from the read without reading the pin or binding again', async () => {
    const f = fixture()
    const read = await readProfileAdmission(f.store, key, 'msg-1', 'hello')
    await admitProfileTurn({ store: f.store, key, messageId: 'msg-1', content: 'hello', observedManagedPlanDigest: plan, read })
    expect(f.store.getTurnPin).toHaveBeenCalledTimes(1)
    expect(f.store.getBinding).toHaveBeenCalledTimes(1)
    // The active pointer is read live by admission.
    expect(f.store.getActiveRevision).toHaveBeenCalledTimes(1)
    expect(f.pins).toHaveLength(1)
  })

  it('refuses a binding that moved after the read', async () => {
    const f = fixture()
    const read = await readProfileAdmission(f.store, key, 'msg-1', 'hello')
    f.state.binding = { ...f.state.binding, version: 2 }
    await expect(admitProfileTurn({ store: f.store, key, messageId: 'msg-1', content: 'hello', observedManagedPlanDigest: plan, read }))
      .rejects.toThrow('binding moved')
    expect(f.pins).toEqual([])
  })

  it('refuses an active revision that moved after the read and never pins the stale one', async () => {
    const f = fixture()
    const read = await readProfileAdmission(f.store, key, 'msg-1', 'hello')
    f.state.active = revision('rev-2', 'sha256:auth-2')
    await expect(admitProfileTurn({ store: f.store, key, messageId: 'msg-1', content: 'hello', observedManagedPlanDigest: plan, read }))
      .rejects.toThrow('not active for this turn')
    expect(f.pins).toEqual([])
  })

  it('accepts only a read this module issued, for this message', async () => {
    const f = fixture()
    const forged = { key, messageId: 'msg-1', inputHash: 'x', prior: null, binding: f.state.binding, pinnedRevision: null }
    // @ts-expect-error a hand-built object is not an admission read
    const typed: Parameters<typeof admitProfileTurn>[0] = { store: f.store, key, messageId: 'msg-1', content: 'hello', observedManagedPlanDigest: plan, read: forged }
    await expect(admitProfileTurn(typed)).rejects.toThrow('does not belong to this message')
    const other = await readProfileAdmission(f.store, key, 'msg-2', 'hello')
    await expect(admitProfileTurn({ store: f.store, key, messageId: 'msg-1', content: 'hello', observedManagedPlanDigest: plan, read: other }))
      .rejects.toThrow('does not belong to this message')
    expect(f.pins).toEqual([])
  })
})
