import {
  base64UrlDecodeText,
  base64UrlEncodeText,
  constantTimeEqual,
  hmacSha256Base64Url,
} from '../crypto/web-token'
import { ok, fail, type Outcome } from './outcome'

// Terminal-proxy HMAC token. Identity tuple is generic; the secret comes from a
// closure (fail-loud if absent).
/**
 * Define identity details for a terminal proxy including user, workspace, and sandbox identifiers
 *
 * @deprecated Identity shape for the same-origin proxy terminal transport,
 * superseded by the browser-direct scoped-token transport — build the route
 * with `createSandboxTerminalConnectionRoute` (`src/sandbox/terminal-connection.ts`)
 * instead. Three apps still import this seam; retirement is tracked in #350
 * and removal is a major.
 */
export interface TerminalProxyIdentity {
  userId: string
  workspaceId: string
  sandboxId: string
}

const TERMINAL_PROXY_TOKEN_TTL_MS = 15 * 60 * 1000

/**
 * Generate a signed token for TerminalProxyIdentity with an expiration based on TTL milliseconds
 *
 * @deprecated Mints a token for the same-origin proxy terminal transport,
 * superseded by the browser-direct scoped-token transport — build the route
 * with `createSandboxTerminalConnectionRoute` (`src/sandbox/terminal-connection.ts`)
 * instead. Three apps still import this seam; retirement is tracked in #350
 * and removal is a major.
 */
export async function mintTerminalProxyToken(
  secret: string,
  identity: TerminalProxyIdentity,
  ttlMs = TERMINAL_PROXY_TOKEN_TTL_MS,
  now: () => number = Date.now,
): Promise<Outcome<{ token: string; expiresAt: Date }>> {
  if (!secret) return fail(new Error('mintTerminalProxyToken: secret is required'))
  if (!identity.userId || !identity.workspaceId || !identity.sandboxId) {
    return fail(new Error('mintTerminalProxyToken: userId/workspaceId/sandboxId are required'))
  }
  const expiresAt = new Date(now() + ttlMs)
  const payload = { ...identity, exp: Math.floor(expiresAt.getTime() / 1000) }
  const encoded = base64UrlEncodeText(JSON.stringify(payload))
  const sig = await hmacSha256Base64Url(encoded, secret)
  return ok({ token: `${encoded}.${sig}`, expiresAt })
}

/**
 * Verify the authenticity and validity of a terminal proxy token against expected identity and timestamp
 *
 * @deprecated Verifies a token for the same-origin proxy terminal transport,
 * superseded by the browser-direct scoped-token transport — build the route
 * with `createSandboxTerminalConnectionRoute` (`src/sandbox/terminal-connection.ts`)
 * instead. Three apps still import this seam; retirement is tracked in #350
 * and removal is a major.
 */
export async function verifyTerminalProxyToken(
  secret: string,
  token: string,
  expected: TerminalProxyIdentity,
  now: () => number = Date.now,
): Promise<boolean> {
  if (!secret) return false
  const [encoded, sig, extra] = token.split('.')
  if (!encoded || !sig || extra !== undefined) return false
  const expectedSig = await hmacSha256Base64Url(encoded, secret)
  if (!constantTimeEqual(sig, expectedSig)) return false
  let payload: TerminalProxyIdentity & { exp: number }
  try {
    payload = JSON.parse(base64UrlDecodeText(encoded))
  } catch {
    return false
  }
  return (
    payload.userId === expected.userId &&
    payload.workspaceId === expected.workspaceId &&
    payload.sandboxId === expected.sandboxId &&
    Number.isFinite(payload.exp) &&
    payload.exp > Math.floor(now() / 1000)
  )
}
