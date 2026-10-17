/**
 * The invite-by-email row both team panels share: address, role, Invite. The
 * address is checked with the same rule the invitations API enforces, so
 * Invite stays disabled until the address could be delivered to, and the
 * reason appears under the field once the person leaves it or tries to send.
 * On a narrow card the field, the role and Invite stack, the role at full
 * width so its longest name fits, and nothing passes the card's edge.
 */

import { Button, Input } from '@tangle-network/ui/primitives'
import { useId, useState } from 'react'
import type { WorkspaceRole } from '../../teams/roles'
import { INVITATION_EMAIL_HINT, isInvitationEmail } from '../../teams/invitations'
import { RoleSelect } from './RoleSelect'

interface InviteFormProps {
  label: string
  placeholder: string
  /** Send the invite; resolve true to clear the field, false to keep it for a retry. */
  onInvite(input: { email: string; role: WorkspaceRole }): Promise<boolean>
}

export function InviteForm({ label, placeholder, onInvite }: InviteFormProps) {
  const id = useId()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<WorkspaceRole>('editor')
  const [inviting, setInviting] = useState(false)
  // Reward early, flag late: the hint waits until the person leaves the field
  // or tries to send, then follows every keystroke until the address is valid.
  const [checked, setChecked] = useState(false)

  const valid = isInvitationEmail(email)
  const showHint = checked && email.trim() !== '' && !valid

  async function submit() {
    if (inviting) return
    if (!valid) {
      setChecked(true)
      return
    }
    setInviting(true)
    try {
      if (await onInvite({ email: email.trim(), role })) {
        setEmail('')
        setChecked(false)
      }
    } finally {
      setInviting(false)
    }
  }

  return (
    <div className="@container/invite flex flex-col gap-1.5">
      <label htmlFor={`${id}-email`} className="text-sm font-medium text-[var(--text-secondary)]">{label}</label>
      <div className="flex flex-wrap gap-2">
        <Input
          id={`${id}-email`}
          type="email"
          inputMode="email"
          autoComplete="off"
          placeholder={placeholder}
          value={email}
          variant={showHint ? 'error' : undefined}
          aria-describedby={showHint ? `${id}-hint` : undefined}
          onChange={(event) => setEmail(event.target.value)}
          onBlur={() => setChecked(true)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submit()
            }
          }}
          className="min-w-[12rem] flex-1"
        />
        <div className="w-72 shrink-0 @max-[36rem]/invite:w-full">
          <RoleSelect value={role} ariaLabel="Invite role" onChange={setRole} />
        </div>
        <Button type="button" className="ml-auto" onClick={() => void submit()} disabled={inviting || !valid}>
          {inviting ? 'Inviting…' : 'Invite'}
        </Button>
      </div>
      {showHint && (
        <p id={`${id}-hint`} role="alert" className="text-sm text-[var(--surface-danger-text)]">
          {INVITATION_EMAIL_HINT}
        </p>
      )}
    </div>
  )
}
