/**
 * Who has access and what each person can do, as settings cards built on the
 * teams panels' contracts and rules: the same `MemberView` and
 * `InvitationView` rows, the same role ladder and invite check, and roles
 * named by capability. A role change saves at once and says so in its row;
 * removing a person or revoking an invitation asks first and stays open on a
 * refusal. On a narrow card the role picker takes its own full-width line
 * under the name.
 */

import {
  Avatar,
  AvatarFallback,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Input,
  Label,
  SettingsList,
  SettingsListItem,
  SettingsRow,
  SettingsSection,
  type SettingsListMenuItem,
} from '@tangle-network/ui/primitives'
import { ChevronDown } from 'lucide-react'
import { Fragment, useEffect, useId, useState, type ReactNode } from 'react'
import { INVITATION_EMAIL_HINT, INVITATION_EXPIRY_DAYS, isInvitationEmail } from '../teams/invitations'
import { hasWorkspaceRole, type WorkspaceRole } from '../teams/roles'
import type { InvitationView, MemberView } from '../teams-react/contracts'
import { invitationDetail } from '../teams-react/components/invitation-detail'
import { canManageMember, isCurrentMember, memberRoleLabel } from '../teams-react/components/member-access'
import { RoleSelect } from '../teams-react/components/RoleSelect'
import { confirmWrite, type MutationOutcome } from '../web-react/async'
import { ConfirmAction } from './confirm-action'
import { PlainLink, type SettingsLinkComponent } from './settings-layout'
import type { SettingFailure } from './setting-outcome'
import { SAVED_VISIBLE_MS } from './save-status'
import { useSettingField } from './use-setting-field'

export interface MembersSectionProps {
  /** The card's anchor. */
  id?: string
  title?: string
  /** One line under the title, such as the seat count. */
  description?: ReactNode
  members: MemberView[]
  /** The viewer's effective role: admins change roles, remove people and invite. */
  currentRole: WorkspaceRole
  /** The viewer's user id, so their own row offers no role change or removal. */
  currentUserId?: string | null
  /** The noun people lose access to, as in "lose access to this project". */
  noun?: string
  onChangeRole(input: { memberId: string; role: WorkspaceRole }): Promise<MutationOutcome<unknown>>
  onRemove(input: { memberId: string }): Promise<MutationOutcome<unknown>>
  /** Adds the Invite action. A refusal (a seat limit, a failed email) stays in the dialog with its sentence. */
  onInvite?(input: { email: string; role: WorkspaceRole }): Promise<MutationOutcome<unknown>>
  /** The plans page. A `plan_limit` refusal on Invite links to it as View plans. */
  plansHref?: string
  /** Renders View plans: pass the router's link, as to `SettingsLayout`. Defaults to a plain anchor. */
  LinkComponent?: SettingsLinkComponent
  /** More ⋯ items for a member the viewer can manage, such as "Make team owner…". */
  menuItems?(member: MemberView): SettingsListMenuItem[]
}

/** An address that wraps after `@`, a dot or a hyphen before it wraps mid-word. */
function breakable(address: string): ReactNode {
  const parts = address.split(/(?<=[@.\-_])/)
  return parts.map((part, index) => <Fragment key={index}>{part}{index < parts.length - 1 && <wbr />}</Fragment>)
}

function displayName(member: MemberView): string {
  return member.name ?? member.email ?? 'Unknown'
}

function initials(member: MemberView): string {
  const name = displayName(member)
  const parts = name.split(/[\s@._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '?') + (member.name ? parts[1]?.[0] ?? '' : '')).toUpperCase()
}

// The avatar rides in the title rather than a leading column, so on a narrow
// card the role picker's own line starts at the card's edge and the longest
// capability name fits.
const MEMBER_COLUMNS = { status: '18rem', menu: '36px' }

/** A member's role, saved the moment it is picked. */
function useMemberRole(member: MemberView, onChangeRole: MembersSectionProps['onChangeRole']) {
  const field = useSettingField<WorkspaceRole>({
    saved: member.role,
    save: async (role) => {
      const outcome = await onChangeRole({ memberId: member.id, role })
      return outcome.succeeded ? confirmWrite(role) : outcome
    },
  })
  return { field, select: <RoleSelect id={`role-${member.id}`} value={field.draft} ariaLabel={`Role for ${displayName(member)}`} onChange={field.setDraft} /> }
}

