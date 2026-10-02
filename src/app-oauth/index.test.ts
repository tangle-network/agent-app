import { beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyJwsAccessToken } from 'better-auth/oauth2'
import {
  activeAppOAuthConsent,
  appOAuthMetadataResponse,
  appOAuthTokenResponse,
  createAppOAuthProvider,
  createAppOAuthResourceVerifier,
  type AppOAuthAuthority,
  type AppOAuthConfig,
} from './index'

vi.mock('better-auth/oauth2', () => ({ verifyJwsAccessToken: vi.fn() }))

const issuer = 'https://agents.example.test/api/auth'
const resource = 'https://agents.example.test/api/agents/mcp'

function setup() {
  const authority: AppOAuthAuthority = {
    findConsents: vi.fn(async () => [{ id: 'consent-2', scopes: JSON.stringify(['openid', 'operator:read']),
      resources: JSON.stringify([resource]) }]),
    clientActive: vi.fn(async () => true),
    resourceActive: vi.fn(async () => true),
    clientResourceLinked: vi.fn(async () => true),
    sessionActive: vi.fn(async () => true),
    userActive: vi.fn(async () => true),
  }
  const config: AppOAuthConfig = {
    issuer, resource, authority, scopes: ['operator:read', 'operator:run'],
    defaultClientScope: 'operator:read', consentClaim: 'gtm_consent_id',
  }
  const claims = { iss: issuer, aud: resource, sub: 'user-1', client_id: 'client-1',
    sid: 'session-1', scope: 'openid operator:read', gtm_consent_id: 'consent-2' }
  vi.mocked(verifyJwsAccessToken).mockResolvedValue(claims as never)
  const request = (extra: HeadersInit = {}) => new Request(resource, {
    headers: { authorization: 'Bearer jwt-token', ...extra },
  })
  return { authority, config, claims, request }
}

beforeEach(() => vi.resetAllMocks())

