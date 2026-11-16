/**
 * A turn's profile pin over a real SQLite database behind the D1 surface: `admitProfileTurn` pins the member's
 * bound revision once per message, a retry of the same message returns the same pin, a reused message id with
 * different content is refused, and the pin write is one round trip. Creative paid four serial ~76 ms D1 round
 * trips per turn here (production, 2026-10-22); the pre-read and the separate read-back were two of them.
 */
import { DatabaseSync } from 'node:sqlite'
import type { AgentProfile } from '@tangle-network/agent-interface'
import { describe, expect, it } from 'vitest'
import { AGENT_PROFILE_D1_SCHEMA_SQL, createD1ProfileRevisionStore, type ProfileD1Database, type ProfileD1Statement } from '../src/agent-profiles/d1'
import { admitProfileTurn, createTextProfile, followProductRelease, PROFILE_PROMPT_HISTORY_MAX, profileTools, proposeRevision,
  readProfileAdmission, switchProfile, ProfileConflictError, type ProfileRevision } from '../src/agent-profiles/index'

const PLAN = `sha256:${'a'.repeat(64)}`

/** node:sqlite behind the D1 shape, counting each round trip (one per run/first/all, one per batch). */
function d1(db: DatabaseSync) {
  const trips = { count: 0 }
  const statement = (sql: string, values: (string | number | null)[] = []): ProfileD1Statement & { exec(): { changes: number; rows: unknown[] } } => ({
    bind: (...next) => statement(sql, next),
    exec() {
      const prepared = db.prepare(sql)
      if (/^\s*(select|with)/i.test(sql)) return { changes: 0, rows: prepared.all(...(values as never[])) }
      const result = prepared.run(...(values as never[]))
      return { changes: Number(result.changes), rows: [] }
    },
    async first<T>() { trips.count++; return (db.prepare(sql).get(...(values as never[])) as T | undefined) ?? null },
    async all<T>() { trips.count++; return { results: db.prepare(sql).all(...(values as never[])) as T[] } },
    async run() { trips.count++; return { meta: { changes: Number(db.prepare(sql).run(...(values as never[])).changes) } } },
  })
  const database: ProfileD1Database = {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      trips.count++
      db.exec('BEGIN')
      try {
        const out = statements.map((s) => {
          const r = (s as ReturnType<typeof statement>).exec()
          return { meta: { changes: r.changes }, results: r.rows }
        })
        db.exec('COMMIT')
        return out
      } catch (error) { db.exec('ROLLBACK'); throw error }
    },
  }
  return { database, trips }
}