function MemberItem({ member, editable, self, noun, onChangeRole, onRemove, extraMenu }: {
  member: MemberView
  editable: boolean
  self: boolean
  noun: string
  onChangeRole: MembersSectionProps['onChangeRole']
  onRemove: MembersSectionProps['onRemove']
  extraMenu: SettingsListMenuItem[]
}) {
  const [removing, setRemoving] = useState(false)
  const { field, select } = useMemberRole(member, onChangeRole)
  const name = displayName(member)
  const pending = member.acceptedAt == null
  const email = member.name && member.email ? member.email : null
  const status = field.rowProps.status
  return (
    <>
      <SettingsListItem
        title={
          <span className="flex min-w-0 items-center gap-3">
            <Avatar size="sm"><AvatarFallback>{initials(member)}</AvatarFallback></Avatar>
            <span className="min-w-0">
              <span className="block">{name}{self && <span className="font-normal text-muted-foreground"> (you)</span>}</span>
              {(email || pending || status) && (
                <span className="flex flex-wrap items-center gap-x-2 font-normal text-muted-foreground">
                  <span>{email && breakable(email)}{email && pending && ' · '}{pending && 'Hasn’t joined yet'}</span>
                  {status}
                </span>
              )}
            </span>
          </span>
        }
        status={editable ? select : <span className="text-foreground">{memberRoleLabel(member)}</span>}
        error={field.rowProps.error}
        menu={editable ? [...extraMenu, { label: `Remove from ${noun}…`, tone: 'danger', onSelect: () => setRemoving(true) }] : undefined}
      />
      {editable && (
        <ConfirmAction
          open={removing}
          onOpenChange={setRemoving}
          title={`Remove ${name}?`}
          consequence={`${name} loses access to this ${noun} at once. Their chats and files stay.`}
          confirmLabel="Remove"
          tone="danger"
          onConfirm={() => onRemove({ memberId: member.id })}
        />
      )}
    </>
  )
}

/** View plans after a plan-limit refusal, as an inline link after the sentence. */
function plansAction(href: string | undefined, Link: SettingsLinkComponent) {
  if (!href) return undefined
  return (failure: SettingFailure) => failure.code === 'plan_limit'
    ? <Link href={href} className="font-medium text-[var(--accent-text)] underline-offset-4 hover:underline">View plans</Link>
    : null
}

