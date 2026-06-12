import { describe, expect, it } from 'vitest'
import { createExpiringCapabilityToken, verifyExpiringCapabilityToken } from '../../src/tools/capability'

const SECRET = 'test-secret'
const HOUR = 60 * 60 * 1000

describe('expiring capability token', () => {
  it('round-trips within the validity window', async () => {
    const token = await createExpiringCapabilityToken('u1:ws1:seqA', { secret: SECRET, prefix: 'seq_', expiresInMs: HOUR })
    expect(token).toMatch(/^seq_/)
    expect(await verifyExpiringCapabilityToken('u1:ws1:seqA', token!, { secret: SECRET, prefix: 'seq_' })).toBe(true)
  })

  it('rejects after expiry', async () => {
    let clock = 1_000_000
    const token = await createExpiringCapabilityToken('u1:ws1:seqA', { secret: SECRET, expiresInMs: HOUR, now: () => clock })
    clock += HOUR + 1
    expect(await verifyExpiringCapabilityToken('u1:ws1:seqA', token!, { secret: SECRET, now: () => clock })).toBe(false)
  })

  it('rejects a token minted for another sequence (subject mismatch)', async () => {
    const token = await createExpiringCapabilityToken('u1:ws1:seqA', { secret: SECRET, expiresInMs: HOUR })
    expect(await verifyExpiringCapabilityToken('u1:ws1:seqB', token!, { secret: SECRET })).toBe(false)
  })

  it('rejects a tampered payload even with a fresh expiry', async () => {
    let clock = 1_000_000
    const token = await createExpiringCapabilityToken('u1:ws1:seqA', { secret: SECRET, expiresInMs: HOUR, now: () => clock })
    const body = token!.slice('cap_'.length)
    const [, sig] = [body.slice(0, body.lastIndexOf('.')), body.slice(body.lastIndexOf('.') + 1)]
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 'u1:ws1:seqB', exp: clock + HOUR, n: 'x' })).toString('base64url')
    expect(await verifyExpiringCapabilityToken('u1:ws1:seqB', `cap_${forgedPayload}.${sig}`, { secret: SECRET, now: () => clock })).toBe(false)
  })

  it('fails closed: no secret mints nothing and verifies nothing', async () => {
    expect(await createExpiringCapabilityToken('u1', { secret: undefined, expiresInMs: HOUR })).toBeUndefined()
    expect(await verifyExpiringCapabilityToken('u1', 'cap_whatever.sig', { secret: undefined })).toBe(false)
  })

  it('rejects malformed bodies (no dot, empty sig) without throwing', async () => {
    expect(await verifyExpiringCapabilityToken('u1', 'cap_nodothere', { secret: SECRET })).toBe(false)
    expect(await verifyExpiringCapabilityToken('u1', 'cap_payload.', { secret: SECRET })).toBe(false)
    expect(await verifyExpiringCapabilityToken('u1', 'cap_.sig', { secret: SECRET })).toBe(false)
  })

  it('throws on a non-positive lifetime', async () => {
    await expect(createExpiringCapabilityToken('u1', { secret: SECRET, expiresInMs: 0 })).rejects.toThrow('expiresInMs')
  })
})
