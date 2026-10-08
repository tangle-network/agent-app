/**
 * Pure invitation helpers for the teams capability. Zero dependencies: no
 * drizzle, no env, no react, no network. The lifecycle API (`./invitations-api`)
 * and an app's own mail transport build on these; the invitation email itself
 * is `inviteEmail` from `@tangle-network/agent-app/email`.
 */

import type { AssignableWorkspaceRole } from './roles'

/** The role an invitation grants — the assignable workspace ladder (never owner). */
export type InvitationPermission = AssignableWorkspaceRole

/** Define possible states for an invitation's lifecycle including pending, accepted, expired, and revoked */
export type InvitationStatus = 'pending' | 'accepted' | 'expired' | 'revoked'
/** Define possible statuses for the sending state of an invitation email */
export type InvitationEmailStatus = 'not_sent' | 'sent' | 'failed'

/** Define the number of days before an invitation expires */
export const INVITATION_EXPIRY_DAYS = 7

const INVITATION_PERMISSIONS = ['admin', 'editor', 'viewer'] as const
const TOKEN_BYTE_LENGTH = 32

/** Normalize an invitation email by trimming whitespace and converting to lowercase */
export function normalizeInvitationEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Resolve invitation permission from a string or return null if invalid */
export function parseInvitationPermission(value: string | undefined): InvitationPermission | null {
  return INVITATION_PERMISSIONS.includes(value as InvitationPermission) ? (value as InvitationPermission) : null
}

/** Calculate the expiration date of an invitation based on the given or current date */
export function getInvitationExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000)
}

/**
 * A cryptographically-random, URL-safe invitation token. `inv_`-prefixed so a
 * token is self-identifying and never collides with the workspaceMember invite
 * tokens minted by `members-api` (`generateInviteToken`).
 */
export function generateInvitationToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTE_LENGTH)
  globalThis.crypto.getRandomValues(bytes)
  const token = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
  return `inv_${btoa(token).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`
}

/** Generate an invite URL by combining the origin with an encoded token */
export function inviteUrlForToken(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/invite/${encodeURIComponent(token)}`
}