describe('profile turn pin', () => {
  it('pins once per message in one round trip, returns the same pin on retry, refuses a reused id', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(AGENT_PROFILE_D1_SCHEMA_SQL)
    const { database, trips } = d1(sqlite)
    const store = createD1ProfileRevisionStore(database)
    const key = { workspaceId: 'w1', memberId: 'm1', channel: 'chat' }
    const revision = await proposeRevision({ store, workspaceId: 'w1', profileId: 'director', expectedRevisionId: null,
      profile: { name: 'Director', prompt: { systemPrompt: 'You direct.' } }, knowledgeText: '', planDigest: PLAN,
      author: { kind: 'person', id: 'owner-1' }, actorRole: 'owner', reason: 'First profile' })
    const switched = await switchProfile({ store, key, messageId: 'switch-1', content: 'switch to Director',
      choice: { profileId: 'director' }, profiles: [{ id: 'director', name: 'Director', status: 'active' }],
      canSelect: async () => true, prepareAuthority: async () => ({ planDigest: PLAN, healthy: true, conflicts: [] }) })
    expect(switched.outcome).toBe('switched')

    const read = await readProfileAdmission(store, key, 'msg-1', 'Plan a launch')
    const before = trips.count
    const pin = await admitProfileTurn({ store, key, messageId: 'msg-1', content: 'Plan a launch', observedManagedPlanDigest: PLAN, read })
    // With the admission read, the active revision is the only read; the pin write and its read-back are one batch.
    expect(trips.count - before).toBe(2)
    expect(pin).toMatchObject({ messageId: 'msg-1', profileId: 'director', revisionId: revision.id })

    // A retry of the same message returns the same pin and writes nothing new.
    const again = await admitProfileTurn({ store, key, messageId: 'msg-1', content: 'Plan a launch', observedManagedPlanDigest: PLAN })
    expect(again).toEqual(pin)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM agent_profile_turn_pin').get()).toEqual({ n: 1 })

    // The same message id with different content is refused at the store.
    const binding = await store.getBinding(key)
    await expect(store.pinTurn({ ...pin, inputHash: `sha256:${'b'.repeat(64)}` }, binding!.version, { priorChecked: true }))
      .rejects.toBeInstanceOf(ProfileConflictError)
  })

  it.each([{ prior: false, cached: false }, { prior: false, cached: true }, { prior: true, cached: false },
    { prior: true, cached: true }])('refuses a dispatched revision mismatch before using or writing a pin ($prior, cached $cached)', async ({ prior, cached }) => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(AGENT_PROFILE_D1_SCHEMA_SQL)
    const { database } = d1(sqlite)
    const store = createD1ProfileRevisionStore(database)
    const key = { workspaceId: 'workspace', memberId: 'member', channel: 'chat' }
    try {
      const revision = await proposeRevision({ store, workspaceId: key.workspaceId, profileId: 'director', expectedRevisionId: null,
        profile: { name: 'Director', prompt: { systemPrompt: 'The revision whose bytes are dispatched.' } }, knowledgeText: '', planDigest: PLAN,
        author: { kind: 'person', id: 'owner' }, actorRole: 'owner', reason: 'Initial profile' })
      await switchProfile({ store, key, messageId: 'switch', content: 'switch profile', choice: { profileId: 'director' },
        profiles: [{ id: 'director', name: 'Director', status: 'active' }], canSelect: async () => true,
        prepareAuthority: async () => ({ planDigest: PLAN, healthy: true, conflicts: [] }) })
      const input = { store, key, messageId: 'message', content: 'Answer using the dispatched revision.', observedManagedPlanDigest: PLAN }
      if (prior) await admitProfileTurn(input)
      const read = cached ? await readProfileAdmission(store, key, input.messageId, input.content) : undefined
      await expect(admitProfileTurn({ ...input, read, expectedRevisionId: 'another-dispatched-revision' }))
        .rejects.toMatchObject({ name: 'ProfileConflictError', code: 'profile_changed' })
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM agent_profile_turn_pin').get()?.n).toBe(prior ? 1 : 0)
      const admitted = await admitProfileTurn({ ...input, expectedRevisionId: revision.id })
      expect(admitted.revisionId).toBe(revision.id)
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM agent_profile_turn_pin').get()?.n).toBe(1)
    } finally { sqlite.close() }
  })

  it('reports a stale binding version as a retryable conflict, not a raw constraint error', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(AGENT_PROFILE_D1_SCHEMA_SQL)
    const { database } = d1(sqlite)
    const store = createD1ProfileRevisionStore(database)
    const key = { workspaceId: 'workspace', memberId: 'member', channel: 'chat' }
    try {
      const revision = await proposeRevision({ store, workspaceId: key.workspaceId, profileId: 'director', expectedRevisionId: null,
        profile: { name: 'Director', prompt: { systemPrompt: 'You direct.' } }, knowledgeText: '', planDigest: PLAN,
        author: { kind: 'person', id: 'owner' }, actorRole: 'owner', reason: 'Initial profile' })
      // Another writer switches the binding to version 1 after this caller read version 0.
      await switchProfile({ store, key, messageId: 'switch-first', content: 'switch profile', choice: { profileId: 'director' },
        profiles: [{ id: 'director', name: 'Director', status: 'active' }], canSelect: async () => true,
        prepareAuthority: async () => ({ planDigest: PLAN, healthy: true, conflicts: [] }) })
      await expect(store.recordSwitch({
        key, messageId: 'switch-second', inputHash: `sha256:${'c'.repeat(64)}`, conversationId: null,
        profileId: 'director', revisionId: revision.id, pinnedRevisionId: revision.id,
        authorityDigest: null, planDigest: PLAN, outcome: 'switched', message: 'Switched to Director', conflicts: [],
      }, 0)).rejects.toMatchObject({ name: 'ProfileConflictError', message: 'Profile binding changed during switch' })
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM agent_profile_switch_receipt').get()?.n).toBe(1)
    } finally { sqlite.close() }
  })

  // Creative workspace 086e977d imported its prompt on 2026-11-13 and still ran it on 2026-11-15, two prompt
  // releases later ("Then halt and wait"); each app's import was the only time product text reached a workspace.
  it('runs the release prompt where the stored one is product text and keeps the text a person wrote', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(AGENT_PROFILE_D1_SCHEMA_SQL)
    const { database, trips } = d1(sqlite)
    const store = createD1ProfileRevisionStore(database)
    const releaseA: AgentProfile = { name: 'Director', prompt: { systemPrompt: 'Ask one question, then halt and wait.' } }
    const releaseB: AgentProfile = { name: 'Director', prompt: { systemPrompt: 'Deliver the ask first.' } }
    const ownText: AgentProfile = { ...releaseA, prompt: { systemPrompt: 'Always cite the brief.' } }
    const write = (workspaceId: string, parent: ProfileRevision | null, profile: AgentProfile, authorId: string) =>
      proposeRevision({ store, workspaceId, profileId: 'director', expectedRevisionId: parent?.id ?? null, profile,
        knowledgeText: '', planDigest: PLAN, author: { kind: 'person', id: authorId }, actorRole: 'owner', reason: 'Step' })
    // A fresh id list per call, as an adopter writing it inline would pass.
    const run = (revision: ProfileRevision) => followProductRelease(store, revision, releaseB, ['app-release'])
    try {
      const untouched = await write('untouched', null, releaseA, 'app-release')
      // A person renamed it; the prompt is still the one release A shipped.
      const renamed = await write('renamed', await write('renamed', null, releaseA, 'app-release'), { ...releaseA, name: 'Mine' }, 'member')
      // A person wrote their own prompt, and a later product step carried it forward unchanged.
      const edited = await write('edited', await write('edited', null, releaseA, 'app-release'), ownText, 'member')
      const carried = await write('edited', edited, { ...ownText, description: 'Carried' }, 'app-release')
      // A product revision whose parent row is gone proves nothing about its text.
      const orphan = { ...untouched, id: crypto.randomUUID(), workspaceId: 'orphaned', parentId: 'gone' }
      expect(await store.appendRevision(orphan, null, true)).toBe(true)
      // Fifty remembered facts on top of the import: the prompt is still release A's.
      let remembered = await write('remembered', null, releaseA, 'app-release')
      for (let fact = 1; fact < 50; fact++) remembered = await write('remembered', remembered, { ...releaseA, description: `Fact ${fact}` }, 'member')

      expect((await run(untouched)).prompt?.systemPrompt).toBe('Deliver the ask first.')
      expect(await run(renamed)).toMatchObject({ name: 'Mine', prompt: { systemPrompt: 'Deliver the ask first.' } })
      expect((await run(edited)).prompt?.systemPrompt).toBe('Always cite the brief.')
      expect((await run(carried)).prompt?.systemPrompt).toBe('Always cite the brief.')
      expect((await run(orphan)).prompt?.systemPrompt).toBe('Ask one question, then halt and wait.')
      const beforeChain = trips.count
      expect((await run(remembered)).prompt?.systemPrompt).toBe('Deliver the ask first.')
      expect(trips.count - beforeChain).toBeLessThanOrEqual(2)
      // Nothing stored changed, and a revision's history is read once per isolate.
      expect((await store.getActiveRevision('untouched', 'director'))?.profile.prompt?.systemPrompt).toBe('Ask one question, then halt and wait.')
      const before = trips.count
      await run(renamed)
      await run(carried)
      await run(remembered)
      expect(trips.count).toBe(before)
    } finally { sqlite.close() }
  })

  it(`reads a ${PROFILE_PROMPT_HISTORY_MAX}-revision history of 20 KB prompts in one round trip and keeps the prompt of a longer one`, async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(AGENT_PROFILE_D1_SCHEMA_SQL)
    const { database, trips } = d1(sqlite)
    const store = createD1ProfileRevisionStore(database)
    const shipped = `Ask one question, then halt and wait. ${'x'.repeat(20_000)}`
    const release: AgentProfile = { name: 'Director', prompt: { systemPrompt: 'Deliver the ask first.' } }
    const insert = sqlite.prepare(`INSERT INTO agent_profile_revision (revision_id, workspace_id, profile_id, parent_id,
      profile_json, knowledge_text, author_kind, author_id, reason, diff_json, authority_digest, plan_digest, state, created_at)
      VALUES (?, 'long', 'director', ?, ?, '', 'person', ?, 'Step', '[]', ?, ?, 'active', ?)`)
    // Fresh ids each run: answers are cached per revision for the isolate, and a retry must read again.
    const run = crypto.randomUUID()
    const id = (n: number) => `${run}-${n}`
    try {
      // An import, then a remembered fact per revision; revision n has n + 1 revisions of history.
      for (let n = 0; n <= PROFILE_PROMPT_HISTORY_MAX; n++) {
        insert.run(id(n), n ? id(n - 1) : null, JSON.stringify({ name: 'Director', description: `Fact ${n}`,
          prompt: { systemPrompt: shipped } }), n ? 'member' : 'app-release', PLAN, PLAN, n)
      }
      const bounded = await store.getRevision('long', 'director', id(PROFILE_PROMPT_HISTORY_MAX - 1))
      const longer = await store.getRevision('long', 'director', id(PROFILE_PROMPT_HISTORY_MAX))
      const before = trips.count
      expect((await followProductRelease(store, bounded!, release, ['app-release'])).prompt?.systemPrompt).toBe('Deliver the ask first.')
      expect(trips.count - before).toBe(1)
      // One more revision cuts the read before the import, so nothing shows the prompt is the product's.
      expect((await followProductRelease(store, longer!, release, ['app-release'])).prompt?.systemPrompt).toBe(shipped)
    } finally { sqlite.close() }
  })

  // Before this, profile.read showed the stored import-day prompt while the turn ran the release's, so an agent's
  // self-edit stored the old product text as its own and the profile stopped following releases.
  it('reads, edits and copies the text a turn runs, and an edit that keeps the shown prompt keeps following', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(AGENT_PROFILE_D1_SCHEMA_SQL)
    const store = createD1ProfileRevisionStore(d1(sqlite).database)
    const workspaceId = `tools-${crypto.randomUUID()}`
    const prompt = (systemPrompt: string): AgentProfile => ({ name: 'Director', prompt: { systemPrompt } })
    let release = prompt('Deliver the ask first.')
    const followRelease = (revision: ProfileRevision) => followProductRelease(store, revision, release, ['app-release'])
    try {
      const imported = await proposeRevision({ store, workspaceId, profileId: 'director', expectedRevisionId: null,
        profile: prompt('Ask one question, then halt and wait.'), knowledgeText: '', planDigest: PLAN,
        author: { kind: 'person', id: 'app-release' }, actorRole: 'owner', reason: 'Import' })
      const tools = profileTools({ store, followRelease, planDigest: async () => PLAN,
        activeTurn: async () => ({ workspaceId, profileId: 'director', revisionId: imported.id, memberId: 'owner', role: 'owner' as const }) })
      const run = (name: string, args: object) =>
        tools.find(tool => tool.name === name)!.run(args as never, {} as never) as Promise<Record<string, unknown>>

      const read = await run('profile.read', {})
      expect(read.systemPrompt).toBe('Deliver the ask first.')
      // The agent hands back the prompt it read with a new instruction: the stored prompt stays the import's.
      const updated = await run('profile.update', { expectedRevisionId: read.revisionId,
        changes: { systemPrompt: read.systemPrompt, instructions: ['Keep answers short.'] } })
      const edited = await store.getRevision(workspaceId, 'director', updated.revisionId as string)
      expect(edited?.profile.prompt).toEqual({ systemPrompt: 'Ask one question, then halt and wait.', instructions: ['Keep answers short.'] })
      // So the next release still reaches it.
      release = prompt('Deliver the ask, then offer one next step.')
      expect((await followRelease(edited!)).prompt?.systemPrompt).toBe('Deliver the ask, then offer one next step.')

      // A custom profile stores no prompt, so it runs the product's current one at this release and every later one.
      const custom = await createTextProfile({ store, workspaceId, baselineProfileId: 'director', existingProfiles: [{ name: 'Director' }],
        name: 'Brief', instructions: 'One paragraph.', authorId: 'owner', actorRole: 'owner', planDigest: () => PLAN, followRelease })
      expect(custom.profile.prompt).toEqual({ instructions: ['Keep answers short.', 'One paragraph.'] })
      expect((await followRelease(custom)).prompt?.systemPrompt).toBe('Deliver the ask, then offer one next step.')
      release = prompt('Deliver the ask with its sources.')
      expect((await followRelease(custom)).prompt?.systemPrompt).toBe('Deliver the ask with its sources.')
    } finally { sqlite.close() }
  })
})
