// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { InvitationView } from '../contracts'
import { InvitationsPanel } from './InvitationsPanel'
import { MembersPanel } from './MembersPanel'

afterEach(cleanup)

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
