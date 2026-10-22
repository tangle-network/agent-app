/**
 * A turn's profile pin over a real SQLite database behind the D1 surface: `admitProfileTurn` pins the member's
 * bound revision once per message, a retry of the same message returns the same pin, a reused message id with
 * different content is refused, and the pin write is one round trip. Creative paid four serial ~76 ms D1 round
 * trips per turn here (production, 2026-10-22); the pre-read and the separate read-back were two of them.
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { AGENT_PROFILE_D1_SCHEMA_SQL, createD1ProfileRevisionStore, type ProfileD1Database, type ProfileD1Statement } from '../src/agent-profiles/d1'
import { admitProfileTurn, proposeRevision, readProfileAdmission, switchProfile, ProfileConflictError } from '../src/agent-profiles/index'

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
    await expect(store.pinTurn({ ...pin, inputHash: `sha256:${'b'.repeat(64)}` }, switched.bindingVersion ?? 1, { priorChecked: true }))
      .rejects.toBeInstanceOf(ProfileConflictError)
  })
})
