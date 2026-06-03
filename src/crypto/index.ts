/**
 * AES-256-GCM field encryption (for PII at rest — SSN/EIN/ID numbers, secrets).
 * WebCrypto only — runs on Cloudflare Workers, Node, and the browser with no
 * Node `crypto` dependency. The 32-byte key is a PARAMETER (64-char hex); the
 * framework never reads env — the product binds its own `ENCRYPTION_KEY` (this
 * is the concrete impl behind the `KeyCrypto` seam in `../billing`).
 *
 * Wire format: base64(iv ‖ ciphertext ‖ tag) — the 12-byte IV is prepended; the
 * GCM auth tag is appended by WebCrypto inside the ciphertext.
 */

const IV_LENGTH = 12
const TAG_LENGTH = 16
const ALGORITHM = 'AES-GCM'

/** Validate + decode a 64-char hex key to 32 bytes. Throws on the wrong shape so
 *  a misconfigured key fails loud, never silently weakens encryption. */
export function decodeHexKey(keyHex: string): Uint8Array {
  if (keyHex.length !== 64) throw new Error('encryption key must be a 64-char hex string (32 bytes)')
  const bytes = new Uint8Array(32)
  for (let i = 0; i < 64; i += 2) bytes[i / 2] = parseInt(keyHex.substring(i, i + 2), 16)
  return bytes
}

async function importKey(keyHex: string): Promise<CryptoKey> {
  const raw = decodeHexKey(keyHex)
  return crypto.subtle.importKey('raw', raw.buffer as ArrayBuffer, { name: ALGORITHM } as Algorithm, false, ['encrypt', 'decrypt'])
}

function toBase64(data: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]!)
  return btoa(binary)
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Encrypt `plaintext` with AES-256-GCM under `keyHex`. Returns
 *  base64(iv ‖ ciphertext ‖ tag). A fresh random IV per call. */
export async function encryptAesGcm(plaintext: string, keyHex: string): Promise<string> {
  const key = await importKey(keyHex)
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const ciphertext = await crypto.subtle.encrypt({ name: ALGORITHM, iv, tagLength: TAG_LENGTH * 8 }, key, new TextEncoder().encode(plaintext))
  const result = new Uint8Array(IV_LENGTH + ciphertext.byteLength)
  result.set(iv, 0)
  result.set(new Uint8Array(ciphertext), IV_LENGTH)
  return toBase64(result)
}

/** Decrypt a base64(iv ‖ ciphertext ‖ tag) string under `keyHex`. Throws if the
 *  tag fails (tamper/wrong key). */
export async function decryptAesGcm(encrypted: string, keyHex: string): Promise<string> {
  const key = await importKey(keyHex)
  const data = fromBase64(encrypted)
  const iv = data.slice(0, IV_LENGTH)
  const ciphertext = data.slice(IV_LENGTH)
  const plain = await crypto.subtle.decrypt({ name: ALGORITHM, iv, tagLength: TAG_LENGTH * 8 }, key, ciphertext)
  return new TextDecoder().decode(plain)
}

/** Build a {@link import('../billing').KeyCrypto}-compatible pair bound to a key
 *  (or a key-resolver, for env-backed keys resolved per call). */
export function createFieldCrypto(key: string | (() => string)): { encrypt(s: string): Promise<string>; decrypt(s: string): Promise<string> } {
  const resolve = typeof key === 'function' ? key : () => key
  return {
    encrypt: (s) => encryptAesGcm(s, resolve()),
    decrypt: (s) => decryptAesGcm(s, resolve()),
  }
}
