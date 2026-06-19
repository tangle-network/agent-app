import { describe, it, expect } from 'vitest'
import { createIntakeTables } from '../../src/intakes/drizzle/schema'
import {
  IntakeError,
  createProjectIntakeStore,
  createUserIntakeStore,
} from '../../src/intakes/drizzle/store'
import { openDatabase, usersTable, workspacesTable } from './db-helper'
import { onboardingGraph, projectGraph } from './fixtures'

const tables = createIntakeTables({ userTable: usersTable, workspaceTable: workspacesTable })

function setup() {
  const db = openDatabase([usersTable, workspacesTable, tables.userIntake, tables.projectIntake])
  return { db }
}

describe('createUserIntakeStore (per-user onboarding)', () => {
  async function store(db: ReturnType<typeof setup>['db']) {
    await db.insert(usersTable).values({ id: 'u1', name: 'U', email: 'u@x.com' })
    return createUserIntakeStore({ db, table: tables.userIntake, graph: onboardingGraph, userId: 'u1' })
  }

  it('get seeds an empty payload when no row exists', async () => {
    const { db } = setup()
    const s = await store(db)
    const state = await s.get()
    expect(state.payload).toEqual({ graphId: 'user-onboarding-v1', answers: {} })
    expect(state.completed).toBe(false)
    expect(state.completedAt).toBeNull()
  })

  it('save validates and persists an answer (insert then update)', async () => {
    const { db } = setup()
    const s = await store(db)
    const afterName = await s.save('name', 'Ada')
    expect(afterName.payload.answers).toEqual({ name: 'Ada' })
    const afterRole = await s.save('role', 'founder')
    expect(afterRole.payload.answers).toEqual({ name: 'Ada', role: 'founder' })
    const rows = await db.select().from(tables.userIntake)
    expect(rows).toHaveLength(1)
  })

  it('save refuses an invalid answer with a typed IntakeError', async () => {
    const { db } = setup()
    const s = await store(db)
    await expect(s.save('role', 'not-an-option')).rejects.toMatchObject({ code: 'invalid-answer' })
    await expect(s.save('nope', 'x')).rejects.toMatchObject({ code: 'unknown-question' })
    // nothing was written for the rejected save
    expect(await db.select().from(tables.userIntake)).toHaveLength(0)
  })

  it('complete refuses an incomplete intake (incomplete) and stamps a complete one', async () => {
    const { db } = setup()
    const s = await store(db)
    await s.save('name', 'Ada')
    await expect(s.complete()).rejects.toBeInstanceOf(IntakeError)
    await expect(s.complete()).rejects.toMatchObject({ code: 'incomplete' })

    await s.save('role', 'founder')
    const done = await s.complete()
    expect(done.completed).toBe(true)
    expect(done.completedAt).toBeInstanceOf(Date)

    const reloaded = await s.get()
    expect(reloaded.completed).toBe(true)
    expect(reloaded.completedAt).toBeInstanceOf(Date)
  })

  it('two users keep separate onboarding payloads', async () => {
    const { db } = setup()
    await db.insert(usersTable).values([
      { id: 'u1', name: 'One', email: 'one@x.com' },
      { id: 'u2', name: 'Two', email: 'two@x.com' },
    ])
    const s1 = createUserIntakeStore({ db, table: tables.userIntake, graph: onboardingGraph, userId: 'u1' })
    const s2 = createUserIntakeStore({ db, table: tables.userIntake, graph: onboardingGraph, userId: 'u2' })
    await s1.save('name', 'One')
    await s2.save('name', 'Two')
    expect((await s1.get()).payload.answers).toEqual({ name: 'One' })
    expect((await s2.get()).payload.answers).toEqual({ name: 'Two' })
  })
})

describe('createProjectIntakeStore (per-project intake)', () => {
  async function store(db: ReturnType<typeof setup>['db'], workspaceId = 'ws1') {
    await db.insert(workspacesTable).values({ id: workspaceId, organizationId: 'o', name: 'WS' }).onConflictDoNothing()
    return createProjectIntakeStore({ db, table: tables.projectIntake, graph: projectGraph, workspaceId })
  }

  it('walks the branching graph through save → complete', async () => {
    const { db } = setup()
    const s = await store(db)
    await s.save('has_site', false)
    const mid = await s.get()
    expect(mid.completed).toBe(false)
    await s.save('goals', ['leads'])
    const done = await s.complete()
    expect(done.completed).toBe(true)
  })

  it('refuses complete when the branch leaves a required question open', async () => {
    const { db } = setup()
    const s = await store(db)
    await s.save('has_site', true) // now site_url is required
    await s.save('goals', ['leads'])
    await expect(s.complete()).rejects.toMatchObject({ code: 'incomplete' })
    await s.save('site_url', 'https://example.com')
    expect((await s.complete()).completed).toBe(true)
  })

  it('scopes by workspaceId — a second workspace is independent', async () => {
    const { db } = setup()
    const a = await store(db, 'ws-a')
    const b = await store(db, 'ws-b')
    await a.save('has_site', false)
    expect((await b.get()).payload.answers).toEqual({})
  })
})
