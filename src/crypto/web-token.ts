/**
 * Dependency-free WebCrypto primitives for HMAC-signed, base64url-encoded
 * tokens — base64url encode/decode, HMAC-SHA256, and a constant-time compare.
 * Runs on Cloudflare Workers, Node, and the browser with no Node `crypto`
 * dependency. Shared by the sandbox terminal-proxy token, the WS-upgrade token
 * parser, and the app-tool capability token so the logic lives in one place
 * rather than three near-identical private copies.
 *
 * Internal leaf: not exported from the `/crypto` barrel (that subpath is the
 * AES-GCM field-crypto surface); imported directly by the modules that need it.
 */

/** base64url-encode raw bytes (RFC 4648 §5, no padding). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** base64url-encode a UTF-8 string. */
export function base64UrlEncodeText(text: string): string {
  return base64UrlEncode(new TextEncoder().encode(text))
}

/** Decode a base64url string back to its UTF-8 text. Re-pads before `atob` so
 *  unpadded input decodes correctly regardless of the runtime's leniency. */
export function base64UrlDecodeText(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const bin = atob(padded)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/** HMAC-SHA256 `message` under `secret`, returned base64url-encoded. */
export async function hmacSha256Base64Url(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return base64UrlEncode(new Uint8Array(sig))
}

/** Length-independent-leak-free compare of two same-charset strings. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
