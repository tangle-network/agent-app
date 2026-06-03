import { describe, it, expect } from 'vitest'
import { encryptAesGcm, decryptAesGcm, decodeHexKey, createFieldCrypto } from '../src/crypto/index'

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
