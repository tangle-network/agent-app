import { canonicalCandidateBytes, snapshotAgentProfile, type AgentProfile } from '@tangle-network/agent-interface'
import { describe, expect, it, vi } from 'vitest'
import { admitProfileTurn, bindProfileText, profileAdmissionValues, proposeRevision, promoteRevision, readProfileAdmission, switchProfile, type ProfileRevision, type ProfileRevisionStore } from './index'

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

describe('proxy authority revision consent', () => {
  it('saves and reloads references, auto-activates text, and requires verified owner consent for authority edits', async () => {
    const workspaceId = 'ws-1'
    const profileId = 'p-1'
    const planDigest = `sha256:${'a'.repeat(64)}`
    const rows = new Map<string, string>()
    let active: string | null = null
    const load = (id: string | null): ProfileRevision | null => id && rows.has(id)
      ? JSON.parse(rows.get(id)!) as ProfileRevision : null
    // The existing memory-store compare-and-append contract, with serialized
    // rows so reads exercise the stored revision rather than the input object.
    const store = {
      async getActiveRevision() { return load(active) },
      async getRevision(_workspaceId: string, _profileId: string, id: string) { return load(id) },
      async appendRevision(revision: ProfileRevision, expectedActiveId: string | null, activate: boolean) {
        if (active !== expectedActiveId) return false
        rows.set(revision.id, JSON.stringify(revision))
        if (activate) active = revision.id
        return true
      },
      async promoteRevision(_workspaceId: string, _profileId: string, id: string, expectedActiveId: string | null) {
        if (active !== expectedActiveId || !rows.has(id)) return false
        active = id
        return true
      },
    } as unknown as ProfileRevisionStore
    const binding = {
      envName: 'REPORTS_TOKEN', secretRef: { kind: 'secret-ref', key: 'reporting-api' },
      hosts: ['reports.example.com'], presentation: { type: 'bearer' }, methods: ['POST'],
      paths: ['/v1/events'], ttlSeconds: 300,
    } satisfies NonNullable<AgentProfile['proxySecrets']>[number]
    const authorized = snapshotAgentProfile({ ...baseline, proxySecrets: [binding] })
    const save = (profile: AgentProfile, id: string, expectedRevisionId: string | null) => proposeRevision({
      store, workspaceId, profileId, expectedRevisionId, profile, id,
      knowledgeText: '', planDigest, author: { kind: 'person', id: 'm-1' },
      actorRole: 'manager', reason: 'Requested profile revision',
    })
    const seed = await save(authorized, 'approved', null)
    expect((await store.getRevision(workspaceId, profileId, seed.id))?.profile.proxySecrets).toEqual([binding])
    const text = await save({ ...authorized, prompt: { systemPrompt: 'Edited role text' } }, 'text', seed.id)
    expect(text.state).toBe('active')
    expect(text.authorityDigest).toBe(seed.authorityDigest)
    expect((await store.getActiveRevision(workspaceId, profileId))?.profile.proxySecrets).toEqual([binding])

    const changes = [
      { secretRef: { kind: 'secret-ref', key: 'other-api' } },
      { hosts: ['other.example.com'] },
      { presentation: { type: 'header', name: 'X-Reports-Key' } },
      { paths: ['/v1/accounts'] },
    ] satisfies Partial<NonNullable<AgentProfile['proxySecrets']>[number]>[]
    let latest = text
    for (const [index, change] of changes.entries()) {
      const requested = [{ ...binding, ...change }]
      const draft = await save({ ...text.profile, proxySecrets: requested }, `draft-${index}`, text.id)
      expect(draft.state).toBe('pending-consent')
      expect(draft.authorityDigest).not.toBe(seed.authorityDigest)
      expect((await store.getRevision(workspaceId, profileId, draft.id))?.profile.proxySecrets).toEqual(requested)
      await expect(promoteRevision({ store, workspaceId, profileId, revisionId: draft.id,
        actorRole: 'manager', verifyConsent: async () => true })).rejects.toThrow('Authority changes require owner consent')
      expect((await store.getActiveRevision(workspaceId, profileId))?.id).toBe(text.id)
      latest = draft
    }
    await expect(promoteRevision({ store, workspaceId, profileId, revisionId: latest.id,
      actorRole: 'owner', verifyConsent: async () => false })).rejects.toThrow('Authority changes require owner consent')
    await promoteRevision({ store, workspaceId, profileId, revisionId: latest.id,
      actorRole: 'owner', verifyConsent: async revision => revision.id === latest.id && revision.authorityDigest === latest.authorityDigest })
    expect((await store.getActiveRevision(workspaceId, profileId))?.id).toBe(latest.id)
    expect((await store.getActiveRevision(workspaceId, profileId))?.profile.proxySecrets).toEqual(latest.profile.proxySecrets)
    expect((await store.getRevision(workspaceId, profileId, seed.id))?.profile.proxySecrets).toEqual([binding])
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
  const otherPlan = `sha256:${'b'.repeat(64)}`
  const revision = (id: string, authority: string) => ({ id, profileId: 'p-1', profile: { name: 'Gateway' }, planDigest: plan,
    authorityDigest: authority }) as unknown as ProfileRevision
  function fixture(pinned = false) {
    const state = { binding: { ...key, profileId: 'p-1', pinnedRevisionId: pinned ? 'rev-pinned' : null as string | null,
      authorityDigest: 'sha256:auth-1', planDigest: plan, version: 1 },
    active: revision('rev-1', 'sha256:auth-1'), pinnedRev: revision('rev-pinned', 'sha256:auth-1'),
    prior: null as unknown }
    const pins: Array<Record<string, unknown>> = []
    const fns = {
      getTurnPin: vi.fn(async () => state.prior),
      getBinding: vi.fn(async () => ({ ...state.binding })),
      getRevision: vi.fn(async () => ({ ...state.pinnedRev })),
      getActiveRevision: vi.fn(async () => ({ ...state.active })),
      pinTurn: vi.fn(async (pin: Record<string, unknown>, expectedVersion: number) => {
        if (expectedVersion !== state.binding.version) throw new Error('binding moved')
        pins.push(pin)
        return pin
      }),
    }
    return { state, pins, fns, store: fns as unknown as ProfileRevisionStore }
  }
  const admit = (f: ReturnType<typeof fixture>, read: Parameters<typeof admitProfileTurn>[0]['read'], over: Partial<Parameters<typeof admitProfileTurn>[0]> = {}) =>
    admitProfileTurn({ store: f.store, key, messageId: 'msg-1', content: 'hello', observedManagedPlanDigest: plan, read, ...over })

  it('admits from the read without reading the pin or binding again, and reads the active pointer live', async () => {
    const f = fixture()
    await admit(f, await readProfileAdmission(f.store, key, 'msg-1', 'hello'))
    expect([f.fns.getTurnPin.mock.calls.length, f.fns.getBinding.mock.calls.length, f.fns.getActiveRevision.mock.calls.length]).toEqual([1, 1, 1])
    expect(f.pins).toHaveLength(1)
  })

  it('uses the pinned revision it read, by id, without reading it again', async () => {
    const f = fixture(true)
    await admit(f, await readProfileAdmission(f.store, key, 'msg-1', 'hello'))
    expect([f.fns.getRevision.mock.calls.length, f.fns.getActiveRevision.mock.calls.length]).toEqual([1, 0])
    expect(f.pins[0]).toMatchObject({ revisionId: 'rev-pinned' })
  })

  it('returns the existing pin of a message already admitted, writing nothing', async () => {
    const f = fixture()
    f.state.prior = { ...key, messageId: 'msg-1', revisionId: 'rev-1' }
    await expect(admit(f, await readProfileAdmission(f.store, key, 'msg-1', 'hello'))).resolves.toMatchObject({ revisionId: 'rev-1' })
    expect(f.pins).toEqual([])
  })

  it('refuses a binding that moved after the read', async () => {
    const f = fixture()
    const read = await readProfileAdmission(f.store, key, 'msg-1', 'hello')
    f.state.binding = { ...f.state.binding, version: 2 }
    await expect(admit(f, read)).rejects.toThrow('binding moved')
    expect(f.pins).toEqual([])
  })

  it('refuses an active revision that moved after the read and never pins the stale one', async () => {
    const f = fixture()
    const read = await readProfileAdmission(f.store, key, 'msg-1', 'hello')
    f.state.active = revision('rev-2', 'sha256:auth-2')
    await expect(admit(f, read)).rejects.toThrow('not active for this turn')
    expect(f.pins).toEqual([])
  })

  it('cannot be changed through its values: a mutated copy admits nothing different', async () => {
    const f = fixture(true)
    const read = await readProfileAdmission(f.store, key, 'msg-1', 'hello')
    const values = profileAdmissionValues(read)
    values.pinnedRevision!.planDigest = otherPlan
    values.binding!.version = 99
    await expect(admit(f, read, { observedManagedPlanDigest: otherPlan })).rejects.toThrow('not active for this turn')
    expect(f.pins).toEqual([])
  })

  it('admits once per read', async () => {
    const f = fixture()
    const read = await readProfileAdmission(f.store, key, 'msg-1', 'hello')
    await admit(f, read)
    // A retry is a conflict to read again, not a permission refusal.
    await expect(admit(f, read)).rejects.toMatchObject({ name: 'ProfileConflictError', message: 'The admission read was already used; read again' })
    expect(() => profileAdmissionValues(read)).toThrow('Unknown or used')
    expect(f.pins).toHaveLength(1)
  })

  it('refuses a read for another message, other content or another key', async () => {
    const f = fixture()
    await expect(admit(f, await readProfileAdmission(f.store, key, 'msg-2', 'hello'))).rejects.toThrow('does not belong')
    await expect(admit(f, await readProfileAdmission(f.store, key, 'msg-1', 'other text'))).rejects.toThrow('does not belong')
    await expect(admit(f, await readProfileAdmission(f.store, { ...key, memberId: 'm-2' }, 'msg-1', 'hello'))).rejects.toThrow('does not belong')
    expect(f.pins).toEqual([])
  })

  it('refuses anything this module did not issue', async () => {
    const f = fixture()
    const forged = Object.freeze(Object.create(null)) as Parameters<typeof admitProfileTurn>[0]['read']
    await expect(admit(f, forged)).rejects.toThrow('does not belong to this message')
    const shaped = { key, messageId: 'msg-1', inputHash: 'x', prior: null, binding: f.state.binding, pinnedRevision: null }
    const input: Parameters<typeof admitProfileTurn>[0] = { store: f.store, key, messageId: 'msg-1', content: 'hello', observedManagedPlanDigest: plan,
      // @ts-expect-error -- an object literal lacks the module's admission-read brand
      read: shaped }
    await expect(admitProfileTurn(input)).rejects.toThrow('does not belong to this message')
    expect(f.pins).toEqual([])
  })
})
