import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createAppOAuthResourceVerifier, type AppOAuthConfig } from './index'

const issuer = 'https://id.example.test/api/auth'
const resource = 'https://agents.example.test/api/agents/mcp'
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'app-oauth-test-key', alg: 'EdDSA', use: 'sig' }

function token(override: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: jwk.kid })).toString('base64url')
  const claims = { iss: issuer, aud: resource, sub: 'platform-user-1', client_id: 'client-1',
    sid: 'session-1', scope: 'openid operator:read', consent_id: 'consent-2',
    exp: Math.floor(Date.now() / 1000) + 600, ...override }
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const body = `${header}.${payload}`
  return `${body}.${sign(null, Buffer.from(body), privateKey).toString('base64url')}`
}

function setup() {
  const config: AppOAuthConfig = {
    issuer, resource, scopes: ['operator:read', 'operator:run'], defaultClientScope: 'operator:read',
    consentClaim: 'consent_id',
    authority: {
      findConsents: async () => [{ id: 'consent-2', resources: [resource], scopes: ['openid', 'operator:read'] }],
      clientActive: async () => true,
      resourceActive: async () => true,
      clientResourceLinked: async () => true,
      sessionActive: async () => true,
      userActive: async () => true,
    },
  }
  const verify = createAppOAuthResourceVerifier({ ...config, jwksFetch: async () => ({ keys: [jwk] }) })
  const request = (value: string) => new Request(resource, { headers: { authorization: `Bearer ${value}` } })
  return { verify, request }
}

describe('app OAuth signed resource token', () => {
  it('verifies a cross-origin issuer and denies a different audience, issuer, signature or consent', async () => {
    const { verify, request } = setup()
    expect(await verify(request(token()))).toEqual({ userId: 'platform-user-1', clientId: 'client-1',
      scopes: ['operator:read'] })
    expect(await verify(request(token({ aud: 'https://id.example.test/mcp' })))).toBeNull()
    expect(await verify(request(token({ iss: 'https://evil.example.test/api/auth' })))).toBeNull()
    expect(await verify(request(`${token().slice(0, -2)}xx`))).toBeNull()
    expect(await verify(request(token({ consent_id: 'old-consent' })))).toBeNull()
    expect(await verify(request(token({ exp: Math.floor(Date.now() / 1000) - 1 })))).toBeNull()
  })
})
