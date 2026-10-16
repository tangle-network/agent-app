import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { createTeamTables } from '../../src/teams/drizzle/schema'
import { createWorkspaceAccess } from '../../src/teams/drizzle/access'
import { openDatabase, usersTable, workspacesTable } from './db-helper'

const tables = createTeamTables({ userTable: usersTable, workspaceTable: workspacesTable })

async function seed() {
  const db = openDatabase([usersTable, workspacesTable, tables.organizations, tables.organizationMembers, tables.workspaceMembers])
  await db.insert(usersTable).values(['owner', 'editor', 'member', 'pending', 'foreign', 'outsider'].map(id => ({ id, name: id, email: `${id}@example.test` })))
  await db.insert(tables.organizations).values([
    { id: 'org', name: 'Team', slug: 'team', createdBy: 'owner' },
    { id: 'foreign-org', name: 'Other', slug: 'other', createdBy: 'foreign' },
  ])
  await db.insert(tables.organizationMembers).values([
    { id: 'owner-member', organizationId: 'org', userId: 'owner', role: 'owner' },
    { id: 'linked-member', organizationId: 'org', userId: 'member', role: 'member' },
    { id: 'pending-member', organizationId: 'org', userId: 'pending', role: 'member' },
    { id: 'foreign-member', organizationId: 'foreign-org', userId: 'foreign', role: 'owner' },
  ])
  await db.insert(workspacesTable).values([
    { id: 'first', organizationId: 'org', name: 'First', updatedAt: '2026-10-16T02:00:00Z' },
    { id: 'second', organizationId: 'org', name: 'Second', updatedAt: '2026-10-16T01:00:00Z' },
    { id: 'foreign-project', organizationId: 'foreign-org', name: 'Other' },
  ])
  await db.insert(tables.workspaceMembers).values([
    { id: 'legacy', workspaceId: 'first', userId: 'editor', role: 'editor', acceptedAt: new Date() },
    { id: 'linked', workspaceId: 'first', organizationMemberId: 'linked-member', userId: 'member', role: 'viewer', acceptedAt: new Date() },
    { id: 'pending', workspaceId: 'first', organizationMemberId: 'pending-member', userId: 'pending', role: 'editor' },
    { id: 'pending-direct', workspaceId: 'first', userId: 'outsider', role: 'editor' },
    // An explicit foreign link must never become a direct-user fallback.
    { id: 'foreign-link', workspaceId: 'second', organizationMemberId: 'foreign-member', userId: 'editor', role: 'owner', acceptedAt: new Date() },
  ])
  return { db, access: createWorkspaceAccess({ db, tables, workspaceTable: workspacesTable }) }
}

describe('workspace access → real SQLite team schema and foreign keys', () => {
  it('retains accepted legacy direct roles without manufacturing team membership', async () => {
    const { db, access } = await seed()
    expect(await access.getWorkspaceAccess('first', 'editor', 'editor')).toMatchObject({ role: 'editor', organizationMember: null })
    expect(await access.getWorkspaceAccess('first', 'editor', 'admin')).toBeNull()
    expect(await access.listUserWorkspaces('editor')).toEqual([expect.objectContaining({ id: 'first', role: 'editor' })])
    expect(await db.select().from(tables.organizationMembers).where(eq(tables.organizationMembers.userId, 'editor'))).toEqual([])
    expect(await access.getWorkspaceAccess('second', 'editor')).toBeNull()
    expect(await access.getWorkspaceAccess('foreign-project', 'editor')).toBeNull()
    await db.delete(tables.workspaceMembers).where(eq(tables.workspaceMembers.id, 'legacy'))
    expect(await access.getWorkspaceAccess('first', 'editor')).toBeNull()
    expect(await access.listUserWorkspaces('editor')).toEqual([])
  })

  it('keeps inherited owners and accepted linked roles while refusing pending, foreign and revoked grants', async () => {
    const { db, access } = await seed()
    expect((await access.listUserWorkspaces('owner')).map(row => [row.id, row.role])).toEqual([['first', 'owner'], ['second', 'owner']])
    expect(await access.getWorkspaceAccess('second', 'owner', 'owner')).toMatchObject({ role: 'owner', organizationMember: { id: 'owner-member' } })
    expect(await access.getWorkspaceAccess('first', 'member', 'viewer')).toMatchObject({ role: 'viewer' })
    expect(await access.getWorkspaceAccess('first', 'member', 'editor')).toBeNull()
    for (const id of ['pending', 'outsider', 'foreign']) {
      expect(await access.getWorkspaceAccess('first', id)).toBeNull()
      expect((await access.listUserWorkspaces(id)).filter(row => row.id === 'first')).toEqual([])
    }
    await db.delete(tables.organizationMembers).where(eq(tables.organizationMembers.id, 'linked-member'))
    expect(await access.getWorkspaceAccess('first', 'member')).toBeNull()
    expect(await access.listUserWorkspaces('member')).toEqual([])
  })

  it('folds duplicate legacy grants at the strongest direct role once and follows demotion', async () => {
    const { db, access } = await seed()
    await db.insert(tables.workspaceMembers).values({ workspaceId: 'first', userId: 'editor', role: 'viewer', acceptedAt: new Date() })
    expect(await access.getWorkspaceAccess('first', 'editor', 'editor')).toMatchObject({ role: 'editor' })
    expect(await access.listUserWorkspaces('editor')).toEqual([expect.objectContaining({ id: 'first', role: 'editor' })])
    await db.update(tables.workspaceMembers).set({ role: 'viewer' }).where(and(eq(tables.workspaceMembers.userId, 'editor'), eq(tables.workspaceMembers.workspaceId, 'first')))
    expect(await access.getWorkspaceAccess('first', 'editor', 'editor')).toBeNull()
    expect(await access.getWorkspaceAccess('first', 'editor')).toMatchObject({ role: 'viewer' })
  })
})
