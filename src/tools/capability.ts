/**
 * Per-user capability token — the sandbox→app auth primitive behind the
 * `verifyToken` seam in {@link authenticateToolRequest}.
 *
 * An app-agent runs inside the sandbox and reaches the host app back over HTTP
 * (the app tools, the integration-invoke bridge). The route must act AS the
 * connecting user without trusting any model-supplied identity, so the turn
 * mints a short HMAC token bound to the user id and bakes it into the per-turn
 * MCP server header; the route verifies it to recover the user.
 *
 * `HMAC-SHA256(secret, "user:<userId>")`, base64url, with an app-chosen prefix.
 * The token encodes no scopes — the hub's policy engine authorizes per action.
 * Fail-closed: with no secret, no token is minted (the caller MUST omit the MCP
 * server rather than fake an authorized call). WebCrypto only — runs on
 * Workers, Node, and the browser with no Node `crypto` dependency.
 */

import {
  base64UrlDecodeText,
  base64UrlEncodeText,
  constantTimeEqual,
  hmacSha256Base64Url,
} from '../crypto/web-token'

export interface CapabilityTokenOptions {
  /** Shared HMAC secret. When absent, mint returns undefined / verify returns false. */
  secret?: string
  /** Token prefix (namespaces the credential; lets verify reject foreign tokens
   *  cheaply). Default `cap_`. */
  prefix?: string
}

/** Mint a capability token for `userId`, or `undefined` when no secret is
 *  configured (fail-closed — the caller omits the MCP server rather than fake it). */
export async function createCapabilityToken(userId: string, opts: CapabilityTokenOptions): Promise<string | undefined> {
  const secret = opts.secret?.trim()
  if (!secret) return undefined
  const prefix = opts.prefix ?? 'cap_'
  return `${prefix}${await sign(userId, secret)}`
}

/** Verify a capability token against `userId`. Returns false (never throws) for
 *  an unconfigured secret, a wrong prefix, a malformed token, or a mismatch. */
export async function verifyCapabilityToken(userId: string, token: string, opts: CapabilityTokenOptions): Promise<boolean> {
  const secret = opts.secret?.trim()
  const prefix = opts.prefix ?? 'cap_'
  if (!secret || !token.startsWith(prefix)) return false
  const expected = `${prefix}${await sign(userId, secret)}`
  return constantTimeEqual(token, expected)
}

export interface ExpiringCapabilityTokenOptions extends CapabilityTokenOptions {
  /** Token lifetime. Expired tokens verify false regardless of signature. */
  expiresInMs: number
  /** Clock injection for tests; defaults to Date.now. */
  now?: () => number
}

/**
 * Mint an EXPIRING capability token: `<prefix><base64url(payload)>.<sig>` where
 * the payload carries `{ sub, exp, n }` (subject, epoch-ms expiry, random
 * nonce) and the signature is HMAC-SHA256 over the encoded payload. Use this
 * for user-initiated scoped channels (e.g. a per-sequence MCP endpoint) where
 * a captured token must not stay valid past its window; the bare
 * {@link createCapabilityToken} remains for turn-scoped tool bridges whose
 * mint+verify happen inside one request cycle. Fail-closed like the bare
 * variant: no secret → no token.
 */
export async function createExpiringCapabilityToken(subject: string, opts: ExpiringCapabilityTokenOptions): Promise<string | undefined> {
  const secret = opts.secret?.trim()
  if (!secret) return undefined
  if (!Number.isFinite(opts.expiresInMs) || opts.expiresInMs <= 0) throw new Error('expiresInMs must be a positive number')
  const prefix = opts.prefix ?? 'cap_'
  const now = opts.now ?? Date.now
  const payload = base64UrlEncodeText(JSON.stringify({ sub: subject, exp: now() + opts.expiresInMs, n: crypto.randomUUID() }))
  return `${prefix}${payload}.${await hmacSha256Base64Url(payload, secret)}`
}

/** Verify an expiring token against `subject`: prefix, payload integrity,
 *  subject match, and expiry all checked; returns false (never throws) on any
 *  failure including a malformed payload. */
export async function verifyExpiringCapabilityToken(subject: string, token: string, opts: CapabilityTokenOptions & { now?: () => number }): Promise<boolean> {
  const secret = opts.secret?.trim()
  const prefix = opts.prefix ?? 'cap_'
  if (!secret || !token.startsWith(prefix)) return false
  const body = token.slice(prefix.length)
  const dot = body.lastIndexOf('.')
  if (dot <= 0 || dot === body.length - 1) return false
  const payload = body.slice(0, dot)
  const sig = body.slice(dot + 1)
  if (!constantTimeEqual(sig, await hmacSha256Base64Url(payload, secret))) return false
  let parsed: { sub?: unknown; exp?: unknown }
  try {
    parsed = JSON.parse(base64UrlDecodeText(payload)) as { sub?: unknown; exp?: unknown }
  } catch {
    return false
  }
  if (parsed.sub !== subject) return false
  if (typeof parsed.exp !== 'number') return false
  const now = opts.now ?? Date.now
  return parsed.exp > now()
}

async function sign(userId: string, secret: string): Promise<string> {
  return hmacSha256Base64Url(`user:${userId}`, secret)
}
