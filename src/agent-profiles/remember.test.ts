import { snapshotAgentProfile } from '@tangle-network/agent-interface'
import { describe, expect, it } from 'vitest'
import { PROFILE_MEMORY_PREFIX, ProfileAccessError, profileAuthorityDigest, profileTools, type ProfileRevision,
  type ProfileRevisionStore, type ProfileToolTurn } from './index'

const profile = snapshotAgentProfile({ name: 'Pablo', harness: 'opencode', prompt: { systemPrompt: 'base' },
  model: { default: 'test-model' } })
const planDigest = `sha256:${'a'.repeat(64)}`

/** An in-memory store with the same compare-and-append contract as the D1 store. */
function memoryStore(knowledgeText = '') {
  const revisions: ProfileRevision[] = [{ id: 'rev-0', workspaceId: 'ws-1', profileId: 'p-1', parentId: null,
    profile, knowledgeText, author: { kind: 'person', id: 'm-1' }, reason: 'seed', diff: [],
    knowledgeTextChanged: knowledgeText.length > 0, authorityDigest: profileAuthorityDigest(profile),
    planDigest, state: 'active', createdAt: 0 }]
  let active = 'rev-0'
  let beforeAppend: (() => void) | undefined
  const store = {
    async getActiveRevision() { return revisions.find(revision => revision.id === active) ?? null },
    async appendRevision(revision: ProfileRevision, expectedActiveId: string | null, activate: boolean) {
      beforeAppend?.()
      beforeAppend = undefined
      if (active !== expectedActiveId) return false
      revisions.push(revision)
      if (activate) active = revision.id
      return true
    },
  } as unknown as ProfileRevisionStore
  return {
    store, revisions,
    knowledge: () => revisions.find(revision => revision.id === active)!.knowledgeText,
    /** Simulates another save landing between the tool's read and its append. */
    raceOnce(text: string) {
      beforeAppend = () => {
        const current = revisions.find(revision => revision.id === active)!
        const raced = { ...current, id: `raced-${revisions.length}`, parentId: current.id, knowledgeText: text }
        revisions.push(raced)
        active = raced.id
      }
    },
  }
}

function remember(store: ProfileRevisionStore, role: ProfileToolTurn['role'] = 'owner') {
  const tool = profileTools({
    store, planDigest: async () => planDigest,
    activeTurn: async () => ({ workspaceId: 'ws-1', profileId: 'p-1', revisionId: 'rev-0', memberId: 'm-1', role }),
  }).find(candidate => candidate.name === 'profile.remember')!
  return (fact: string) => tool.run({ fact } as never, {} as never) as Promise<Record<string, unknown>>
}

describe('profile.remember', () => {
  it('appends one fact line to the knowledge every later conversation reads', async () => {
    const memory = memoryStore('- Breakfast is served from 7am.')
    const result = await remember(memory.store)('The sauna closes at 8pm on Sundays.')
    expect(result).toMatchObject({ saved: true, alreadyKnown: false, appliesTo: 'next_message',
      line: '- The sauna closes at 8pm on Sundays.' })
    expect(memory.knowledge()).toBe('- Breakfast is served from 7am.\n- The sauna closes at 8pm on Sundays.')
    expect(memory.revisions.at(-1)).toMatchObject({ parentId: 'rev-0', knowledgeTextChanged: true,
      author: { kind: 'agent', id: 'm-1' }, profile })
  })

  it('does not add a fact the knowledge already holds', async () => {
    const memory = memoryStore('- The sauna closes at 8pm on Sundays.')
    expect(await remember(memory.store)('The sauna closes at 8pm   on Sundays.'))
      .toMatchObject({ saved: true, alreadyKnown: true, revisionId: 'rev-0' })
    expect(memory.revisions).toHaveLength(1)
  })

  it('keeps a save that lands concurrently and still records the fact', async () => {
    const memory = memoryStore('')
    memory.raceOnce('- Checkout is at 11am.')
    expect(await remember(memory.store)('The sauna closes at 8pm on Sundays.')).toMatchObject({ saved: true })
    expect(memory.knowledge()).toBe('- Checkout is at 11am.\n- The sauna closes at 8pm on Sundays.')
  })

  it('refuses members and viewers', async () => {
    for (const role of ['member', 'viewer'] as const) {
      await expect(remember(memoryStore().store, role)('A fact')).rejects.toBeInstanceOf(ProfileAccessError)
    }
  })
})

describe('profile.remember with a workspace memory store', () => {
  it('writes the fact to the store and never appends a profile revision', async () => {
    const { createInMemoryWorkspaceStore } = await import('@tangle-network/agent-runtime/workspace-store')
    const memory = memoryStore('- Breakfast is served from 7am.')
    const workspace = createInMemoryWorkspaceStore()
    const tool = profileTools({
      store: memory.store, planDigest: async () => planDigest, memory: workspace,
      activeTurn: async () => ({ workspaceId: 'ws-1', profileId: 'p-1', revisionId: 'rev-0', memberId: 'm-1', role: 'owner' as const }),
    }).find(candidate => candidate.name === 'profile.remember')!
    const first = await tool.run({ fact: 'The sauna closes at 8pm on Sundays.' } as never, {} as never) as Record<string, unknown>
    expect(first).toMatchObject({ saved: true, alreadyKnown: false })
    expect(await tool.run({ fact: 'The sauna  closes at 8pm on Sundays.' } as never, {} as never))
      .toMatchObject({ saved: true, alreadyKnown: true, memoryId: first.memoryId })
    expect((await workspace.list('ws-1', PROFILE_MEMORY_PREFIX)).map(entry => entry.content))
      .toEqual(['The sauna closes at 8pm on Sundays.'])
    expect(memory.revisions).toHaveLength(1)
    expect(memory.knowledge()).toBe('- Breakfast is served from 7am.')
  })
})
