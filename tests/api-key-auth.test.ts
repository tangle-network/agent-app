import { describe, expect, it, vi } from 'vitest'
import { createApiKeyRequestAuth, type RequestApiKey } from '../src/platform/api-key-auth'

function setup(overrides: Partial<RequestApiKey> = {}) {
  const key = { keyId: 'key-a', ownerId: 'owner-a', scopes: ['workspace:read'],
    expiresAt: Date.now() + 60_000, ...overrides }
  const verify = vi.fn(async () => key as RequestApiKey | null)
  const requiredScope = vi.fn(() => 'workspace:read' as string | readonly string[] | null)
  const resolveIdentity = vi.fn(async (verified: RequestApiKey) => ({ user: { id: verified.ownerId } }))
  const claimRequest = vi.fn(async (_key: RequestApiKey, _requestId: string) => ({ allowed: true, retryAfterSeconds: 0 }))
  const authenticate = createApiKeyRequestAuth({ verify, requiredScope, resolveIdentity, claimRequest })
  return { authenticate, verify, requiredScope, resolveIdentity, claimRequest }
}

function request(authorization: string | null = 'Bearer existing-key') {
  return new Request('https://product.example/api/workspaces', {
    headers: { Cookie: 'owner-session=valid', ...(authorization === null ? {} : { Authorization: authorization }) },
  })
}

describe('private API key authentication', () => {
  it('uses only verified owner identity and claims a fresh request id', async () => {
    const state = setup()
    const input = request()
    input.headers.set('X-Owner-Id', 'attacker')
    expect(await state.authenticate(input)).toEqual({ user: { id: 'owner-a' } })
    await state.authenticate(input)
    expect(state.verify).toHaveBeenCalledWith('Bearer existing-key')
    const ids = state.claimRequest.mock.calls.map((call) => call[1])
    expect(ids[0]).toEqual(expect.any(String))
    expect(ids[0]).not.toBe(ids[1])
  })

  it.each(['bearer existing-key', 'BEARER existing-key', 'bEaReR   existing-key'])('accepts HTTP scheme casing and passes a canonical header for %s', async authorization => {
    const state = setup()
    expect(await state.authenticate(request(authorization))).toEqual({ user: { id: 'owner-a' } })
    expect(state.verify).toHaveBeenCalledWith('Bearer existing-key')
  })

  it('allows cookie fallback only when authorization is absent', async () => {
    const state = setup()
    expect(await state.authenticate(request(null))).toBeNull()
    expect(state.verify).not.toHaveBeenCalled()
    for (const value of ['', 'Bearer ', 'Bearer one two', 'Bearer\texisting-key', 'Payment proof', 'Operator token']) {
      await expect(state.authenticate(request(value))).rejects.toMatchObject({ status: 401 })
    }
    state.verify.mockResolvedValue(null)
    await expect(state.authenticate(request())).rejects.toMatchObject({ status: 401 })
    expect(state.resolveIdentity).not.toHaveBeenCalled()
  })

  it.each([NaN, Infinity, 0, Date.now() - 1])('rejects missing or expired expiry %s', async (expiresAt) => {
    const state = setup({ expiresAt })
    await expect(state.authenticate(request())).rejects.toMatchObject({ status: 401 })
    expect(state.claimRequest).not.toHaveBeenCalled()
  })

  it.each([{ scopes: [] }, { scopes: ['chat'] }, { scopes: ['workspace:*'] }])('requires exact explicit scope $scopes', async ({ scopes }) => {
    const state = setup({ scopes })
    await expect(state.authenticate(request())).rejects.toMatchObject({ status: 403 })
    expect(state.resolveIdentity).not.toHaveBeenCalled()
  })

  it('requires every scope in a compound route policy', async () => {
    const allowed = setup({ scopes: ['workspace:read', 'workspace:run'] })
    allowed.requiredScope.mockReturnValue(['workspace:read', 'workspace:run'])
    await expect(allowed.authenticate(request())).resolves.toEqual({ user: { id: 'owner-a' } })
    expect(allowed.claimRequest).toHaveBeenCalledOnce()
    for (const scopes of [['workspace:read'], ['workspace:run']]) {
      const denied = setup({ scopes })
      denied.requiredScope.mockReturnValue(['workspace:read', 'workspace:run'])
      await expect(denied.authenticate(request())).rejects.toMatchObject({ status: 403 })
      expect(denied.resolveIdentity).not.toHaveBeenCalled()
      expect(denied.claimRequest).not.toHaveBeenCalled()
    }
  })

  it.each([{ required: [] }, { required: [''] }, { required: ['workspace:read', ' '] }])('denies empty or malformed scope policies $required before verification', async ({ required }) => {
    const state = setup()
    state.requiredScope.mockReturnValue(required)
    await expect(state.authenticate(request())).rejects.toMatchObject({ status: 403 })
    expect(state.verify).not.toHaveBeenCalled()
  })

  it('denies unlisted routes before resolving owner or claiming quota', async () => {
    const state = setup()
    state.requiredScope.mockReturnValue(null)
    await expect(state.authenticate(request())).rejects.toMatchObject({ status: 403 })
    expect(state.verify).not.toHaveBeenCalled()
  })

  it('fails closed on verifier failure and quota denial', async () => {
    const state = setup()
    state.verify.mockRejectedValueOnce(new Error('store unavailable'))
    await expect(state.authenticate(request())).rejects.toThrow('store unavailable')
    expect(state.claimRequest).not.toHaveBeenCalled()
    state.claimRequest.mockResolvedValue({ allowed: false, retryAfterSeconds: 1.5 })
    try {
      await state.authenticate(request())
      expect.fail('quota must deny')
    } catch (error) {
      expect(error).toBeInstanceOf(Response)
      expect((error as Response).status).toBe(429)
      expect((error as Response).headers.get('Retry-After')).toBe('2')
    }
  })

  it('rejects expiry while asynchronous authorization is pending', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const state = setup({ expiresAt: now + 1 })
      state.claimRequest.mockImplementation(async () => {
        clock.mockReturnValue(now + 2)
        return { allowed: true, retryAfterSeconds: 0 }
      })
      await expect(state.authenticate(request())).rejects.toMatchObject({ status: 401 })
    } finally {
      clock.mockRestore()
    }
  })
})
