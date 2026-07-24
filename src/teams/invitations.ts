/**
 * Pure invitation helpers + email-template renderer for the teams capability.
 * Zero dependencies: no drizzle, no env, no react, no network. The lifecycle API
 * (`./invitations-api`) and an app's own mail transport build on these; this leaf
 * imports nothing back, so a consumer can pull just the token/expiry math or the
 * template renderer without dragging in drizzle or a mail client.
 *
 * `renderInvitationEmail` is deliberately transport-free: it returns the
 * `{ from, subject, html, text }` an app hands to its own Resend/SES/etc. The
 * secret (API key) and the network call stay in the app's seam — agent-app ships
 * only the deterministic template.
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

// ── email template (pure; no transport) ──

/** Define input data required to render an invitation email template */
export interface RenderInvitationEmailInput {
  to: string
  workspaceName: string
  inviterEmail: string
  permission: string
  inviteUrl: string
  expiresAt: Date
}

/** Define the structure for an invitation email brand including the RFC-5322 From header */
export interface InvitationEmailBrand {
  /** RFC-5322 From header, e.g. `GTM Agent <noreply@gtm.tangle.tools>`. */
  fromAddress: string
}

/** Define the structure of a fully rendered invitation email with sender, subject, and content fields */
export interface RenderedInvitationEmail {
  from: string
  subject: string
  html: string
  text: string
}

/**
 * Render the invitation email body — pure, deterministic, transport-free. The
 * caller passes the result to its own mail client; this never reads a secret or
 * touches the network.
 */
export function renderInvitationEmail(
  input: RenderInvitationEmailInput,
  brand: InvitationEmailBrand,
): RenderedInvitationEmail {
  const role = input.permission.toLowerCase()
  const expiry = input.expiresAt.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
  return {
    from: brand.fromAddress,
    subject: `${input.inviterEmail} invited you to ${input.workspaceName}`,
    html: [
      `<p>${escapeHtml(input.inviterEmail)} invited you to join <strong>${escapeHtml(input.workspaceName)}</strong> as ${escapeHtml(role)}.</p>`,
      `<p><a href="${input.inviteUrl}">Accept the invitation</a></p>`,
      `<p>This invitation expires on ${expiry}.</p>`,
    ].join(''),
    text: [
      `${input.inviterEmail} invited you to join ${input.workspaceName} as ${role}.`,
      `Accept the invitation: ${input.inviteUrl}`,
      `This invitation expires on ${expiry}.`,
    ].join('\n\n'),
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
