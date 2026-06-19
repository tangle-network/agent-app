import { ok, fail, type Outcome } from './outcome'

// Terminal-proxy HMAC token. Identity tuple is generic; the secret comes from a
// closure (fail-loud if absent).
export interface TerminalProxyIdentity {
  userId: string
  workspaceId: string
  sandboxId: string
}

const TERMINAL_PROXY_TOKEN_TTL_MS = 15 * 60 * 1000

async function signTerminalProxyToken(secret: string, encodedPayload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encodedPayload))
  return base64UrlEncodeBytes(new Uint8Array(sig))
}

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
  const encoded = base64UrlEncodeUtf8(JSON.stringify(payload))
  const sig = await signTerminalProxyToken(secret, encoded)
  return ok({ token: `${encoded}.${sig}`, expiresAt })
}

export async function verifyTerminalProxyToken(
  secret: string,
  token: string,
  expected: TerminalProxyIdentity,
  now: () => number = Date.now,
): Promise<boolean> {
  if (!secret) return false
  const [encoded, sig, extra] = token.split('.')
  if (!encoded || !sig || extra !== undefined) return false
  const expectedSig = await signTerminalProxyToken(secret, encoded)
  if (!constantTimeEqual(sig, expectedSig)) return false
  let payload: TerminalProxyIdentity & { exp: number }
  try {
    payload = JSON.parse(base64UrlDecodeUtf8(encoded))
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

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlEncodeUtf8(v: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(v))
}

function base64UrlDecodeUtf8(v: string): string {
  const padded = v.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(v.length / 4) * 4, '=')
  const bin = atob(padded)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i += 1) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}
