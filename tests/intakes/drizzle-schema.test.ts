import { describe, it, expect } from 'vitest'
import { eq, getTableName } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { createIntakeTables } from '../../src/intakes/drizzle/schema'
import { openDatabase, usersTable, workspacesTable } from './db-helper'

/** Find the FK on `table.localColumn` and return its referenced table+column+onDelete. */
function fkFor(table: Parameters<typeof getTableConfig>[0], localColumn: string) {
  const config = getTableConfig(table)
  for (const fk of config.foreignKeys) {
    const ref = fk.reference()
    if (ref.columns.some((c) => c.name === localColumn)) {
      return {
        foreignTable: getTableName(ref.foreignTable),
        foreignColumn: ref.foreignColumns[0]?.name,
        onDelete: fk.onDelete,
      }
    }
  }
  return null
}

describe('createIntakeTables — WITH a workspace table', () => {
  const tables = createIntakeTables({ userTable: usersTable, workspaceTable: workspacesTable })

  it('produces user_intake and project_intake', () => {
    expect(getTableName(tables.userIntake)).toBe('user_intake')
    expect(getTableName(tables.projectIntake)).toBe('project_intake')
  })

  it('user_intake.user_id → the passed user table (cascade)', () => {
    expect(fkFor(tables.userIntake, 'user_id')).toEqual({ foreignTable: 'user', foreignColumn: 'id', onDelete: 'cascade' })
  })

  it('project_intake.workspace_id → the passed workspace table (cascade)', () => {
    expect(fkFor(tables.projectIntake, 'workspace_id')).toEqual({ foreignTable: 'workspace', foreignColumn: 'id', onDelete: 'cascade' })
  })

  it('applies id/payload defaults and a null completedAt on insert', async () => {
    const db = openDatabase([usersTable, workspacesTable, tables.userIntake, tables.projectIntake])
    await db.insert(usersTable).values({ id: 'u1', name: 'U', email: 'u@x.com' })
    const [row] = await db.insert(tables.userIntake).values({ userId: 'u1', graphId: 'g1', payload: { graphId: 'g1', answers: {} } }).returning()
    expect(row!.id).toMatch(/^[0-9a-f]{32}$/)
    expect(row!.completedAt).toBeNull()
    expect(row!.createdAt).toBeInstanceOf(Date)
    expect(row!.payload).toEqual({ graphId: 'g1', answers: {} })
  })

  it('enforces one user_intake per user (unique userId)', async () => {
    const db = openDatabase([usersTable, workspacesTable, tables.userIntake, tables.projectIntake])
    await db.insert(usersTable).values({ id: 'u1', name: 'U', email: 'u@x.com' })
    await db.insert(tables.userIntake).values({ userId: 'u1', graphId: 'g1', payload: { graphId: 'g1', answers: {} } })
    await expect(
      db.insert(tables.userIntake).values({ userId: 'u1', graphId: 'g1', payload: { graphId: 'g1', answers: {} } }),
    ).rejects.toThrow()
  })

  it('enforces one project_intake per workspace (unique workspaceId)', async () => {
    const db = openDatabase([usersTable, workspacesTable, tables.userIntake, tables.projectIntake])
    await db.insert(workspacesTable).values({ id: 'ws1', organizationId: 'o', name: 'WS' })
    await db.insert(tables.projectIntake).values({ workspaceId: 'ws1', graphId: 'g1', payload: { graphId: 'g1', answers: {} } })
    await expect(
      db.insert(tables.projectIntake).values({ workspaceId: 'ws1', graphId: 'g1', payload: { graphId: 'g1', answers: {} } }),
    ).rejects.toThrow()
  })

  it('cascades user_intake deletion when the user is deleted', async () => {
    const db = openDatabase([usersTable, workspacesTable, tables.userIntake, tables.projectIntake])
    await db.insert(usersTable).values({ id: 'u1', name: 'U', email: 'u@x.com' })
    await db.insert(tables.userIntake).values({ userId: 'u1', graphId: 'g1', payload: { graphId: 'g1', answers: {} } })
    expect(await db.select().from(tables.userIntake)).toHaveLength(1)
    await db.delete(usersTable).where(eq(usersTable.id, 'u1'))
    expect(await db.select().from(tables.userIntake)).toHaveLength(0)
  })

  it('cascades project_intake deletion when the workspace is deleted', async () => {
    const db = openDatabase([usersTable, workspacesTable, tables.userIntake, tables.projectIntake])
    await db.insert(workspacesTable).values({ id: 'ws1', organizationId: 'o', name: 'WS' })
    await db.insert(tables.projectIntake).values({ workspaceId: 'ws1', graphId: 'g1', payload: { graphId: 'g1', answers: {} } })
    expect(await db.select().from(tables.projectIntake)).toHaveLength(1)
    await db.delete(workspacesTable).where(eq(workspacesTable.id, 'ws1'))
    expect(await db.select().from(tables.projectIntake)).toHaveLength(0)
  })
})

describe('createIntakeTables — WITHOUT a workspace table (single-user / non-workspace app)', () => {
  const tables = createIntakeTables({ userTable: usersTable })

  it('returns user_intake and NO project_intake', () => {
    expect(getTableName(tables.userIntake)).toBe('user_intake')
    expect(tables.projectIntake).toBeUndefined()
  })

  it('per-user onboarding works with zero workspace concept', async () => {
    const db = openDatabase([usersTable, tables.userIntake])
    await db.insert(usersTable).values({ id: 'solo', name: 'Solo', email: 'solo@x.com' })
    const [row] = await db.insert(tables.userIntake).values({ userId: 'solo', graphId: 'g1', payload: { graphId: 'g1', answers: { name: 'Solo' } } }).returning()
    expect(row!.userId).toBe('solo')
    expect(row!.payload).toEqual({ graphId: 'g1', answers: { name: 'Solo' } })
  })

  it('still cascades on user delete', async () => {
    const db = openDatabase([usersTable, tables.userIntake])
    await db.insert(usersTable).values({ id: 'solo', name: 'Solo', email: 'solo@x.com' })
    await db.insert(tables.userIntake).values({ userId: 'solo', graphId: 'g1', payload: { graphId: 'g1', answers: {} } })
    await db.delete(usersTable).where(eq(usersTable.id, 'solo'))
    expect(await db.select().from(tables.userIntake)).toHaveLength(0)
  })
})
