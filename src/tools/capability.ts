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
  return timingSafeEqual(token, expected)
}

async function sign(userId: string, secret: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`user:${userId}`))
  return base64url(new Uint8Array(sig))
}

function base64url(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Length-independent-leak-free compare for two same-charset strings. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