describe('app OAuth host boundary', () => {
  it('accepts only a live resource-bound consent, client, session and user', async () => {
    const { authority, config, request } = setup()
    const verify = createAppOAuthResourceVerifier({ ...config, jwksFetch: async () => ({ keys: [] }) })
    expect(await verify(request())).toEqual({ userId: 'user-1', clientId: 'client-1', scopes: ['operator:read'] })
    expect(vi.mocked(verifyJwsAccessToken).mock.calls[0]?.[1]?.verifyOptions).toMatchObject({
      issuer, audience: resource,
      algorithms: expect.arrayContaining(['EdDSA', 'ES256', 'RS256']),
    })
    for (const port of ['clientActive', 'resourceActive', 'clientResourceLinked', 'sessionActive', 'userActive'] as const) {
      vi.mocked(authority[port]).mockResolvedValueOnce(false)
      expect(await verify(request())).toBeNull()
    }
  })

  it('rejects changed or ambiguous consent and sender-constrained tokens', async () => {
    const { authority, config, claims, request } = setup()
    const verify = createAppOAuthResourceVerifier({ ...config, jwksFetch: async () => ({ keys: [] }) })
    expect(await verify(request({ dpop: 'proof' }))).toBeNull()
    vi.mocked(verifyJwsAccessToken).mockResolvedValueOnce({ ...claims, cnf: { jkt: 'key' } } as never)
    expect(await verify(request())).toBeNull()
    vi.mocked(authority.findConsents).mockResolvedValueOnce([{ id: 'consent-3', scopes: ['openid', 'operator:read'],
      resources: [resource] }])
    expect(await verify(request())).toBeNull()
    vi.mocked(authority.findConsents).mockResolvedValueOnce([
      { id: 'consent-2', scopes: ['openid', 'operator:read'], resources: [resource] },
      { id: 'consent-3', scopes: ['openid', 'operator:read'], resources: [resource] },
    ])
    expect(await verify(request())).toBeNull()
    expect(await activeAppOAuthConsent(config, 'client-1', 'user-1', ['operator:run'])).toBeNull()
  })

  it('distinguishes invalid JWTs from a JWKS operational outage', async () => {
    const { config, request } = setup()
    vi.mocked(verifyJwsAccessToken).mockRejectedValueOnce(new Error('wrong audience'))
    const verify = createAppOAuthResourceVerifier({ ...config, jwksFetch: async () => ({ keys: [] }) })
    expect(await verify(request())).toBeNull()
    vi.mocked(verifyJwsAccessToken).mockImplementationOnce(async (_token, options) => {
      if (typeof options.jwksFetch === 'function') await options.jwksFetch()
      throw new Error('unreachable')
    })
    const unavailable = createAppOAuthResourceVerifier({ ...config, jwksFetch: async () => { throw new Error('network down') } })
    await expect(unavailable(request())).rejects.toThrow('JWKS unavailable')
  })

  it('binds a new refresh secret to the exact consent generation before returning it', async () => {
    const { config } = setup()
    const claims = { sub: 'user-1', client_id: 'client-1', scope: 'openid operator:read', gtm_consent_id: 'consent-2' }
    const token = `header.${btoa(JSON.stringify(claims))}.signature`
    const refreshStore = { findByHash: vi.fn(async () => ({ id: 'refresh-1', clientId: 'client-1',
      userId: 'user-1', referenceId: null })), bindIfUnbound: vi.fn(async () => true) }
    const handler = vi.fn(async () => Response.json({ access_token: token, refresh_token: 'refresh-secret' }))
    const response = await appOAuthTokenResponse(new Request(`${issuer}/oauth2/token`, {
      method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code' }),
    }), { ...config, handler, refreshStore })
    expect(response.status).toBe(200)
    expect(refreshStore.findByHash).toHaveBeenCalledWith(expect.stringMatching(/^[A-Za-z0-9_-]{43}$/))
    expect(refreshStore.bindIfUnbound).toHaveBeenCalledWith('refresh-1', 'consent-2')

    refreshStore.bindIfUnbound.mockResolvedValueOnce(false)
    const unbound = await appOAuthTokenResponse(new Request(`${issuer}/oauth2/token`, {
      method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code' }),
    }), { ...config, handler, refreshStore })
    expect(unbound.status).toBe(400)
  })

  it('declines an old refresh generation and hides DPoP metadata', async () => {
    const { config } = setup()
    const claims = { sub: 'user-1', client_id: 'client-1', scope: 'openid operator:read', gtm_consent_id: 'consent-2' }
    const token = `header.${btoa(JSON.stringify(claims))}.signature`
    const handler = vi.fn(async () => Response.json({ access_token: token, refresh_token: 'refresh-secret' }))
    const refreshStore = { findByHash: vi.fn(async () => ({ id: 'refresh-1', clientId: 'client-1',
      userId: 'user-1', referenceId: 'consent-1' })), bindIfUnbound: vi.fn(async () => true) }
    const denied = await appOAuthTokenResponse(new Request(`${issuer}/oauth2/token`, {
      method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token' }),
    }), { ...config, handler, refreshStore })
    expect(denied.status).toBe(400)
    expect(refreshStore.bindIfUnbound).not.toHaveBeenCalled()

    const metadata = await appOAuthMetadataResponse(new Request(`${issuer}/.well-known/oauth-authorization-server`),
      async () => Response.json({ issuer, dpop_signing_alg_values_supported: ['ES256'] }))
    expect(await metadata.json()).toEqual({ issuer })
  })

  it('keeps the provider human-only, authorization-code/refresh-only and read-default', () => {
    const { config } = setup()
    const plugin = createAppOAuthProvider({ ...config, loginPage: '/login', consentPage: '/agents/consent',
      humanUserEligible: async () => true })
    expect(plugin.id).toBe('oauth-provider')
  })
})
