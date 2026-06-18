import { describe, it, expect } from 'vitest'
import { eq, getTableName } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { createTeamTables } from '../../src/teams/drizzle/schema'
import { openDatabase, usersTable, workspacesTable } from './db-helper'

const tables = createTeamTables({ userTable: usersTable, workspaceTable: workspacesTable })

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

describe('createTeamTables — table shapes', () => {
  it('produces organization, organization_member, workspace_member', () => {
    expect(getTableName(tables.organizations)).toBe('organization')
    expect(getTableName(tables.organizationMembers)).toBe('organization_member')
    expect(getTableName(tables.workspaceMembers)).toBe('workspace_member')
  })
})

describe('createTeamTables — foreign keys reference the PASSED-IN tables', () => {
  it('organization.created_by → the passed user table (cascade)', () => {
    const fk = fkFor(tables.organizations, 'created_by')
    expect(fk).toEqual({ foreignTable: 'user', foreignColumn: 'id', onDelete: 'cascade' })
  })

  it('organization_member.user_id → the passed user table (cascade)', () => {
    const fk = fkFor(tables.organizationMembers, 'user_id')
    expect(fk).toEqual({ foreignTable: 'user', foreignColumn: 'id', onDelete: 'cascade' })
  })

  it('organization_member.organization_id → organization (cascade)', () => {
    const fk = fkFor(tables.organizationMembers, 'organization_id')
    expect(fk).toEqual({ foreignTable: 'organization', foreignColumn: 'id', onDelete: 'cascade' })
  })

  it('workspace_member.workspace_id → the passed workspace table (cascade)', () => {
    const fk = fkFor(tables.workspaceMembers, 'workspace_id')
    expect(fk).toEqual({ foreignTable: 'workspace', foreignColumn: 'id', onDelete: 'cascade' })
  })

  it('workspace_member.organization_member_id → organization_member (cascade)', () => {
    const fk = fkFor(tables.workspaceMembers, 'organization_member_id')
    expect(fk).toEqual({ foreignTable: 'organization_member', foreignColumn: 'id', onDelete: 'cascade' })
  })

  it('workspace_member.user_id → the passed user table (cascade)', () => {
    const fk = fkFor(tables.workspaceMembers, 'user_id')
    expect(fk).toEqual({ foreignTable: 'user', foreignColumn: 'id', onDelete: 'cascade' })
  })
})

describe('createTeamTables — defaults, enums, and indexes at runtime', () => {
  it('applies id/kind/role defaults on insert', async () => {
    const db = openDatabase([usersTable, workspacesTable, tables.organizations, tables.organizationMembers, tables.workspaceMembers])
    await db.insert(usersTable).values({ id: 'u1', name: 'User One', email: 'u1@x.com' })

    const [org] = await db.insert(tables.organizations).values({ name: "U's Org", slug: 'u-org', createdBy: 'u1' }).returning()
    expect(org!.id).toMatch(/^[0-9a-f]{32}$/)
    expect(org!.kind).toBe('personal')
    expect(org!.createdAt).toBeInstanceOf(Date)

    const [member] = await db.insert(tables.organizationMembers).values({ organizationId: org!.id, userId: 'u1' }).returning()
    expect(member!.role).toBe('member')

    await db.insert(workspacesTable).values({ id: 'ws1', organizationId: org!.id, name: 'WS' })
    const [wm] = await db.insert(tables.workspaceMembers).values({ workspaceId: 'ws1', inviteEmail: 'p@x.com', inviteToken: 'tok-aaaaaaaaaaaaaaaa' }).returning()
    expect(wm!.role).toBe('editor')
    expect(wm!.acceptedAt).toBeNull()
    expect(wm!.organizationMemberId).toBeNull()
  })

  it('enforces the unique (organization_id, user_id) member constraint', async () => {
    const db = openDatabase([usersTable, workspacesTable, tables.organizations, tables.organizationMembers, tables.workspaceMembers])
    await db.insert(usersTable).values({ id: 'u1', name: 'U', email: 'u1@x.com' })
    const [org] = await db.insert(tables.organizations).values({ name: 'O', slug: 'o', createdBy: 'u1' }).returning()
    await db.insert(tables.organizationMembers).values({ organizationId: org!.id, userId: 'u1' })
    await expect(
      db.insert(tables.organizationMembers).values({ organizationId: org!.id, userId: 'u1' }),
    ).rejects.toThrow()
  })

  it('cascades workspace_member deletion when the referenced user is deleted', async () => {
    const db = openDatabase([usersTable, workspacesTable, tables.organizations, tables.organizationMembers, tables.workspaceMembers])
    await db.insert(usersTable).values({ id: 'u1', name: 'U', email: 'u1@x.com' })
    const [org] = await db.insert(tables.organizations).values({ name: 'O', slug: 'o', createdBy: 'u1' }).returning()
    await db.insert(workspacesTable).values({ id: 'ws1', organizationId: org!.id, name: 'WS' })
    await db.insert(tables.workspaceMembers).values({ workspaceId: 'ws1', userId: 'u1', role: 'editor', inviteToken: 'tok-bbbbbbbbbbbbbbbb' })

    expect(await db.select().from(tables.workspaceMembers)).toHaveLength(1)
    // workspace_member.user_id → user.id ON DELETE CASCADE: deleting the user
    // removes its membership rows.
    await db.delete(usersTable).where(eq(usersTable.id, 'u1'))
    expect(await db.select().from(tables.workspaceMembers)).toHaveLength(0)
  })

  it('cascades workspace_member deletion when the parent workspace is deleted', async () => {
    const db = openDatabase([usersTable, workspacesTable, tables.organizations, tables.organizationMembers, tables.workspaceMembers])
    await db.insert(usersTable).values({ id: 'u1', name: 'U', email: 'u1@x.com' })
    const [org] = await db.insert(tables.organizations).values({ name: 'O', slug: 'o', createdBy: 'u1' }).returning()
    await db.insert(workspacesTable).values({ id: 'ws1', organizationId: org!.id, name: 'WS' })
    await db.insert(tables.workspaceMembers).values({ workspaceId: 'ws1', inviteEmail: 'p@x.com', inviteToken: 'tok-cccccccccccccccc' })

    expect(await db.select().from(tables.workspaceMembers)).toHaveLength(1)
    await db.delete(workspacesTable).where(eq(workspacesTable.id, 'ws1'))
    expect(await db.select().from(tables.workspaceMembers)).toHaveLength(0)
  })
})
