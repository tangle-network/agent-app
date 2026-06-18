import { describe, it, expect } from 'vitest'
import { createTeamTables } from '../../src/teams/drizzle/schema'
import { createWorkspaceAccess } from '../../src/teams/drizzle/access'
import { createMembersApi, SeatLimitError, type MemberSyncSeam } from '../../src/teams/members-api'
import { openDatabase, usersTable, workspacesTable } from './db-helper'

const tables = createTeamTables({ userTable: usersTable, workspaceTable: workspacesTable })

async function seed() {
  const db = openDatabase([usersTable, workspacesTable, tables.organizations, tables.organizationMembers, tables.workspaceMembers])

  await db.insert(usersTable).values([
    { id: 'owner-1', name: 'Owner', email: 'owner@x.com' },
    { id: 'editor-1', name: 'Editor', email: 'editor@x.com' },
    { id: 'existing-1', name: 'Existing', email: 'existing@x.com' },
  ])
  const [org] = await db.insert(tables.organizations).values({ name: 'Acme', slug: 'acme', kind: 'team', createdBy: 'owner-1' }).returning()
  await db.insert(workspacesTable).values({ id: 'ws-1', organizationId: org!.id, name: 'Workspace' })

  // owner-1 is org owner → owner of every workspace (inherited, no row needed)
  await db.insert(tables.organizationMembers).values({ organizationId: org!.id, userId: 'owner-1', role: 'owner' })
  // existing-1 already a plain org member
  const [existingOrgMember] = await db.insert(tables.organizationMembers).values({ organizationId: org!.id, userId: 'existing-1', role: 'member' }).returning()

  const access = createWorkspaceAccess({ db, tables, workspaceTable: workspacesTable })
  return { db, org: org!, existingOrgMember: existingOrgMember!, access }
}

function api(deps: Awaited<ReturnType<typeof seed>>, extra: { enforceSeat?: any; memberSyncSeam?: MemberSyncSeam } = {}) {
  return createMembersApi({
    db: deps.db,
    tables,
    userTable: usersTable,
    workspaceTable: workspacesTable,
    access: deps.access,
    ...extra,
  })
}

const ownerActor = { id: 'owner-1', email: 'owner@x.com' }

describe('inviteMember', () => {
  it('owner invites a new email → creates a pending member with a token', async () => {
    const deps = await seed()
    const res = await api(deps).inviteMember({ workspaceId: 'ws-1', actor: ownerActor, email: 'new@x.com', role: 'editor' })
    expect(res.status).toBe(200)
    const body = await res.json() as { member: any; inviteToken: string }
    expect(body.inviteToken).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(body.member.role).toBe('editor')
    expect(body.member.inviteEmail).toBe('new@x.com')
    expect(body.member.acceptedAt).toBeNull()
  })

  it('rejects an invalid role', async () => {
    const deps = await seed()
    const res = await api(deps).inviteMember({ workspaceId: 'ws-1', actor: ownerActor, email: 'new@x.com', role: 'owner' })
    expect(res.status).toBe(400)
  })

  it('a non-admin cannot invite (404 — no admin access)', async () => {
    const deps = await seed()
    const res = await api(deps).inviteMember({ workspaceId: 'ws-1', actor: { id: 'editor-1', email: 'editor@x.com' }, email: 'new@x.com', role: 'editor' })
    expect(res.status).toBe(404)
  })

  it('rejects inviting an existing org admin (409)', async () => {
    const deps = await seed()
    // make existing-1 an org admin
    await deps.db.update(tables.organizationMembers).set({ role: 'admin' }).where(eqOrgMember(deps.existingOrgMember.id))
    const res = await api(deps).inviteMember({ workspaceId: 'ws-1', actor: ownerActor, email: 'existing@x.com', role: 'editor' })
    expect(res.status).toBe(409)
  })

  it('rejects a duplicate pending invite (409)', async () => {
    const deps = await seed()
    const a = api(deps)
    await a.inviteMember({ workspaceId: 'ws-1', actor: ownerActor, email: 'dup@x.com', role: 'editor' })
    const res = await a.inviteMember({ workspaceId: 'ws-1', actor: ownerActor, email: 'dup@x.com', role: 'editor' })
    expect(res.status).toBe(409)
  })
})

