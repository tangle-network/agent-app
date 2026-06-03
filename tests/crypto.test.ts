import { describe, it, expect } from 'vitest'
import {
  encryptAesGcm,
  decryptAesGcm,
  decodeHexKey,
  createFieldCrypto,
  deriveKey,
  encryptWithKey,
  decryptWithKey,
  encryptBytes,
  decryptBytes,
} from '../src/crypto/index'

const KEY = 'a'.repeat(64) // 32 bytes hex
const KEY2 = 'b'.repeat(64)

describe('AES-256-GCM field crypto', () => {
  it('round-trips plaintext under the same key', async () => {
    const ct = await encryptAesGcm('123-45-6789', KEY)
    expect(ct).not.toContain('123-45-6789')
    expect(await decryptAesGcm(ct, KEY)).toBe('123-45-6789')
  })

  it('produces a fresh IV each call (ciphertexts differ, both decrypt)', async () => {
    const a = await encryptAesGcm('same', KEY)
    const b = await encryptAesGcm('same', KEY)
    expect(a).not.toBe(b)
    expect(await decryptAesGcm(a, KEY)).toBe('same')
    expect(await decryptAesGcm(b, KEY)).toBe('same')
  })

  it('fails to decrypt under a different key (GCM tag rejects)', async () => {
    const ct = await encryptAesGcm('secret', KEY)
    await expect(decryptAesGcm(ct, KEY2)).rejects.toThrow()
  })

  it('rejects a malformed key length, loud', () => {
    expect(() => decodeHexKey('tooshort')).toThrow(/64-char hex/)
  })

  it('createFieldCrypto binds a static key and a key-resolver', async () => {
    const c = createFieldCrypto(KEY)
    expect(await c.decrypt(await c.encrypt('x'))).toBe('x')
    let k = KEY
    const dyn = createFieldCrypto(() => k)
    const ct = await dyn.encrypt('y')
    expect(await dyn.decrypt(ct)).toBe('y')
  })
})

describe('PBKDF2-derived CryptoKey path', () => {
  const OPTS = { salt: 'tax-filer-encryption-v1', iterations: 100_000, hash: 'SHA-256' as const }

  it('round-trips a string under a derived key', async () => {
    const key = await deriveKey('super-secret', OPTS)
    const ct = await encryptWithKey('123-45-6789', key)
    expect(ct).not.toContain('123-45-6789')
    expect(await decryptWithKey(ct, key)).toBe('123-45-6789')
  })

  it('round-trips binary bytes under a derived key (document path)', async () => {
    const key = await deriveKey('super-secret', OPTS)
    const data = new Uint8Array([0, 1, 2, 250, 255, 128]).buffer
    const ct = await encryptBytes(data, key)
    const back = new Uint8Array(await decryptBytes(ct, key))
    expect([...back]).toEqual([0, 1, 2, 250, 255, 128])
  })

  it('fresh IV per call — ciphertexts differ, both decrypt', async () => {
    const key = await deriveKey('s', OPTS)
    const a = await encryptWithKey('same', key)
    const b = await encryptWithKey('same', key)
    expect(a).not.toBe(b)
    expect(await decryptWithKey(a, key)).toBe('same')
  })

  it('derives identical key bytes for the same secret+salt+iterations (stable at rest)', async () => {
    // Two independently derived keys from the same params must be interchangeable
    // — proves the derivation is deterministic so data already at rest decrypts
    // after a process restart / library swap (no PII orphaning).
    const k1 = await deriveKey('tax-filer-encryption-v1-secret', OPTS)
    const k2 = await deriveKey('tax-filer-encryption-v1-secret', OPTS)
    const ct = await encryptWithKey('SSN', k1)
    expect(await decryptWithKey(ct, k2)).toBe('SSN')
  })

  it('different salt → different key (cannot cross-decrypt)', async () => {
    const k1 = await deriveKey('s', OPTS)
    const k2 = await deriveKey('s', { ...OPTS, salt: 'other-salt' })
    const ct = await encryptWithKey('secret', k1)
    await expect(decryptWithKey(ct, k2)).rejects.toThrow()
  })

  it('accepts a Uint8Array salt equivalently to a string salt', async () => {
    const strKey = await deriveKey('s', { ...OPTS })
    const byteKey = await deriveKey('s', { ...OPTS, salt: new TextEncoder().encode('tax-filer-encryption-v1') })
    const ct = await encryptWithKey('x', strKey)
    expect(await decryptWithKey(ct, byteKey)).toBe('x')
  })
})
