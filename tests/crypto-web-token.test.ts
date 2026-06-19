import { describe, expect, it } from 'vitest'
import {
  base64UrlDecodeText,
  base64UrlEncode,
  base64UrlEncodeText,
  constantTimeEqual,
  hmacSha256Base64Url,
} from '../src/crypto/web-token'

describe('web-token primitives', () => {
  it('round-trips UTF-8 text through base64url', () => {
    const text = JSON.stringify({ sub: 'user-1', exp: 1234567890, emoji: '🔐' })
    const encoded = base64UrlEncodeText(text)
    expect(encoded).not.toMatch(/[+/=]/) // url-safe, unpadded
    expect(base64UrlDecodeText(encoded)).toBe(text)
  })

  it('decodes unpadded base64url (re-pads before atob)', () => {
    // "ab" -> "YWI" (3 chars, would need one '=' of padding for atob)
    const encoded = base64UrlEncodeText('ab')
    expect(encoded).toBe('YWI')
    expect(base64UrlDecodeText(encoded)).toBe('ab')
  })

  it('base64UrlEncode is url-safe and unpadded for raw bytes', () => {
    // 0xFF 0xFE 0xFD -> base64 "//79" -> base64url "__79"
    expect(base64UrlEncode(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe('__79')
  })

  it('hmacSha256Base64Url is deterministic and secret-sensitive', async () => {
    const a = await hmacSha256Base64Url('message', 'secret')
    const b = await hmacSha256Base64Url('message', 'secret')
    const c = await hmacSha256Base64Url('message', 'other-secret')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).not.toMatch(/[+/=]/)
  })

  it('constantTimeEqual matches only equal same-length strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
  })
})
