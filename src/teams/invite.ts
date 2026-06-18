/**
 * Pure invite-token helpers — generation, shape validation, and expiry math.
 * No I/O: the members API persists/looks up tokens; these functions only
 * produce well-formed tokens and decide, given values the caller already
 * loaded, whether an invite is usable.
 *
 * A token is an opaque high-entropy URL-safe string. It is the bearer secret
 * in `/invite/:token`, so it must be unguessable and never derived from the
 * email or workspace. `generateInviteToken` uses Web Crypto (`crypto`), which
 * is present in Workers, Node 18+, Deno, and browsers — no Node-only import,
 * so this stays a pure leaf.
 */

const INVITE_TOKEN_BYTES = 24
const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,}$/

/** Cryptographically-random, URL-safe (base64url) invite token. */
export function generateInviteToken(): string {
  const bytes = new Uint8Array(INVITE_TOKEN_BYTES)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

/** True when `value` has the shape of an invite token (not whether it exists). */
export function isInviteTokenShape(value: unknown): value is string {
  return typeof value === 'string' && INVITE_TOKEN_PATTERN.test(value)
}

/** A pending invite row, narrowed to the fields invite acceptance reasons over. */
export interface InviteTokenState {
  /** null until accepted — a non-null value means the invite was already used. */
  acceptedAt: Date | number | null | undefined
  /** Email the invite was addressed to, if any. */
  inviteEmail?: string | null
  /** Optional hard expiry; omit/undefined for invites that never expire. */
  expiresAt?: Date | number | null
}

export type InviteRejectionReason = 'already-accepted' | 'expired' | 'email-mismatch'

export interface InviteValidationResult {
  ok: boolean
  reason?: InviteRejectionReason
}

/**
 * Decide whether a loaded invite can be accepted by `acceptingEmail` at `now`.
 * Pure: the caller has already fetched the row by token; this only judges it.
 * Email match is case-insensitive and only enforced when the invite was
 * addressed to a specific email (an open invite has no `inviteEmail`).
 */
export function validateInviteToken(
  invite: InviteTokenState,
  opts: { acceptingEmail?: string | null; now?: Date } = {},
): InviteValidationResult {
  if (invite.acceptedAt != null) return { ok: false, reason: 'already-accepted' }

  if (invite.expiresAt != null) {
    const now = (opts.now ?? new Date()).getTime()
    const expires = invite.expiresAt instanceof Date ? invite.expiresAt.getTime() : Number(invite.expiresAt)
    if (Number.isFinite(expires) && now >= expires) return { ok: false, reason: 'expired' }
  }

  if (invite.inviteEmail && opts.acceptingEmail) {
    if (invite.inviteEmail.trim().toLowerCase() !== opts.acceptingEmail.trim().toLowerCase()) {
      return { ok: false, reason: 'email-mismatch' }
    }
  }

  return { ok: true }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const base64 = typeof btoa === 'function' ? btoa(binary) : bufferToBase64(binary)
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function bufferToBase64(binary: string): string {
  // Node without a global `btoa` (older runtimes); Buffer is always present there.
  return Buffer.from(binary, 'binary').toString('base64')
}