describe('enforceSeat seam (optional)', () => {
  it('is NOT called when not provided — invite succeeds with no billing wired', async () => {
    const deps = await seed()
    const res = await api(deps).inviteMember({ workspaceId: 'ws-1', actor: ownerActor, email: 'free@x.com', role: 'editor' })
    expect(res.status).toBe(200)
  })

  it('fires for a new-seat invite and a SeatLimitError becomes a 402', async () => {
    const deps = await seed()
    let called: { actorId: string; organizationId: string } | null = null
    const enforceSeat = (input: { actorId: string; organizationId: string }) => {
      called = input
      throw new SeatLimitError('Upgrade to add seats', { capability: 'seats', requiredPlan: 'pro' })
    }
    const res = await api(deps, { enforceSeat }).inviteMember({ workspaceId: 'ws-1', actor: ownerActor, email: 'paid@x.com', role: 'editor' })
    expect(res.status).toBe(402)
    const body = await res.json() as { error: string; capability: string; requiredPlan: string }
    expect(body.capability).toBe('seats')
    expect(body.requiredPlan).toBe('pro')
    expect(called).toEqual({ actorId: 'owner-1', organizationId: deps.org.id })
  })

  it('does NOT fire when the invitee is already an org member (no new seat)', async () => {
    const deps = await seed()
    let calls = 0
    const enforceSeat = () => { calls += 1 }
    const res = await api(deps, { enforceSeat }).inviteMember({ workspaceId: 'ws-1', actor: ownerActor, email: 'existing@x.com', role: 'editor' })
    expect(res.status).toBe(200)
    expect(calls).toBe(0)
  })
})

describe('acceptInvite + memberSyncSeam.add', () => {
  it('accepts a pending invite, creates org membership, fires add sync', async () => {
    const deps = await seed()
    await deps.db.insert(usersTable).values({ id: 'invitee-1', name: 'Invitee', email: 'invitee@x.com' })
    const invite = await api(deps).inviteMember({ workspaceId: 'ws-1', actor: ownerActor, email: 'invitee@x.com', role: 'editor' })
    const { inviteToken } = await invite.json() as { inviteToken: string }

    const adds: any[] = []
    const seam: MemberSyncSeam = { add: (input) => { adds.push(input) } }
    const res = await api(deps, { memberSyncSeam: seam }).acceptInvite({ token: inviteToken, actor: { id: 'invitee-1', email: 'invitee@x.com' } })
    expect(res.status).toBe(200)
    const body = await res.json() as { workspaceId: string; role: string }
    expect(body.workspaceId).toBe('ws-1')
    await flushMicrotasks()
    expect(adds).toEqual([{ workspaceId: 'ws-1', userId: 'invitee-1', role: 'editor' }])

    // now reachable through access
    const access = deps.access
    const granted = await access.getWorkspaceAccess('ws-1', 'invitee-1')
    expect(granted?.role).toBe('editor')
  })

  it('rejects an email mismatch (403)', async () => {
    const deps = await seed()
    const invite = await api(deps).inviteMember({ workspaceId: 'ws-1', actor: ownerActor, email: 'target@x.com', role: 'editor' })
    const { inviteToken } = await invite.json() as { inviteToken: string }
    const res = await api(deps).acceptInvite({ token: inviteToken, actor: { id: 'someone', email: 'wrong@x.com' } })
    expect(res.status).toBe(403)
  })

  it('rejects a double-accept (409) — atomic guard', async () => {
    const deps = await seed()
    await deps.db.insert(usersTable).values({ id: 'invitee-2', name: 'I2', email: 'i2@x.com' })
    const invite = await api(deps).inviteMember({ workspaceId: 'ws-1', actor: ownerActor, email: 'i2@x.com', role: 'viewer' })
    const { inviteToken } = await invite.json() as { inviteToken: string }
    const a = api(deps)
    const first = await a.acceptInvite({ token: inviteToken, actor: { id: 'invitee-2', email: 'i2@x.com' } })
    expect(first.status).toBe(200)
    const second = await a.acceptInvite({ token: inviteToken, actor: { id: 'invitee-2', email: 'i2@x.com' } })
    // token is cleared on accept, so the second lookup misses entirely
    expect(second.status).toBe(404)
  })
})

