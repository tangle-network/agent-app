import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { foreignKey, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { EnrollmentTargetError, type AgentEnrollmentClaim } from './index'
import { createDrizzleAgentEnrollmentStore } from './drizzle'

const instanceClaims = sqliteTable('agent_enrollment_instance_claim', {
  ownerScope: text('owner_scope').notNull(),
  instanceKey: text('instance_key').notNull(),
  profileVersion: text('profile_version').notNull(),
  configurationDigest: text('configuration_digest').notNull(),
}, table => [primaryKey({ columns: [table.ownerScope, table.instanceKey] })])

const enrollments = sqliteTable('agent_enrollment_claim', {
  enrollmentId: text('enrollment_id').primaryKey(),
  ownerScope: text('owner_scope').notNull(),
  agentId: text('agent_id').notNull(),
  workspaceId: text('workspace_id').notNull(),
  threadId: text('thread_id').notNull(),
  instanceKey: text('instance_key').notNull(),
  profileVersion: text('profile_version').notNull(),
  configurationDigest: text('configuration_digest').notNull(),
  generation: integer('generation'),
  sandboxId: text('sandbox_id'),
  filesystemIncarnationId: text('filesystem_incarnation_id'),
  sessionId: text('session_id'),
}, table => [foreignKey({
  columns: [table.ownerScope, table.instanceKey],
  foreignColumns: [instanceClaims.ownerScope, instanceClaims.instanceKey],
}).onDelete('restrict')])

const ddl = `
CREATE TABLE agent_enrollment_instance_claim (
  owner_scope TEXT NOT NULL,
  instance_key TEXT NOT NULL,
  profile_version TEXT NOT NULL,
  configuration_digest TEXT NOT NULL,
  PRIMARY KEY (owner_scope, instance_key)
);
CREATE TABLE agent_enrollment_claim (
  enrollment_id TEXT PRIMARY KEY NOT NULL,
  owner_scope TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  instance_key TEXT NOT NULL,
  profile_version TEXT NOT NULL,
  configuration_digest TEXT NOT NULL,
  generation INTEGER,
  sandbox_id TEXT,
  filesystem_incarnation_id TEXT,
  session_id TEXT,
  CHECK (generation IS NULL AND sandbox_id IS NULL AND filesystem_incarnation_id IS NULL AND session_id IS NULL
    OR generation > 0 AND sandbox_id IS NOT NULL AND filesystem_incarnation_id IS NOT NULL AND session_id IS NOT NULL),
  FOREIGN KEY (owner_scope, instance_key)
    REFERENCES agent_enrollment_instance_claim(owner_scope, instance_key) ON DELETE RESTRICT
);
CREATE TRIGGER immutable_instance_claim BEFORE UPDATE ON agent_enrollment_instance_claim
BEGIN SELECT RAISE(ABORT, 'immutable_instance_claim'); END;
CREATE TRIGGER immutable_enrollment_claim BEFORE UPDATE ON agent_enrollment_claim
WHEN OLD.generation IS NOT NULL
  OR NEW.enrollment_id <> OLD.enrollment_id OR NEW.owner_scope <> OLD.owner_scope
  OR NEW.agent_id <> OLD.agent_id OR NEW.workspace_id <> OLD.workspace_id
  OR NEW.thread_id <> OLD.thread_id OR NEW.instance_key <> OLD.instance_key
  OR NEW.profile_version <> OLD.profile_version
  OR NEW.configuration_digest <> OLD.configuration_digest
BEGIN SELECT RAISE(ABORT, 'immutable_enrollment_claim'); END;
`

const claim: AgentEnrollmentClaim = {
  enrollmentId: 'enrollment-1', agentId: 'agent-1', workspaceId: 'workspace-1',
  threadId: 'thread-1', instanceKey: 'agent:1', profileVersion: 'v1',
  configurationDigest: 'digest-1',
}

const target = {
  ...claim, generation: 1, sandboxId: 'sandbox-1',
  filesystemIncarnationId: 'incarnation-1', sessionId: 'session-1',
}

const databases: Database.Database[] = []
afterEach(() => databases.splice(0).forEach(database => database.close()))

function fixture() {
  const sqlite = new Database(':memory:')
  databases.push(sqlite)
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(ddl)
  const base = drizzle(sqlite)
  // The actual Drizzle statements run inside SQLite's transaction. This
  // provides D1 batch semantics without replacing the database with a mock.
  const db = new Proxy(base, {
    get(value, property, receiver) {
      if (property === 'batch') {
        return async (statements: [{ run(): unknown }, ...Array<{ run(): unknown }>]) =>
          sqlite.transaction(() => statements.map(statement => statement.run()))()
      }
      const member = Reflect.get(value, property, receiver)
      return typeof member === 'function' ? member.bind(value) : member
    },
  }) as typeof base & { batch(statements: [unknown, ...unknown[]]): Promise<unknown[]> }
  const store = (ownerScope = 'owner-1') => createDrizzleAgentEnrollmentStore({
    db, instanceClaims, enrollments, ownerScope,
  })
  const count = (table: string): number =>
    (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
  return { sqlite, db, store, count }
}

describe('Drizzle agent enrollment store', () => {
  it('reserves one instance and commits an immutable target under its exact claim', async () => {
    const f = fixture()
    const store = f.store()
    expect(await store.claimIfAbsent(claim)).toEqual(claim)
    expect(await store.get(claim.enrollmentId)).toBeNull()
    expect(await store.insertIfAbsent(target)).toEqual(target)
    expect(await store.get(claim.enrollmentId)).toEqual(target)
    expect(await store.insertIfAbsent({ ...target, sandboxId: 'other' })).toEqual(target)
    expect(() => f.sqlite.prepare('UPDATE agent_enrollment_claim SET sandbox_id = ?').run('other'))
      .toThrow('immutable_enrollment_claim')
    expect(f.count('agent_enrollment_instance_claim')).toBe(1)
    expect(f.count('agent_enrollment_claim')).toBe(1)
  })

  it('keeps a partial target and a changed reservation out of durable state', async () => {
    const f = fixture()
    const store = f.store()
    await store.claimIfAbsent(claim)
    expect(() => f.sqlite.prepare('UPDATE agent_enrollment_claim SET generation = 1').run())
      .toThrow('CHECK constraint failed')
    expect(() => f.sqlite.prepare('UPDATE agent_enrollment_instance_claim SET configuration_digest = ?')
      .run('other')).toThrow('immutable_instance_claim')
    expect(await store.get(claim.enrollmentId)).toBeNull()
  })

  it('shares the same owner instance and config across independent thread enrollments', async () => {
    const f = fixture()
    const store = f.store()
    const second = { ...claim, enrollmentId: 'enrollment-2', threadId: 'thread-2' }
    expect(await Promise.all([store.claimIfAbsent(claim), store.claimIfAbsent(second)]))
      .toEqual([claim, second])
    expect(await store.insertIfAbsent(target)).toEqual(target)
    const secondTarget = { ...target, ...second, sessionId: 'session-2' }
    expect(await store.insertIfAbsent(secondTarget)).toEqual(secondTarget)
    expect(f.count('agent_enrollment_instance_claim')).toBe(1)
    expect(f.count('agent_enrollment_claim')).toBe(2)
  })

  it('rejects another config for an owner instance without leaving a second enrollment', async () => {
    const f = fixture()
    const store = f.store()
    await store.claimIfAbsent(claim)
    await expect(store.claimIfAbsent({ ...claim, enrollmentId: 'enrollment-2',
      configurationDigest: 'digest-2' })).rejects.toMatchObject({ code: 'conflict' })
    expect(f.count('agent_enrollment_instance_claim')).toBe(1)
    expect(f.count('agent_enrollment_claim')).toBe(1)
    const otherOwner = f.store('owner-2')
    const otherClaim = { ...claim, enrollmentId: 'enrollment-3', configurationDigest: 'digest-2' }
    expect(await otherOwner.claimIfAbsent(otherClaim)).toEqual(otherClaim)
    expect(await store.get(otherClaim.enrollmentId)).toBeNull()
  })

  it('returns the enrollment ID winner and removes a losing instance reservation', async () => {
    const f = fixture()
    const store = f.store()
    await store.claimIfAbsent(claim)
    expect(await store.claimIfAbsent({ ...claim, instanceKey: 'agent:loser' })).toEqual(claim)
    expect(f.sqlite.prepare('SELECT instance_key FROM agent_enrollment_instance_claim').all())
      .toEqual([{ instance_key: claim.instanceKey }])
    await expect(f.store('other-owner').claimIfAbsent({ ...claim,
      instanceKey: 'agent:other' })).rejects.toMatchObject({ code: 'conflict' })
    expect(f.count('agent_enrollment_instance_claim')).toBe(1)
  })

  it('does not commit a target without the owner and full matching claim', async () => {
    const f = fixture()
    const store = f.store()
    await expect(store.insertIfAbsent(target)).rejects.toMatchObject({ code: 'conflict' })
    await store.claimIfAbsent(claim)
    for (const changed of [
      { ...target, agentId: 'other-agent' },
      { ...target, configurationDigest: 'other-digest' },
      { ...target, sessionId: 'other-session', instanceKey: 'other-key' },
    ]) {
      await expect(store.insertIfAbsent(changed)).rejects.toMatchObject({ code: 'conflict' })
    }
    await expect(f.store('other-owner').insertIfAbsent(target))
      .rejects.toMatchObject({ code: 'conflict' })
    expect(await store.get(claim.enrollmentId)).toBeNull()
  })

  it('rolls back a reservation when a host authorization trigger rejects the enrollment', async () => {
    const f = fixture()
    f.sqlite.exec(`CREATE TRIGGER host_reject BEFORE INSERT ON agent_enrollment_claim
      WHEN NEW.agent_id = 'blocked' BEGIN SELECT RAISE(ABORT, 'host_reject'); END;`)
    await expect(f.store().claimIfAbsent({ ...claim, agentId: 'blocked' }))
      .rejects.toThrow('host_reject')
    expect(f.count('agent_enrollment_instance_claim')).toBe(0)
    expect(f.count('agent_enrollment_claim')).toBe(0)
  })

  it('converges competing instance configs and enrollment IDs on SQLite winners', async () => {
    const f = fixture()
    const store = f.store()
    const competing = await Promise.allSettled([
      store.claimIfAbsent(claim),
      store.claimIfAbsent({ ...claim, enrollmentId: 'enrollment-2', configurationDigest: 'digest-2' }),
    ])
    expect(competing.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(competing.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(f.count('agent_enrollment_instance_claim')).toBe(1)
    expect(f.count('agent_enrollment_claim')).toBe(1)

    const sameId = await Promise.allSettled([
      store.claimIfAbsent({ ...claim, enrollmentId: 'enrollment-3', instanceKey: 'agent:3' }),
      store.claimIfAbsent({ ...claim, enrollmentId: 'enrollment-3', instanceKey: 'agent:4' }),
    ])
    expect(sameId).toHaveLength(2)
    expect(sameId.every(result => result.status === 'fulfilled')).toBe(true)
    if (sameId[0]?.status === 'fulfilled' && sameId[1]?.status === 'fulfilled') {
      expect(sameId[0].value).toEqual(sameId[1].value)
    }
    const rows = f.sqlite.prepare('SELECT instance_key FROM agent_enrollment_instance_claim').all()
    expect(rows).toHaveLength(2)
  })

  it('keeps the first target when conditional commits race', async () => {
    const f = fixture()
    const store = f.store()
    await store.claimIfAbsent(claim)
    const results = await Promise.all([
      store.insertIfAbsent(target),
      store.insertIfAbsent({ ...target, sandboxId: 'sandbox-2' }),
    ])
    expect(results[0]).toEqual(results[1])
    expect(await store.get(claim.enrollmentId)).toEqual(results[0])
    expect(f.count('agent_enrollment_claim')).toBe(1)
  })

  it('requires a D1 batch before accepting a claim', async () => {
    const f = fixture()
    const withoutBatch = createDrizzleAgentEnrollmentStore({
      db: drizzle(f.sqlite), instanceClaims, enrollments, ownerScope: 'owner-1',
    })
    await expect(withoutBatch.claimIfAbsent(claim)).rejects.toThrow('atomic Drizzle D1 batch')
    expect(() => f.store('')).toThrow(EnrollmentTargetError)
  })
})
