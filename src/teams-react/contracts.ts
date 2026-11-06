/**
 * Seams between the teams React surface and the host app. Everything here is
 * interface-only and callback-driven: the components never import an app's
 * router, fetch client, or toast system. The host passes data in and supplies
 * the async callbacks (which it backs with `./teams/members-api` or
 * `./teams/invitations-api` over fetch), so the same surface mounts in any app.
 */

import type { WorkspaceRole } from '../teams/roles'
import type { InvitationEmailStatus, InvitationPermission, InvitationStatus } from '../teams/invitations'

/** One member row as the members list renders it — the shape `members-api` returns. */
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

/** One invitation row as the invitations list renders it — the shape `invitations-api` returns. */
export interface InvitationView {
  id: string
  email: string
  permissions: InvitationPermission
  status: InvitationStatus
  emailStatus: InvitationEmailStatus
  /** Date | epoch-ms | ISO string — normalized to a Date for display. */
  expiresAt: Date | number | string
  /** When the invitee joined. An accepted row reads "joined <date>" instead of its expiry. */
  acceptedAt?: Date | number | string | null
  /** Shareable accept link, for copy-to-clipboard. */
  inviteUrl: string
}

/** Define possible statuses for the acceptance state of an invitation */
export type InviteAcceptStatus = 'pending' | 'invalid' | 'already-accepted' | 'expired' | 'revoked'

/** Describe details of an accepted invite including status, workspace, inviter, role, emails, and expiration */
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

/** Define properties and callbacks for handling invite acceptance and navigation actions on the invite page */
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
