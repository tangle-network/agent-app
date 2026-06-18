import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTeamTables } from '../../src/teams/drizzle/schema'
import { createEnsurePersonalOrganization } from '../../src/teams/drizzle/personal-organization'
import { createWorkspaceAccess } from '../../src/teams/drizzle/access'
import { openDatabase, usersTable, workspacesTable } from './db-helper'

const tables = createTeamTables({ userTable: usersTable, workspaceTable: workspacesTable })

function setup() {
  const db = openDatabase([usersTable, workspacesTable, tables.organizations, tables.organizationMembers, tables.workspaceMembers])
  const ensurePersonalOrganization = createEnsurePersonalOrganization({ db, tables })
  return { db, ensurePersonalOrganization }
}

describe('ensurePersonalOrganization', () => {
  it('creates one personal org with the user as owner', async () => {
    const { db, ensurePersonalOrganization } = setup()
    await db.insert(usersTable).values({ id: 'u1', name: 'Ada Lovelace', email: 'ada@x.com' })

    const result = await ensurePersonalOrganization({ id: 'u1', name: 'Ada Lovelace', email: 'ada@x.com' })
    expect(result.organization.kind).toBe('personal')
    expect(result.organization.name).toBe("Ada Lovelace's Organization")
    expect(result.organization.slug).toBe('personal-u1')
    expect(result.role).toBe('owner')
    expect(result.member.role).toBe('owner')

    const orgs = await db.select().from(tables.organizations)
    expect(orgs).toHaveLength(1)
  })

  it('is idempotent — a second call returns the same org, no duplicates', async () => {
    const { db, ensurePersonalOrganization } = setup()
    await db.insert(usersTable).values({ id: 'u1', name: 'U', email: 'u@x.com' })

    const first = await ensurePersonalOrganization({ id: 'u1', email: 'u@x.com' })
    const second = await ensurePersonalOrganization({ id: 'u1', email: 'u@x.com' })
    expect(second.organization.id).toBe(first.organization.id)

    expect(await db.select().from(tables.organizations)).toHaveLength(1)
    expect(await db.select().from(tables.organizationMembers)).toHaveLength(1)
  })

  it('falls back to the email local-part when name is missing', async () => {
    const { db, ensurePersonalOrganization } = setup()
    await db.insert(usersTable).values({ id: 'u1', name: 'x', email: 'founder@x.com' })
    const result = await ensurePersonalOrganization({ id: 'u1', email: 'founder@x.com' })
    expect(result.organization.name).toBe("founder's Organization")
  })

  it('makes solo-user adoption work: the personal org gives owner access to its workspaces', async () => {
    const { db, ensurePersonalOrganization } = setup()
    await db.insert(usersTable).values({ id: 'u1', name: 'Solo', email: 'solo@x.com' })
    const { organization } = await ensurePersonalOrganization({ id: 'u1', email: 'solo@x.com' })
    await db.insert(workspacesTable).values({ id: 'ws-1', organizationId: organization.id, name: 'My Workspace' })

    const access = createWorkspaceAccess({ db, tables, workspaceTable: workspacesTable })
    const granted = await access.getWorkspaceAccess('ws-1', 'u1')
    // Org owner → workspace owner across the org, with no workspace_member row.
    expect(granted?.role).toBe('owner')

    const list = await access.listUserWorkspaces('u1')
    expect(list.map((w) => w.id)).toContain('ws-1')
    expect(list[0]?.role).toBe('owner')
  })

  it('two different users each get their own personal org', async () => {
    const { db, ensurePersonalOrganization } = setup()
    await db.insert(usersTable).values([
      { id: 'u1', name: 'One', email: 'one@x.com' },
      { id: 'u2', name: 'Two', email: 'two@x.com' },
    ])
    const a = await ensurePersonalOrganization({ id: 'u1', email: 'one@x.com' })
    const b = await ensurePersonalOrganization({ id: 'u2', email: 'two@x.com' })
    expect(a.organization.id).not.toBe(b.organization.id)
    const memberRows = await db.select().from(tables.organizationMembers).where(eq(tables.organizationMembers.userId, 'u1'))
    expect(memberRows).toHaveLength(1)
  })
})
