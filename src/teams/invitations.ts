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

export type InvitationStatus = 'pending' | 'accepted' | 'expired' | 'revoked'
export type InvitationEmailStatus = 'not_sent' | 'sent' | 'failed'

export const INVITATION_EXPIRY_DAYS = 7

const INVITATION_PERMISSIONS = ['admin', 'editor', 'viewer'] as const
const TOKEN_BYTE_LENGTH = 32

export function normalizeInvitationEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function parseInvitationPermission(value: string | undefined): InvitationPermission | null {
  return INVITATION_PERMISSIONS.includes(value as InvitationPermission) ? (value as InvitationPermission) : null
}

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

export function inviteUrlForToken(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/invite/${encodeURIComponent(token)}`
}

// ── email template (pure; no transport) ──

export interface RenderInvitationEmailInput {
  to: string
  workspaceName: string
  inviterEmail: string
  permission: string
  inviteUrl: string
  expiresAt: Date
}

export interface InvitationEmailBrand {
  /** RFC-5322 From header, e.g. `GTM Agent <noreply@gtm.tangle.tools>`. */
  fromAddress: string
}

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
