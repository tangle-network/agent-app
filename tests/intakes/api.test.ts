import { describe, it, expect } from 'vitest'
import { createIntakeTables } from '../../src/intakes/drizzle/schema'
import { createUserIntakeStore } from '../../src/intakes/drizzle/store'
import { createIntakeApi } from '../../src/intakes/api'
import { openDatabase, usersTable, workspacesTable } from './db-helper'
import { onboardingGraph } from './fixtures'

const tables = createIntakeTables({ userTable: usersTable, workspaceTable: workspacesTable })

async function api() {
  const db = openDatabase([usersTable, workspacesTable, tables.userIntake, tables.projectIntake])
  await db.insert(usersTable).values({ id: 'u1', name: 'U', email: 'u@x.com' })
  const store = createUserIntakeStore({ db, table: tables.userIntake, graph: onboardingGraph, userId: 'u1' })
  return createIntakeApi({ store, graph: onboardingGraph })
}

describe('getCurrentIntake', () => {
  it('returns the title, the first next question, and zeroed progress', async () => {
    const res = await (await api()).getCurrentIntake()
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.title).toBe('Welcome')
    expect(body.nextQuestion.id).toBe('name')
    expect(body.completed).toBe(false)
    expect(body.progress).toEqual({ answered: 0, total: 2 })
  })
})

describe('saveAnswer', () => {
  it('persists an answer and returns the NEXT question + progress', async () => {
    const a = await api()
    const res = await a.saveAnswer({ questionId: 'name', value: 'Ada' })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.answers).toEqual({ name: 'Ada' })
    expect(body.nextQuestion.id).toBe('role')
    expect(body.progress).toEqual({ answered: 1, total: 2 })
  })

  it('400 on a missing questionId', async () => {
    const res = await (await api()).saveAnswer({})
    expect(res.status).toBe(400)
  })

  it('400 + code on an invalid answer', async () => {
    const res = await (await api()).saveAnswer({ questionId: 'role', value: 'bogus' })
    expect(res.status).toBe(400)
    expect((await res.json() as any).code).toBe('invalid-answer')
  })

  it('404 on an unknown question', async () => {
    const res = await (await api()).saveAnswer({ questionId: 'nope', value: 'x' })
    expect(res.status).toBe(404)
    expect((await res.json() as any).code).toBe('unknown-question')
  })
})

describe('completeIntake', () => {
  it('409 + incomplete code when required questions remain', async () => {
    const a = await api()
    await a.saveAnswer({ questionId: 'name', value: 'Ada' })
    const res = await a.completeIntake()
    expect(res.status).toBe(409)
    expect((await res.json() as any).code).toBe('incomplete')
  })

  it('200 + completed view once all required questions are answered', async () => {
    const a = await api()
    await a.saveAnswer({ questionId: 'name', value: 'Ada' })
    await a.saveAnswer({ questionId: 'role', value: 'founder' })
    const res = await a.completeIntake()
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.completed).toBe(true)
    expect(body.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(body.nextQuestion).toBeNull()
  })
})
