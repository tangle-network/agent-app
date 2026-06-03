import { describe, it, expect } from 'vitest'
import { createCapabilityToken, verifyCapabilityToken } from '../src/tools/index'

const secret = 's3cret'

describe('capability token', () => {
  it('round-trips for the bound user and rejects any other user (anti-impersonation)', async () => {
    const token = await createCapabilityToken('user-1', { secret })
    expect(token).toBeDefined()
    expect(token!.startsWith('cap_')).toBe(true)
    expect(await verifyCapabilityToken('user-1', token!, { secret })).toBe(true)
    expect(await verifyCapabilityToken('user-2', token!, { secret })).toBe(false)
  })

  it('honors a custom prefix and rejects a foreign-prefixed token', async () => {
    const token = await createCapabilityToken('u', { secret, prefix: 'legalcap_' })
    expect(token!.startsWith('legalcap_')).toBe(true)
    expect(await verifyCapabilityToken('u', token!, { secret, prefix: 'legalcap_' })).toBe(true)
    // Same bytes, wrong expected prefix → rejected.
    expect(await verifyCapabilityToken('u', token!, { secret, prefix: 'cap_' })).toBe(false)
  })

  it('fail-closed: no secret mints nothing and verifies nothing', async () => {
    expect(await createCapabilityToken('u', { secret: undefined })).toBeUndefined()
    expect(await createCapabilityToken('u', { secret: '  ' })).toBeUndefined()
    const real = await createCapabilityToken('u', { secret })
    expect(await verifyCapabilityToken('u', real!, { secret: undefined })).toBe(false)
  })

  it('rejects a malformed token without throwing', async () => {
    expect(await verifyCapabilityToken('u', 'not-a-token', { secret })).toBe(false)
    expect(await verifyCapabilityToken('u', 'cap_', { secret })).toBe(false)
  })

  it('a token minted under one secret does not verify under another', async () => {
    const t = await createCapabilityToken('u', { secret: 'A' })
    expect(await verifyCapabilityToken('u', t!, { secret: 'B' })).toBe(false)
  })
})