function InviteDialog({ onInvite, plansHref, LinkComponent, open, onOpenChange }: {
  onInvite: NonNullable<MembersSectionProps['onInvite']>
  plansHref?: string
  LinkComponent: SettingsLinkComponent
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const id = useId()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<WorkspaceRole>('editor')
  const [checked, setChecked] = useState(false)
  useEffect(() => {
    if (!open) return
    setEmail('')
    setRole('editor')
    setChecked(false)
  }, [open])
  const valid = isInvitationEmail(email)
  const showHint = checked && email.trim() !== '' && !valid
  return (
    <ConfirmAction
      open={open}
      onOpenChange={onOpenChange}
      title="Invite people"
      consequence={`They get an email with a link to join. The link works for ${INVITATION_EXPIRY_DAYS} days.`}
      confirmLabel="Send invite"
      canConfirm={valid}
      onConfirm={() => onInvite({ email: email.trim(), role })}
      refusalAction={plansAction(plansHref, LinkComponent)}
    >
      <div className="grid gap-2">
        <Label htmlFor={`${id}-email`}>Email</Label>
        <Input
          id={`${id}-email`}
          type="email"
          inputMode="email"
          autoComplete="off"
          value={email}
          variant={showHint ? 'error' : undefined}
          aria-describedby={showHint ? `${id}-hint` : undefined}
          onChange={(event) => setEmail(event.target.value)}
          onBlur={() => setChecked(true)}
        />
        {showHint && <p id={`${id}-hint`} role="alert" className="text-sm text-[var(--surface-danger-text)]">{INVITATION_EMAIL_HINT}</p>}
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-role`}>Role</Label>
        <RoleSelect id={`${id}-role`} value={role} ariaLabel="Role" onChange={setRole} />
      </div>
    </ConfirmAction>
  )
}

export function MembersSection({
  id = 'members',
  title = 'Members',
  description,
  members,
  currentRole,
  currentUserId,
  noun = 'project',
  onChangeRole,
  onRemove,
  onInvite,
  plansHref,
  LinkComponent = PlainLink,
  menuItems,
}: MembersSectionProps) {
  const [inviting, setInviting] = useState(false)
  const canManage = hasWorkspaceRole(currentRole, 'admin')
  return (
    <SettingsSection
      id={id}
      title={title}
      description={description}
      actions={canManage && onInvite ? <Button type="button" onClick={() => setInviting(true)}>Invite</Button> : undefined}
    >
      {members.length === 0
        ? <SettingsRow label="No members yet" description="Invite someone to work on this with you." layout="compact" />
        : (
          <SettingsList aria-label={title} columns={MEMBER_COLUMNS}>
            {members.map((member) => {
              const editable = canManageMember(member, currentRole, currentUserId)
              return (
                <MemberItem
                  key={member.id}
                  member={member}
                  editable={editable}
                  self={isCurrentMember(member, currentUserId)}
                  noun={noun}
                  onChangeRole={onChangeRole}
                  onRemove={onRemove}
                  extraMenu={editable && menuItems ? menuItems(member) : []}
                />
              )
            })}
          </SettingsList>
        )}
      {onInvite && <InviteDialog onInvite={onInvite} plansHref={plansHref} LinkComponent={LinkComponent} open={inviting} onOpenChange={setInviting} />}
    </SettingsSection>
  )
}

export interface InvitationsSectionProps {
  id?: string
  title?: string
  invitations: InvitationView[]
  /** The viewer's effective role: admins copy, resend and revoke. */
  currentRole: WorkspaceRole
  onResend(input: { invitationId: string }): Promise<MutationOutcome<unknown>>
  onRevoke(input: { invitationId: string }): Promise<MutationOutcome<unknown>>
  /** Copies the invite link; defaults to `navigator.clipboard.writeText`. */
  onCopy?(input: { inviteUrl: string }): void | Promise<void>
}

const INVITATION_COLUMNS = { action: '8rem', menu: '36px' }

function useFlash(): [string | null, (message: string) => void] {
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => setMessage(null), SAVED_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [message])
  return [message, setMessage]
}

function PendingInvitation({ invitation, canManage, onResend, onRevoke, onCopy }: {
  invitation: InvitationView
  canManage: boolean
} & Pick<InvitationsSectionProps, 'onResend' | 'onRevoke' | 'onCopy'>) {
  const [revoking, setRevoking] = useState(false)
  const [note, flash] = useFlash()
  const [error, setError] = useState<string | null>(null)
  const copy = async () => {
    try {
      if (onCopy) await onCopy({ inviteUrl: invitation.inviteUrl })
      else await navigator.clipboard.writeText(invitation.inviteUrl)
      setError(null)
      flash('Link copied')
    } catch {
      setError("Couldn't copy the link. Select it from the invitation email instead.")
    }
  }
  const resend = async () => {
    const outcome = await onResend({ invitationId: invitation.id })
    if (outcome.succeeded) {
      setError(null)
      flash('Sent again')
    } else setError(outcome.message)
  }
  const undelivered = invitation.emailStatus === 'failed' ? 'The email wasn’t delivered. Copy the link and send it yourself.' : null
  return (
    <>
      <SettingsListItem
        title={breakable(invitation.email)}
        meta={<span className="inline-flex flex-wrap items-center gap-x-2">{invitationDetail(invitation)}{note && <span className="text-[var(--surface-success-text)]">{note}</span>}</span>}
        error={error ?? undelivered ?? undefined}
        action={canManage ? { label: 'Copy link', onSelect: () => void copy() } : undefined}
        menu={canManage ? [
          { label: 'Resend email', onSelect: () => void resend() },
          { label: 'Revoke…', tone: 'danger', onSelect: () => setRevoking(true) },
        ] : undefined}
      />
      {canManage && (
        <ConfirmAction
          open={revoking}
          onOpenChange={setRevoking}
          title={`Revoke the invitation to ${invitation.email}?`}
          consequence="The link stops working at once. You can invite them again later."
          confirmLabel="Revoke"
          tone="danger"
          onConfirm={() => onRevoke({ invitationId: invitation.id })}
        />
      )}
    </>
  )
}

export function InvitationsSection({
  id = 'invitations',
  title = 'Invitations',
  invitations,
  currentRole,
  onResend,
  onRevoke,
  onCopy,
}: InvitationsSectionProps) {
  const [showPast, setShowPast] = useState(false)
  const canManage = hasWorkspaceRole(currentRole, 'admin')
  const pending = invitations.filter((invitation) => invitation.status === 'pending')
  const past = invitations.filter((invitation) => invitation.status !== 'pending')
  return (
    <SettingsSection id={id} title={title}>
      {pending.length === 0
        ? <SettingsRow label="No pending invitations" layout="compact" />
        : (
          <SettingsList aria-label="Pending invitations" columns={INVITATION_COLUMNS}>
            {pending.map((invitation) => (
              <PendingInvitation key={invitation.id} invitation={invitation} canManage={canManage} onResend={onResend} onRevoke={onRevoke} onCopy={onCopy} />
            ))}
          </SettingsList>
        )}
      {past.length > 0 && (
        <Collapsible open={showPast} onOpenChange={setShowPast}>
          <div className="border-t border-[color:var(--border-subtle)] px-5 py-3 @max-[34rem]/settings-section:px-4">
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" className="-ml-4">
                {showPast ? 'Hide past invitations' : `Show ${past.length} past ${past.length === 1 ? 'invitation' : 'invitations'}`}
                <ChevronDown aria-hidden="true" className={showPast ? 'rotate-180' : undefined} />
              </Button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <SettingsList aria-label="Past invitations" columns={{}}>
              {past.map((invitation) => (
                <SettingsListItem key={invitation.id} title={breakable(invitation.email)} meta={invitationDetail(invitation)} />
              ))}
            </SettingsList>
          </CollapsibleContent>
        </Collapsible>
      )}
    </SettingsSection>
  )
}