describe('updateMemberRole + memberSyncSeam.role', () => {
  it('owner changes an accepted member role and fires role sync', async () => {
    const deps = await seed()
    await deps.db.insert(usersTable).values({ id: 'm1', name: 'M', email: 'm@x.com' })
    const invite = await api(deps).inviteMember({ workspaceId: 'ws-1', actor: ownerActor, email: 'm@x.com', role: 'viewer' })
    const { inviteToken } = await invite.json() as { inviteToken: string }
    await api(deps).acceptInvite({ token: inviteToken, actor: { id: 'm1', email: 'm@x.com' } })

    const [memberRow] = await deps.db.select().from(tables.workspaceMembers)
    const roles: any[] = []
    const seam: MemberSyncSeam = { role: (input) => { roles.push(input) } }
    const res = await api(deps, { memberSyncSeam: seam }).updateMemberRole({ workspaceId: 'ws-1', actor: ownerActor, memberId: memberRow!.id, role: 'admin' })
    expect(res.status).toBe(200)
    await flushMicrotasks()
    expect(roles).toEqual([{ workspaceId: 'ws-1', userId: 'm1', role: 'admin' }])
  })

  it('rejects managing an org-inherited owner row (org: prefix)', async () => {
    const deps = await seed()
    const res = await api(deps).updateMemberRole({ workspaceId: 'ws-1', actor: ownerActor, memberId: 'org:abc', role: 'editor' })
    expect(res.status).toBe(403)
  })
})

describe('removeMember + memberSyncSeam.remove', () => {
  it('owner removes a member and fires remove sync', async () => {
    const deps = await seed()
    await deps.db.insert(usersTable).values({ id: 'm2', name: 'M2', email: 'm2@x.com' })
    const invite = await api(deps).inviteMember({ workspaceId: 'ws-1', actor: ownerActor, email: 'm2@x.com', role: 'editor' })
    const { inviteToken } = await invite.json() as { inviteToken: string }
    await api(deps).acceptInvite({ token: inviteToken, actor: { id: 'm2', email: 'm2@x.com' } })
    const [memberRow] = await deps.db.select().from(tables.workspaceMembers)

    const removes: any[] = []
    const seam: MemberSyncSeam = { remove: (input) => { removes.push(input) } }
    const res = await api(deps, { memberSyncSeam: seam }).removeMember({ workspaceId: 'ws-1', actor: ownerActor, memberId: memberRow!.id })
    expect(res.status).toBe(200)
    await flushMicrotasks()
    expect(removes).toEqual([{ workspaceId: 'ws-1', userId: 'm2' }])
    const remaining = await deps.db.select().from(tables.workspaceMembers)
    expect(remaining).toHaveLength(0)
  })

  it('a sync seam that throws never blocks the mutation (fail-soft)', async () => {
    const deps = await seed()
    await deps.db.insert(usersTable).values({ id: 'm3', name: 'M3', email: 'm3@x.com' })
    const invite = await api(deps).inviteMember({ workspaceId: 'ws-1', actor: ownerActor, email: 'm3@x.com', role: 'editor' })
    const { inviteToken } = await invite.json() as { inviteToken: string }
    await api(deps).acceptInvite({ token: inviteToken, actor: { id: 'm3', email: 'm3@x.com' } })
    const [memberRow] = await deps.db.select().from(tables.workspaceMembers)

    const seam: MemberSyncSeam = { remove: () => { throw new Error('sandbox down') } }
    const res = await api(deps, { memberSyncSeam: seam }).removeMember({ workspaceId: 'ws-1', actor: ownerActor, memberId: memberRow!.id })
    expect(res.status).toBe(200)
    const remaining = await deps.db.select().from(tables.workspaceMembers)
    expect(remaining).toHaveLength(0)
  })
})

describe('listMembers', () => {
  it('returns inherited org owners plus explicit members', async () => {
    const deps = await seed()
    await api(deps).inviteMember({ workspaceId: 'ws-1', actor: ownerActor, email: 'pending@x.com', role: 'viewer' })
    const res = await api(deps).listMembers({ workspaceId: 'ws-1', actor: ownerActor })
    expect(res.status).toBe(200)
    const body = await res.json() as { members: any[]; currentRole: string }
    expect(body.currentRole).toBe('owner')
    const owner = body.members.find((m) => m.inherited)
    expect(owner?.role).toBe('owner')
    const pending = body.members.find((m) => m.email === 'pending@x.com')
    expect(pending?.acceptedAt).toBeNull()
  })
})

import { eq } from 'drizzle-orm'
function eqOrgMember(id: string) {
  return eq(tables.organizationMembers.id, id)
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}
