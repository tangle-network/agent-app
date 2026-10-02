import { describe, expect, it } from 'vitest'

import { decryptAesGcm, decodeHexKey, encryptAesGcm } from './index'

describe('decodeHexKey', () => {
  it('decodes a valid 64-char hex key', () => {
    const key = '0'.repeat(63) + '1'
    const bytes = decodeHexKey(key)
    expect(bytes).toHaveLength(32)
    expect(bytes[31]).toBe(1)
  })

  it('accepts uppercase hex', () => {
    expect(() => decodeHexKey('AB'.repeat(32))).not.toThrow()
  })

  it('throws on the wrong length', () => {
    expect(() => decodeHexKey('ab'.repeat(31))).toThrow(/64-char hex/)
    expect(() => decodeHexKey('')).toThrow(/64-char hex/)
  })

  it('throws on non-hex characters instead of silently producing a zero key (#747)', () => {
    // parseInt('zz', 16) is NaN and a NaN→Uint8Array assignment stores 0:
    // before the charset check this input produced an all-zero AES key, and
    // encryption under it "worked" — silently weak, never loud.
    const nonHex = 'z'.repeat(64)
    expect(() => decodeHexKey(nonHex)).toThrow(/64-char hex/)
    // Mixed valid/invalid also fails (a single NaN byte would otherwise zero
    // just that byte of the key — worse, it would not even be all-zero).
    expect(() => decodeHexKey('00'.repeat(31) + 'zz')).toThrow(/64-char hex/)
  })
})

describe('AES-GCM round trip (guard for the decode fix)', () => {
  it('still round-trips a valid key', async () => {
    const key = 'ab'.repeat(32)
    const encrypted = await encryptAesGcm('secret', key)
    expect(await decryptAesGcm(encrypted, key)).toBe('secret')
  })
})
