import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTeamTables } from '../../src/teams/drizzle/schema'
import { createWorkspaceInvitationTable } from '../../src/teams/drizzle/invitations-schema'
import { createWorkspaceAccess } from '../../src/teams/drizzle/access'
import {
  createInvitationsApi,
  SeatLimitError,
  type SendInvitationEmailInput,
  type SendInvitationEmailSeam,
} from '../../src/teams/invitations-api'
import { INVITATION_EXPIRY_DAYS } from '../../src/teams/invitations'
import { openDatabase, usersTable, workspacesTable } from './db-helper'

const tables = createTeamTables({ userTable: usersTable, workspaceTable: workspacesTable })
const invitationTables = createWorkspaceInvitationTable({
  userTable: usersTable,
  workspaceTable: workspacesTable,
  organizationTable: tables.organizations,
})

const ORIGIN = 'https://app.test'

async function seed() {
  const native = openDatabase([
    usersTable,
    workspacesTable,
    tables.organizations,
    tables.organizationMembers,
    tables.workspaceMembers,
    invitationTables.workspaceInvitations,
  ])
  // D1-shaped atomic batch, executing real Drizzle queries on the same SQLite connection.
  const db = Object.assign(native, {
    batch: async (statements: [any, ...any[]]) => native.$client.transaction(() =>
      statements.map(statement => statement.all()))(),
  })
  await db.insert(usersTable).values([
    { id: 'owner-1', name: 'Owner', email: 'owner@x.com', emailVerified: true },
    { id: 'editor-1', name: 'Editor', email: 'editor@x.com', emailVerified: true },
    { id: 'existing-1', name: 'Existing', email: 'existing@x.com', emailVerified: true },
  ])
  const [org] = await db.insert(tables.organizations).values({ name: 'Acme', slug: 'acme', kind: 'team', createdBy: 'owner-1' }).returning()
  await db.insert(workspacesTable).values({ id: 'ws-1', organizationId: org!.id, name: 'Workspace' })
  await db.insert(tables.organizationMembers).values({ organizationId: org!.id, userId: 'owner-1', role: 'owner' })
  await db.insert(tables.organizationMembers).values({ organizationId: org!.id, userId: 'existing-1', role: 'member' })
  const access = createWorkspaceAccess({ db, tables, workspaceTable: workspacesTable })
  return { db, org: org!, access }
}

type Deps = Awaited<ReturnType<typeof seed>>

