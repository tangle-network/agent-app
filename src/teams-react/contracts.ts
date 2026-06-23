/**
 * Seams between the teams React surface and the host app. Everything here is
 * interface-only and callback-driven: the components never import an app's
 * router, fetch client, or toast system. The host passes data in and supplies
 * the async callbacks (which it backs with `./teams/members-api` or
 * `./teams/invitations-api` over fetch), so the same panel mounts in any app.
 */

import type { WorkspaceRole } from '../teams/roles'
import type { InvitationEmailStatus, InvitationPermission, InvitationStatus } from '../teams/invitations'

/** One member row as the panel renders it — the shape `members-api` returns. */
export interface MemberView {
  id: string
  userId: string | null
  role: WorkspaceRole
  name: string | null
  email: string | null
  /** null/undefined = pending invite (not yet accepted). */
  acceptedAt?: Date | number | null
  /** true = inherited org owner/admin access (managed at the org level). */
  inherited?: boolean
}

export interface MembersPanelProps {
  members: MemberView[]
  /** The viewer's effective role — gates which controls are interactive. */
  currentRole: WorkspaceRole
  /** Invite a member; resolve with the shareable invite URL (or void). */
  onInvite(input: { email: string; role: WorkspaceRole }): Promise<{ inviteUrl?: string } | void>
  /** Change a member's role. */
  onChangeRole(input: { memberId: string; role: WorkspaceRole }): Promise<void>
  /** Remove a member. */
  onRemove(input: { memberId: string }): Promise<void>
  /** Optional toast/notice hook; defaults to a no-op (host owns its UX). */
  onNotice?(notice: { kind: 'success' | 'error'; message: string }): void
  /**
   * Show the built-in invite form. Default `true`. An app that drives invites
   * through `InvitationsPanel` (the rich email flow) sets this `false` so the
   * members panel is list-only and the two don't present competing invite UIs.
   */
  showInviteForm?: boolean
}

/** One invitation row as `InvitationsPanel` renders it — the shape `invitations-api` returns. */
export interface InvitationView {
  id: string
  email: string
  permissions: InvitationPermission
  status: InvitationStatus
  emailStatus: InvitationEmailStatus
  /** Date | epoch-ms | ISO string — normalized to a Date for display. */
  expiresAt: Date | number | string
  /** Shareable accept link, for copy-to-clipboard. */
  inviteUrl: string
}

export interface InvitationsPanelProps {
  invitations: InvitationView[]
  /** The viewer's effective role — gates whether the invite controls are interactive. */
  currentRole: WorkspaceRole
  /** Create an invitation (sends the email); resolve with the shareable URL (or void). */
  onInvite(input: { email: string; role: WorkspaceRole }): Promise<{ inviteUrl?: string } | void>
  /** Resend the invitation email. */
  onResend(input: { invitationId: string }): Promise<void>
  /** Revoke a pending invitation. */
  onRevoke(input: { invitationId: string }): Promise<void>
  /** Copy the invite link; defaults to `navigator.clipboard.writeText`. */
  onCopy?(input: { inviteUrl: string }): void | Promise<void>
  /** Optional toast/notice hook; defaults to a no-op (host owns its UX). */
  onNotice?(notice: { kind: 'success' | 'error'; message: string }): void
}

export type InviteAcceptStatus = 'pending' | 'invalid' | 'already-accepted' | 'expired' | 'revoked'

export interface InviteAcceptDetails {
  status: InviteAcceptStatus
  /** Workspace the invite grants access to. */
  workspaceName?: string | null
  /** Who sent it, if known. */
  inviterName?: string | null
  /** Role the invite grants. */
  role?: WorkspaceRole | null
  /** Email the invite was addressed to. */
  inviteEmail?: string | null
  /** The signed-in user's email, or null if not signed in. */
  currentUserEmail?: string | null
  /** When the invite expires (for display). Date | epoch-ms | ISO string. */
  expiresAt?: Date | number | string | null
  /** True when the signed-in user must verify their email before they can accept. */
  needsEmailVerification?: boolean
}

export interface InviteAcceptPageProps {
  details: InviteAcceptDetails
  /** Accept the invite; resolve with the workspace to navigate to. */
  onAccept(): Promise<{ workspaceId?: string } | void>
  /** Navigate (sign in / sign up / switch account / open app). */
  onNavigate(target: { kind: 'sign-in' | 'sign-up' | 'switch-account' | 'open-app'; workspaceId?: string }): void
  /**
   * Resend the verification email. Only invoked on the `needsEmailVerification`
   * branch; an app without email verification omits it and that branch never shows.
   */
  onResendVerification?(): Promise<void>
}
