// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import type { InvitationView } from '../contracts'
import { InvitationsPanel } from './InvitationsPanel'
import { MembersPanel } from './MembersPanel'

afterEach(cleanup)

function invitation(over: Partial<InvitationView>): InvitationView {
  return {
    id: 'inv-1',
    email: 'deploy-smoke@tangle.example',
    permissions: 'editor',
    status: 'pending',
    emailStatus: 'sent',
    expiresAt: '2026-10-15T12:00:00Z',
    inviteUrl: 'https://app.example/invite/inv_1',
    ...over,
  }
}

function panel(invitations: InvitationView[], onInvite = vi.fn().mockResolvedValue(undefined)) {
  render(
    <InvitationsPanel
      invitations={invitations}
      currentRole="owner"
      onInvite={onInvite}
      onResend={vi.fn()}
      onRevoke={vi.fn()}
    />,
  )
  return onInvite
}

describe('InvitationsPanel history', () => {
  it('shows an accepted invitation as one Joined state with its date, never an expiry or a delivery badge', () => {
    panel([invitation({ status: 'accepted', acceptedAt: '2026-10-09T12:00:00Z' })])
    const row = screen.getByText('deploy-smoke@tangle.example').closest('div.rounded-lg') as HTMLElement
    expect(within(row).getByText('Joined')).toBeTruthy()
    expect(within(row).getByText('Editor · joined Oct 9, 2026')).toBeTruthy()
    expect(row.textContent).not.toMatch(/expires|sent/i)
    expect(within(row).queryByRole('button')).toBeNull()
  })

  it('says in words whether a pending invitation was emailed, beside when it expires', () => {
    panel([
      invitation({ id: 'a', email: 'a@x.com' }),
      invitation({ id: 'b', email: 'b@x.com', emailStatus: 'failed' }),
    ])
    expect(screen.getByText('Editor · email sent · expires Oct 15, 2026')).toBeTruthy()
    expect(screen.getByText('The email was not delivered. Copy the link and send it yourself.')).toBeTruthy()
    expect(screen.getAllByText('Pending')).toHaveLength(2)
  })
})

describe('invite by email', () => {
  it('keeps Invite disabled until the address could be delivered to, and says why once the field is left', async () => {
    const onInvite = panel([])
    const input = screen.getByLabelText('Invite by email')
    const invite = screen.getByRole('button', { name: 'Invite' }) as HTMLButtonElement

    fireEvent.change(input, { target: { value: 'founder@' } })
    expect(invite.disabled).toBe(true)
    expect(screen.queryByRole('alert')).toBeNull()

    fireEvent.blur(input)
    expect(screen.getByRole('alert').textContent).toBe('Enter a full email address, such as name@company.com.')
    expect(input.getAttribute('aria-invalid')).toBe('true')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onInvite).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: ' founder@shiftkite.com ' } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(invite.disabled).toBe(false)
    fireEvent.click(invite)
    await waitFor(() => expect(onInvite).toHaveBeenCalledWith({ email: 'founder@shiftkite.com', role: 'editor' }))
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''))
  })

  it('keeps the address for a retry when the invite is refused', async () => {
    const onNotice = vi.fn()
    render(
      <MembersPanel
        members={[]}
        currentRole="admin"
        onInvite={vi.fn().mockRejectedValue(new Error('Seat limit reached'))}
        onChangeRole={vi.fn()}
        onRemove={vi.fn()}
        onNotice={onNotice}
      />,
    )
    const input = screen.getByLabelText('Invite member') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'founder@shiftkite.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith({ kind: 'error', message: 'Seat limit reached' }))
    expect(input.value).toBe('founder@shiftkite.com')
  })
})
