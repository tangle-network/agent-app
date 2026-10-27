// @vitest-environment jsdom
/**
 * A link-only product end to end: the real invitations API with no mail
 * transport, behind the route a product mounts, driving the settings
 * `MembersSection` and `InvitationsSection` with `delivery="link"`.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useCallback, useEffect, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createTeamTables } from '../../src/teams/drizzle/schema'
import { createWorkspaceInvitationTable } from '../../src/teams/drizzle/invitations-schema'
import { createWorkspaceAccess } from '../../src/teams/drizzle/access'
import { createInvitationsApi, type InvitationOutcome } from '../../src/teams/invitations-api'
import { inviteUrlForToken } from '../../src/teams/invitations'
import { confirmSettingResponse, InvitationsSection, MembersSection } from '../../src/settings-react'
import type { InvitationView } from '../../src/teams-react/contracts'
import { openDatabase, usersTable, workspacesTable } from './db-helper'

const ORIGIN = 'https://app.test'
const tables = createTeamTables({ userTable: usersTable, workspaceTable: workspacesTable })
const invitationTables = createWorkspaceInvitationTable({ userTable: usersTable, workspaceTable: workspacesTable, organizationTable: tables.organizations })

type Route = (request: Request) => Promise<Response>

async function linkOnlyProduct() {
  const db = openDatabase([usersTable, workspacesTable, tables.organizations, tables.organizationMembers, tables.workspaceMembers, invitationTables.workspaceInvitations])
  await db.insert(usersTable).values({ id: 'owner-1', name: 'Owner', email: 'owner@x.com', emailVerified: true })
  const [org] = await db.insert(tables.organizations).values({ name: 'Acme', slug: 'acme', kind: 'team', createdBy: 'owner-1' }).returning()
  await db.insert(workspacesTable).values({ id: 'ws-1', organizationId: org!.id, name: 'Workspace' })
  await db.insert(tables.organizationMembers).values({ organizationId: org!.id, userId: 'owner-1', role: 'owner' })
  const access = createWorkspaceAccess({ db, tables, workspaceTable: workspacesTable })
  // No `sendInvitationEmail`: this product never emails an invitation.
  const api = createInvitationsApi({ db, tables, invitationsTable: invitationTables, userTable: usersTable, workspaceTable: workspacesTable, access })
  const answer = <T,>(outcome: InvitationOutcome<T>) => outcome.succeeded
    ? Response.json(outcome.value)
    : Response.json({ error: { code: 'invalid', message: outcome.error } }, { status: outcome.status })
  // The signed-in owner comes from the product's session, never from the request body.
  const actor = { userId: 'owner-1', origin: ORIGIN }
  const route: Route = async (request) => {
    const { pathname } = new URL(request.url)
    if (pathname === '/api/invitations' && request.method === 'GET') return answer(await api.listInvitations({ workspaceId: 'ws-1', ...actor }))
    if (pathname === '/api/invitations' && request.method === 'POST') {
      const { email, role } = await request.json() as { email: string; role: string }
      return answer(await api.createInvitation({ workspaceId: 'ws-1', email, permissions: role, invitedByUserId: actor.userId, origin: ORIGIN }))
    }
    const resend = /^\/api\/invitations\/([^/]+)\/resend$/.exec(pathname)
    if (resend && request.method === 'POST') return answer(await api.resendInvitation({ invitationId: resend[1]!, ...actor }))
    return new Response(null, { status: 404 })
  }
  return { db, route }
}

function Team({ route }: { route: Route }) {
  const [invitations, setInvitations] = useState<InvitationView[]>([])
  const reload = useCallback(async () => {
    const body = await (await route(new Request(`${ORIGIN}/api/invitations`))).json() as { invitations: InvitationView[] }
    setInvitations(body.invitations)
  }, [route])
  useEffect(() => { void reload() }, [reload])
  const post = (path: string, body: unknown) => confirmSettingResponse(route(new Request(`${ORIGIN}${path}`, { method: 'POST', body: JSON.stringify(body) })))
  return (
    <>
      <MembersSection
        delivery="link"
        members={[{ id: 'm-1', userId: 'owner-1', role: 'owner', name: 'Owner', email: 'owner@x.com', acceptedAt: 1 }]}
        currentRole="owner"
        currentUserId="owner-1"
        onChangeRole={async () => { throw new Error('not part of this journey') }}
        onRemove={async () => { throw new Error('not part of this journey') }}
        onInvite={async (input) => {
          const outcome = await post('/api/invitations', input)
          if (outcome.succeeded) await reload()
          return outcome
        }}
      />
      <InvitationsSection delivery="link" invitations={invitations} currentRole="owner" onRevoke={async () => { throw new Error('not part of this journey') }} />
    </>
  )
}

describe('link-only invitations', () => {
  it('shows the link the server minted to copy, and neither sends nor mentions email', async () => {
    const { db, route } = await linkOnlyProduct()
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<Team route={route} />)

    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('No email is sent')
    fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: 'new@x.com' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create invite link' }))

    const field = await screen.findByLabelText('Invite link for new@x.com')
    const [row] = await db.select().from(invitationTables.workspaceInvitations)
    const minted = inviteUrlForToken(ORIGIN, row!.token)
    expect((field as HTMLInputElement).value).toBe(minted)
    expect([row!.emailStatus, row!.lastSentAt]).toEqual(['not_sent', null])

    // The new row's Copy link and the pending invitation's both copy the server's link.
    const copies = await screen.findAllByRole('button', { name: 'Copy link' })
    expect(copies).toHaveLength(2)
    for (const copy of copies) fireEvent.click(copy)
    await screen.findAllByText('Link copied')
    expect(writeText.mock.calls).toEqual([[minted], [minted]])

    const pending = screen.getByRole('list', { name: 'Pending invitations' })
    expect(pending.textContent).toContain('new@x.com')
    expect(pending.textContent).not.toMatch(/email/i)
    fireEvent.keyDown(within(pending).getByRole('button', { name: /More actions/ }), { key: 'Enter' })
    await screen.findByRole('menuitem', { name: 'Revoke…' })
    expect(screen.queryByRole('menuitem', { name: 'Resend email' })).toBeNull()

    const resent = await route(new Request(`${ORIGIN}/api/invitations/${row!.id}/resend`, { method: 'POST' }))
    expect(resent.status).toBe(409)
    expect((await db.select().from(invitationTables.workspaceInvitations))[0]!.emailStatus).toBe('not_sent')
  })
})