function makeApi(deps: Deps, opts: {
  sendInvitationEmail?: SendInvitationEmailSeam
  enforceSeat?: (input: { actorId: string; organizationId: string }) => void | Promise<void>
  memberSyncSeam?: { add?: (input: { workspaceId: string; userId: string; role: string }) => void }
} = {}) {
  const sent: SendInvitationEmailInput[] = []
  const adds: Array<{ workspaceId: string; userId: string; role: string }> = []
  const api = createInvitationsApi({
    db: deps.db,
    tables,
    invitationsTable: invitationTables,
    userTable: usersTable,
    workspaceTable: workspacesTable,
    access: deps.access,
    sendInvitationEmail: opts.sendInvitationEmail ?? (async (input) => { sent.push(input); return { succeeded: true } }),
    enforceSeat: opts.enforceSeat,
    memberSyncSeam: opts.memberSyncSeam ?? { add: (input) => { adds.push(input) } },
    productDisplayName: 'Test App',
  })
  return { api, sent, adds }
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('createInvitation', () => {
  it('owner invites a new email → pending invitation, email sent, link returned', async () => {
    const deps = await seed()
    const { api, sent } = makeApi(deps)
    const res = await api.createInvitation({ workspaceId: 'ws-1', email: 'New@X.com', permissions: 'editor', invitedByUserId: 'owner-1', origin: ORIGIN })
    expect(res.succeeded).toBe(true)
    if (!res.succeeded) return
    expect(res.value.invitation.status).toBe('pending')
    expect(res.value.invitation.emailStatus).toBe('sent')
    expect(res.value.invitation.email).toBe('new@x.com') // normalized
    expect(res.value.invitation.permissions).toBe('editor')
    expect(res.value.inviteUrl).toContain('/invite/inv_')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe('new@x.com')
    expect(sent[0]!.workspaceName).toBe('Workspace')
    expect(sent[0]!.permission).toBe('editor')
    expect(sent[0]!.inviterEmail).toBe('owner@x.com')
  })

  it('refuses an address no invitation can reach, before sending anything', async () => {
    const deps = await seed()
    const { api, sent } = makeApi(deps)
    const res = await api.createInvitation({ workspaceId: 'ws-1', email: 'founder@', permissions: 'editor', invitedByUserId: 'owner-1', origin: ORIGIN })
    expect(res.succeeded).toBe(false)
    if (!res.succeeded) expect([res.status, res.error]).toEqual([400, 'Enter a full email address, such as name@company.com.'])
    expect(sent).toHaveLength(0)
  })

  it('rejects an invalid (owner) permission → 400', async () => {
    const deps = await seed()
    const res = await makeApi(deps).api.createInvitation({ workspaceId: 'ws-1', email: 'x@x.com', permissions: 'owner', invitedByUserId: 'owner-1', origin: ORIGIN })
    expect(res.succeeded).toBe(false)
    if (!res.succeeded) expect(res.status).toBe(400)
  })

  it('a non-admin cannot invite → 404', async () => {
    const deps = await seed()
    const res = await makeApi(deps).api.createInvitation({ workspaceId: 'ws-1', email: 'x@x.com', permissions: 'editor', invitedByUserId: 'editor-1', origin: ORIGIN })
    expect(res.succeeded).toBe(false)
    if (!res.succeeded) expect(res.status).toBe(404)
  })

  it('rejects a duplicate pending invite → 409', async () => {
    const deps = await seed()
    const { api } = makeApi(deps)
    await api.createInvitation({ workspaceId: 'ws-1', email: 'dup@x.com', permissions: 'editor', invitedByUserId: 'owner-1', origin: ORIGIN })
    const res = await api.createInvitation({ workspaceId: 'ws-1', email: 'dup@x.com', permissions: 'editor', invitedByUserId: 'owner-1', origin: ORIGIN })
    expect(res.succeeded).toBe(false)
    if (!res.succeeded) expect(res.status).toBe(409)
  })

  it('a failed email send still creates the invite (fail-soft) with emailStatus failed', async () => {
    const deps = await seed()
    const { api } = makeApi(deps, { sendInvitationEmail: async () => ({ succeeded: false, error: 'no key' }) })
    const res = await api.createInvitation({ workspaceId: 'ws-1', email: 'soft@x.com', permissions: 'viewer', invitedByUserId: 'owner-1', origin: ORIGIN })
    expect(res.succeeded).toBe(true)
    if (!res.succeeded) return
    expect(res.value.invitation.emailStatus).toBe('failed')
    expect(res.value.emailError).toBe('no key')
    const rows = await deps.db.select().from(invitationTables.workspaceInvitations)
    expect(rows).toHaveLength(1)
  })
})

describe('enforceSeat seam (optional)', () => {
  it('fires for a new-seat invite; a SeatLimitError becomes a 402', async () => {
    const deps = await seed()
    let called: { actorId: string; organizationId: string } | null = null
    const enforceSeat = (input: { actorId: string; organizationId: string }) => {
      called = input
      throw new SeatLimitError('Upgrade to add seats', { capability: 'seats', requiredPlan: 'pro' })
    }
    const res = await makeApi(deps, { enforceSeat }).api.createInvitation({ workspaceId: 'ws-1', email: 'paid@x.com', permissions: 'editor', invitedByUserId: 'owner-1', origin: ORIGIN })
    expect(res.succeeded).toBe(false)
    if (!res.succeeded) expect(res.status).toBe(402)
    expect(called).toEqual({ actorId: 'owner-1', organizationId: deps.org.id })
  })

  it('does NOT fire when the invitee is already an org member (no new seat)', async () => {
    const deps = await seed()
    let calls = 0
    const enforceSeat = () => { calls += 1 }
    const res = await makeApi(deps, { enforceSeat }).api.createInvitation({ workspaceId: 'ws-1', email: 'existing@x.com', permissions: 'editor', invitedByUserId: 'owner-1', origin: ORIGIN })
    expect(res.succeeded).toBe(true)
    expect(calls).toBe(0)
  })
})

describe('listInvitations', () => {
  it('admin lists pending invitations with inviteUrl; non-admin → 404', async () => {
    const deps = await seed()
    const { api } = makeApi(deps)
    await api.createInvitation({ workspaceId: 'ws-1', email: 'p1@x.com', permissions: 'viewer', invitedByUserId: 'owner-1', origin: ORIGIN })
    const ok = await api.listInvitations({ workspaceId: 'ws-1', userId: 'owner-1', origin: ORIGIN })
    expect(ok.succeeded).toBe(true)
    if (ok.succeeded) {
      expect(ok.value.invitations).toHaveLength(1)
      expect(ok.value.invitations[0]!.inviteUrl).toContain('/invite/inv_')
      expect(ok.value.invitations[0]!.inviterEmail).toBe('owner@x.com')
    }
    const denied = await api.listInvitations({ workspaceId: 'ws-1', userId: 'editor-1', origin: ORIGIN })
    expect(denied.succeeded).toBe(false)
    if (!denied.succeeded) expect(denied.status).toBe(404)
  })
})

describe('resend + revoke', () => {
  it('resends a pending invite then revokes it; resend after revoke → 409', async () => {
    const deps = await seed()
    const { api, sent } = makeApi(deps)
    const created = await api.createInvitation({ workspaceId: 'ws-1', email: 'rr@x.com', permissions: 'editor', invitedByUserId: 'owner-1', origin: ORIGIN })
    if (!created.succeeded) throw new Error('setup failed')
    const id = created.value.invitation.id

    const resent = await api.resendInvitation({ invitationId: id, userId: 'owner-1', origin: ORIGIN })
    expect(resent.succeeded).toBe(true)
    if (resent.succeeded) expect(resent.value.invitation.lastSentAt).not.toBeNull()
    expect(sent).toHaveLength(2) // initial + resend

    const revoked = await api.revokeInvitation({ invitationId: id, userId: 'owner-1' })
    expect(revoked.succeeded).toBe(true)
    if (revoked.succeeded) expect(revoked.value.invitation.status).toBe('revoked')

    const afterRevoke = await api.resendInvitation({ invitationId: id, userId: 'owner-1', origin: ORIGIN })
    expect(afterRevoke.succeeded).toBe(false)
    if (!afterRevoke.succeeded) expect(afterRevoke.status).toBe(409)
  })
})

describe('getPreview + acceptInvitation', () => {
  it('previews a pending invite (workspace name + status)', async () => {
    const deps = await seed()
    const { api } = makeApi(deps)
    const created = await api.createInvitation({ workspaceId: 'ws-1', email: 'pv@x.com', permissions: 'viewer', invitedByUserId: 'owner-1', origin: ORIGIN })
    if (!created.succeeded) throw new Error('setup')
    const preview = await api.getPreview(created.value.invitation.token)
    expect(preview.succeeded).toBe(true)
    if (preview.succeeded) {
      expect(preview.value.workspaceName).toBe('Workspace')
      expect(preview.value.status).toBe('pending')
      expect(preview.value.email).toBe('pv@x.com')
    }
  })

  it('rejects accept on email mismatch (403)', async () => {
    const deps = await seed()
    await deps.db.insert(usersTable).values({ id: 'inv-mismatch', name: 'X', email: 'wrong@x.com', emailVerified: true })
    const { api } = makeApi(deps)
    const a = await api.createInvitation({ workspaceId: 'ws-1', email: 'target@x.com', permissions: 'editor', invitedByUserId: 'owner-1', origin: ORIGIN })
    if (!a.succeeded) throw new Error('setup')
    const mismatch = await api.acceptInvitation({ token: a.value.invitation.token, userId: 'inv-mismatch' })
    expect(mismatch.succeeded).toBe(false)
    if (!mismatch.succeeded) expect(mismatch.status).toBe(403)
  })

  it('accepts a matching unverified invitee because the invite token proves inbox access', async () => {
    const deps = await seed()
    await deps.db.insert(usersTable).values({ id: 'inv-unverified', name: 'U', email: 'unverified@x.com', emailVerified: false })
    const { api, adds } = makeApi(deps)
    const u = await api.createInvitation({ workspaceId: 'ws-1', email: 'unverified@x.com', permissions: 'editor', invitedByUserId: 'owner-1', origin: ORIGIN })
    if (!u.succeeded) throw new Error('setup')
    const accepted = await api.acceptInvitation({ token: u.value.invitation.token, userId: 'inv-unverified' })
    expect(accepted.succeeded).toBe(true)
    if (accepted.succeeded) expect(accepted.value.workspaceId).toBe('ws-1')
    await flushMicrotasks()
    expect(adds).toEqual([{ workspaceId: 'ws-1', userId: 'inv-unverified', role: 'editor' }])
  })

  it('accepts a matching, verified invite → membership created, add sync fired, idempotent', async () => {
    const deps = await seed()
    await deps.db.insert(usersTable).values({ id: 'invitee-1', name: 'Invitee', email: 'invitee@x.com', emailVerified: true })
    const { api, adds } = makeApi(deps)
    const created = await api.createInvitation({ workspaceId: 'ws-1', email: 'invitee@x.com', permissions: 'editor', invitedByUserId: 'owner-1', origin: ORIGIN })
    if (!created.succeeded) throw new Error('setup')

    const accepted = await api.acceptInvitation({ token: created.value.invitation.token, userId: 'invitee-1' })
    expect(accepted.succeeded).toBe(true)
    if (accepted.succeeded) expect(accepted.value.workspaceId).toBe('ws-1')
    await flushMicrotasks()
    expect(adds).toEqual([{ workspaceId: 'ws-1', userId: 'invitee-1', role: 'editor' }])

    const [row] = await deps.db
      .select()
      .from(invitationTables.workspaceInvitations)
      .where(eq(invitationTables.workspaceInvitations.id, created.value.invitation.id))
    expect(row!.status).toBe('accepted')

    const granted = await deps.access.getWorkspaceAccess('ws-1', 'invitee-1')
    expect(granted?.role).toBe('editor')

    // re-accept is idempotent (member already exists) → still succeeds
    const again = await api.acceptInvitation({ token: created.value.invitation.token, userId: 'invitee-1' })
    expect(again.succeeded).toBe(true)
    if (again.succeeded) expect(again.value.workspaceId).toBe('ws-1')
  })

  it('accept after expiry → 409 (preview marks it expired)', async () => {
    const deps = await seed()
    await deps.db.insert(usersTable).values({ id: 'late-1', name: 'Late', email: 'late@x.com', emailVerified: true })
    const { api } = makeApi(deps)
    const t0 = new Date('2026-01-01T00:00:00.000Z')
    const created = await api.createInvitation({ workspaceId: 'ws-1', email: 'late@x.com', permissions: 'viewer', invitedByUserId: 'owner-1', origin: ORIGIN, now: t0 })
    if (!created.succeeded) throw new Error('setup')
    const after = new Date(t0.getTime() + (INVITATION_EXPIRY_DAYS + 1) * 24 * 60 * 60 * 1000)

    const preview = await api.getPreview(created.value.invitation.token, after)
    expect(preview.succeeded).toBe(true)
    if (preview.succeeded) expect(preview.value.status).toBe('expired')

    const res = await api.acceptInvitation({ token: created.value.invitation.token, userId: 'late-1', now: after })
    expect(res.succeeded).toBe(false)
    if (!res.succeeded) expect(res.status).toBe(409)
  })
})

// A real driver boundary: the SELECT has returned its rows, but the caller has
// not started membership writes. No query/result is fabricated or skipped.
function afterMembershipRead(deps: Deps, change: () => void) {
  const client = deps.db.$client
  const prepare = client.prepare.bind(client)
  let armed = true
  client.prepare = ((query: string) => {
    const statement = prepare(query)
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key)
        if (key === 'all') return (...args: unknown[]) => {
          const rows = value.apply(target, args)
          if (armed && query.startsWith('select ') && query.includes('from "organization_member" where')) {
            armed = false
            change()
          }
          return rows
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }) as typeof client.prepare
}

async function pendingFixture() {
  const deps = await seed()
  const { api, adds } = makeApi(deps)
  const invitation = await api.createInvitation({ workspaceId: 'ws-1', email: 'editor@x.com',
    permissions: 'editor', invitedByUserId: 'owner-1', origin: ORIGIN })
  if (!invitation.succeeded) throw new Error('setup')
  return { ...deps, api, adds, invitation: invitation.value.invitation }
}

async function expectNoGrant(deps: Awaited<ReturnType<typeof pendingFixture>>) {
  expect(await deps.db.select().from(tables.organizationMembers)
    .where(eq(tables.organizationMembers.userId, 'editor-1'))).toHaveLength(0)
  expect(await deps.db.select().from(tables.workspaceMembers)
    .where(eq(tables.workspaceMembers.userId, 'editor-1'))).toHaveLength(0)
  expect(deps.adds).toHaveLength(0)
}

describe('atomic invitation acceptance against real SQLite races', () => {
  it('stale acceptance loses to workspace transfer; fresh acceptance grants only the destination', async () => {
    const deps = await pendingFixture()
    const [destination] = await deps.db.insert(tables.organizations).values({
      name: 'Destination', slug: 'destination', kind: 'team', createdBy: 'owner-1',
    }).returning()
    afterMembershipRead(deps, () => deps.db.$client.transaction(() => {
      deps.db.update(workspacesTable).set({ organizationId: destination!.id }).where(eq(workspacesTable.id, 'ws-1')).run()
      deps.db.update(invitationTables.workspaceInvitations).set({ organizationId: destination!.id })
        .where(eq(invitationTables.workspaceInvitations.id, deps.invitation.id)).run()
    })())
    const stale = await deps.api.acceptInvitation({ token: deps.invitation.token, userId: 'editor-1' })
    expect(stale).toMatchObject({ succeeded: false, status: 409 })
    await expectNoGrant(deps)
    expect((await deps.db.select().from(invitationTables.workspaceInvitations))[0]!.status).toBe('pending')
    expect(await deps.api.acceptInvitation({ token: deps.invitation.token, userId: 'editor-1' }))
      .toEqual({ succeeded: true, value: { workspaceId: 'ws-1' } })
    const members = await deps.db.select().from(tables.organizationMembers)
      .where(eq(tables.organizationMembers.userId, 'editor-1'))
    expect(members.map(member => member.organizationId)).toEqual([destination!.id])
    expect((await deps.access.getWorkspaceAccess('ws-1', 'editor-1'))?.role).toBe('editor')
    expect(deps.adds).toHaveLength(1)
  })

  for (const race of ['revoked', 'expired', 'email', 'verification', 'collision'] as const) {
    it(`refuses ${race} changed after the membership read without materializing access`, async () => {
      const deps = await pendingFixture()
      afterMembershipRead(deps, () => {
        if (race === 'revoked') deps.db.update(invitationTables.workspaceInvitations).set({ status: 'revoked' })
          .where(eq(invitationTables.workspaceInvitations.id, deps.invitation.id)).run()
        if (race === 'expired') deps.db.update(invitationTables.workspaceInvitations).set({ expiresAt: new Date(0) })
          .where(eq(invitationTables.workspaceInvitations.id, deps.invitation.id)).run()
        if (race === 'email') deps.db.update(usersTable).set({ email: 'another@x.com' }).where(eq(usersTable.id, 'editor-1')).run()
        if (race === 'verification') deps.db.update(usersTable).set({ emailVerified: false }).where(eq(usersTable.id, 'editor-1')).run()
        if (race === 'collision') deps.db.insert(usersTable).values({
          id: 'collision', name: 'Collision', email: 'EDITOR@x.com', emailVerified: true,
        }).run()
      })
      expect(await deps.api.acceptInvitation({ token: deps.invitation.token, userId: 'editor-1' }))
        .toMatchObject({ succeeded: false, status: 409 })
      await expectNoGrant(deps)
    })
  }

  it('losing acceptance preserves a concurrently existing grant and never syncs', async () => {
    const deps = await pendingFixture()
    {
      const [orgMember] = deps.db.insert(tables.organizationMembers).values({
        organizationId: deps.org.id, userId: 'editor-1', role: 'member',
      }).returning().all()
      deps.db.insert(tables.workspaceMembers).values({ id: 'preexisting', workspaceId: 'ws-1',
        organizationMemberId: orgMember!.id, userId: 'editor-1', role: 'viewer', acceptedAt: new Date(),
      }).run()
    }
    afterMembershipRead(deps, () => {
      deps.db.update(invitationTables.workspaceInvitations).set({ status: 'revoked' })
        .where(eq(invitationTables.workspaceInvitations.id, deps.invitation.id)).run()
    })
    expect(await deps.api.acceptInvitation({ token: deps.invitation.token, userId: 'editor-1' }))
      .toMatchObject({ succeeded: false, status: 409 })
    expect((await deps.db.select().from(tables.workspaceMembers)).map(member => [member.id, member.role]))
      .toEqual([['preexisting', 'viewer']])
    expect(deps.adds).toHaveLength(0)
  })

  it('duplicate simultaneous accept attempts create one grant and sync once', async () => {
    const deps = await pendingFixture()
    const results = await Promise.all([
      deps.api.acceptInvitation({ token: deps.invitation.token, userId: 'editor-1' }),
      deps.api.acceptInvitation({ token: deps.invitation.token, userId: 'editor-1' }),
    ])
    expect(results.filter(result => result.succeeded)).toHaveLength(1)
    expect(results.filter(result => !result.succeeded)).toEqual([
      expect.objectContaining({ status: 409 }),
    ])
    expect(await deps.db.select().from(tables.workspaceMembers)).toHaveLength(1)
    expect(deps.adds).toHaveLength(1)
  })
})


describe('atomic acceptance conflicts preserve existing membership semantics', () => {
  it('refuses a pending linked grant without marking the invitation accepted', async () => {
    const deps = await pendingFixture()
    const [member] = await deps.db.insert(tables.organizationMembers).values({
      organizationId: deps.org.id, userId: 'editor-1', role: 'member',
    }).returning()
    await deps.db.insert(tables.workspaceMembers).values({ id: 'pending-grant', workspaceId: 'ws-1',
      organizationMemberId: member!.id, userId: 'editor-1', role: 'viewer', acceptedAt: null,
    })
    expect(await deps.api.acceptInvitation({ token: deps.invitation.token, userId: 'editor-1' }))
      .toMatchObject({ succeeded: false, status: 409 })
    expect((await deps.db.select().from(invitationTables.workspaceInvitations))[0]!.status).toBe('pending')
    expect((await deps.db.select().from(tables.workspaceMembers))[0]!.acceptedAt).toBeNull()
    expect(deps.adds).toHaveLength(0)
  })

  it('refuses an occupied invite token without leaving even organization membership', async () => {
    const deps = await pendingFixture()
    const [member] = await deps.db.select().from(tables.organizationMembers)
      .where(eq(tables.organizationMembers.userId, 'existing-1'))
    await deps.db.insert(tables.workspaceMembers).values({ id: 'token-conflict', workspaceId: 'ws-1',
      organizationMemberId: member!.id, userId: 'existing-1', role: 'viewer',
      inviteToken: deps.invitation.token, acceptedAt: new Date(),
    })
    expect(await deps.api.acceptInvitation({ token: deps.invitation.token, userId: 'editor-1' }))
      .toMatchObject({ succeeded: false, status: 409 })
    await expectNoGrant(deps)
    expect((await deps.db.select().from(invitationTables.workspaceInvitations))[0]!.status).toBe('pending')
    expect((await deps.db.select().from(tables.workspaceMembers))[0]!.id).toBe('token-conflict')
  })

  it('fails closed without atomic batch before making any acceptance write', async () => {
    const deps = await pendingFixture()
    Reflect.deleteProperty(deps.db, 'batch')
    expect(await deps.api.acceptInvitation({ token: deps.invitation.token, userId: 'editor-1' }))
      .toMatchObject({ succeeded: false, status: 500 })
    await expectNoGrant(deps)
  })
})
