/** OAuth for an application's MCP resource. The host owns identity, tables and grants. */
import { oauthProvider } from '@better-auth/oauth-provider'
import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client'
import { APIError } from 'better-auth/api'
import { verifyJwsAccessToken } from 'better-auth/oauth2'

const ASYMMETRIC_ALGORITHMS = ['EdDSA', 'ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512', 'RS256', 'RS384', 'RS512']
const OPERATIONAL_ERROR = Symbol('appOAuthOperational')
// Better Auth 1.7.2 strips these AS-owned access-token claims at issuance.
const RESERVED_CONSENT_CLAIMS = new Set(['iss', 'sub', 'aud', 'exp', 'iat', 'jti', 'client_id', 'scope',
  'auth_time', 'acr', 'amr', 'cnf', 'sid', 'nbf', 'azp'])
const STANDARD_SCOPES = ['openid', 'profile', 'email', 'offline_access']

export interface AppOAuthConsent {
  id: string
  /** JSON string or string array, as returned by the host's persistence adapter. */
  scopes: string | readonly string[] | null
  resources: string | readonly string[] | null
}

/** The issuer reads current consent before minting a token. A lookup outage must throw. */
export interface AppOAuthConsentAuthority {
  findConsents(clientId: string, userId: string): Promise<readonly AppOAuthConsent[]>
}

/** Each callback reads current host authority. A lookup outage must throw. */
export interface AppOAuthAuthority extends AppOAuthConsentAuthority {
  clientActive(clientId: string): Promise<boolean>
  resourceActive(resource: string): Promise<boolean>
  clientResourceLinked(clientId: string, resource: string): Promise<boolean>
  sessionActive(sessionId: string, userId: string): Promise<boolean>
  userActive(userId: string): Promise<boolean>
}

export interface AppOAuthAuthoritySnapshotInput {
  clientId: string
  userId: string
  sessionId: string
  consentId: string
  resource: string
  scopes: readonly string[]
  /** Claims from a verified JWS. The host can forward its own grant generation. */
  claims: Readonly<Record<string, unknown>>
}

export interface AppOAuthAuthoritySnapshot {
  active: boolean
  clientActive: boolean
  resourceActive: boolean
  clientResourceLinked: boolean
  consents: readonly AppOAuthConsent[]
  sessionActive: boolean
  userActive: boolean
}

/** Read one uncached, current authority view after JWS verification. */
export interface AppOAuthSnapshotAuthority {
  readSnapshot(input: AppOAuthAuthoritySnapshotInput): Promise<AppOAuthAuthoritySnapshot>
}

export interface AppOAuthConfig {
  /** Exact RFC 8707 audience. The host owns the URL and its route. */
  resource: string
  /** Exact issuer, including Better Auth's /api/auth base path. */
  issuer: string
  /** OAuth permissions the application offers for this resource. */
  scopes: readonly string[]
  /** Scope granted to a dynamically registered client by default. */
  defaultClientScope: string
  /** Claim containing the current consent row ID. */
  consentClaim: string
}

export type AppOAuthIssuerConfig = AppOAuthConfig & { authority: AppOAuthConsentAuthority }
export type AppOAuthResourceConfig = AppOAuthConfig & {
  authority: AppOAuthAuthority | AppOAuthSnapshotAuthority
}

export type AppOAuthJwksFetch = Extract<Parameters<typeof verifyJwsAccessToken>[1]['jwksFetch'], (...args: never[]) => unknown>

function list(value: AppOAuthConsent['scopes']): string[] | null {
  if (Array.isArray(value)) return value.every(item => typeof item === 'string') ? [...value] : null
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed : null
  } catch { return null }
}

function validate(config: AppOAuthConfig): void {
  const issuer = new URL(config.issuer)
  const resource = new URL(config.resource)
  if (!config.issuer || !config.resource || !/^[a-z][a-z0-9_]*$/.test(config.consentClaim)
    || RESERVED_CONSENT_CLAIMS.has(config.consentClaim)
    || !config.scopes.length
    || !config.scopes.includes(config.defaultClientScope)
    || issuer.hash || issuer.search || resource.hash || resource.search
    || issuer.username || issuer.password || resource.username || resource.password
    || !['https:', 'http:'].includes(issuer.protocol) || !['https:', 'http:'].includes(resource.protocol)
    || (issuer.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname))
    || (resource.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(resource.hostname))) {
    throw new Error('app-oauth: invalid issuer, resource, scopes or consent claim')
  }
}

/** Require exactly one current consent; malformed grants cannot widen authority. */
function consentFromRows(config: AppOAuthConfig, rows: readonly AppOAuthConsent[],
  scopes: readonly string[]): AppOAuthConsent | null {
  if (!Array.isArray(rows)) return null
  if (rows.length !== 1) return null
  const consent = rows[0]
  if (!consent?.id) return null
  const resources = list(consent.resources)
  const granted = list(consent.scopes)
  if (!resources?.includes(config.resource) || !granted) return null
  return scopes.every(scope => granted.includes(scope)) ? consent : null
}

export async function activeAppOAuthConsent(config: AppOAuthIssuerConfig, clientId: string, userId: string,
  scopes: readonly string[]): Promise<AppOAuthConsent | null> {
  return consentFromRows(config, await config.authority.findConsents(clientId, userId), scopes)
}

function invalidGrant(description: string): never {
  throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: description })
}

/** Compose the maintained Better Auth provider with one host's live authority. */
export function createAppOAuthProvider(config: AppOAuthIssuerConfig & {
  loginPage: string
  consentPage: string
  /** The host must reject deleted, disabled or unverified users at token mint. */
  humanUserEligible(userId: string): Promise<boolean>
}): ReturnType<typeof oauthProvider> {
  validate(config)
  return oauthProvider({
    loginPage: config.loginPage,
    consentPage: config.consentPage,
    accessTokenExpiresIn: 900,
    refreshTokenExpiresIn: 604800,
    codeExpiresIn: 600,
    grantTypes: ['authorization_code', 'refresh_token'],
    dpop: { signingAlgorithms: [] },
    scopes: [...STANDARD_SCOPES, ...config.scopes],
    defaultScope: 'openid profile email',
    allowPublicClientPrelogin: true,
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    clientRegistrationDefaultScopes: [config.defaultClientScope],
    clientRegistrationAllowedScopes: [...STANDARD_SCOPES, ...config.scopes],
    clientRegistrationDefaultResources: [config.resource],
    clientRegistrationAllowedResources: [config.resource],
    resources: [{ identifier: config.resource, accessTokenTtl: 900, allowedScopes: [...config.scopes] }],
    resourceSeedMode: 'insertOnly',
    enforcePerClientResources: true,
    extensions: [{ claims: { accessToken: async ({ user, client, scopes, resources, grantType, referenceId }) => {
      if (!user?.id || !resources?.includes(config.resource)) invalidGrant('Resource consent is required')
      const consent = await activeAppOAuthConsent(config, client.clientId, user.id, scopes)
      if (!consent || (grantType === 'refresh_token' && referenceId !== consent.id)) {
        invalidGrant('Resource consent changed')
      }
      return { [config.consentClaim]: consent.id }
    } } }],
    customTokenResponseFields: async ({ grantType, user }) => {
      if (grantType === 'client_credentials' || !user?.id) invalidGrant('Human identity is required')
      if (!await config.humanUserEligible(user.id)) invalidGrant('Verified identity is required')
      return {}
    },
  })
}

export interface AppOAuthRefreshToken {
  id: string
  clientId: string
  userId: string
  referenceId: string | null
}

export interface AppOAuthRefreshStore {
  findByHash(hash: string): Promise<AppOAuthRefreshToken | null>
  /** Atomically set referenceId only when it is NULL. */
  bindIfUnbound(id: string, consentId: string): Promise<boolean>
}

async function refreshHash(token: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function issuedClaims(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const decoded: unknown = JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/')))
    return decoded && typeof decoded === 'object' && !Array.isArray(decoded)
      ? decoded as Record<string, unknown> : null
  } catch { return null }
}

function rejectedTokenResponse(): Response {
  return Response.json({ error: 'invalid_grant' }, { status: 400, headers: { 'cache-control': 'no-store' } })
}

/** Bind refresh rows to the current consent before their secret leaves the host. */
export async function appOAuthTokenResponse(request: Request, config: AppOAuthIssuerConfig & {
  handler(request: Request): Promise<Response>
  refreshStore: AppOAuthRefreshStore
}): Promise<Response> {
  validate(config)
  let grantType: string | null = null
  try { grantType = String((await request.clone().formData()).get('grant_type') ?? '') }
  catch { /* The provider owns malformed-request responses. */ }
  const response = await config.handler(request)
  if (!response.ok) return response
  if (grantType !== 'authorization_code' && grantType !== 'refresh_token') return rejectedTokenResponse()
  const issued = await response.clone().json() as { access_token?: unknown; refresh_token?: unknown }
  const claims = typeof issued.access_token === 'string' ? issuedClaims(issued.access_token) : null
  if (!claims || typeof claims.sub !== 'string' || typeof claims.client_id !== 'string'
    || typeof claims[config.consentClaim] !== 'string') return rejectedTokenResponse()
  const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : []
  const consent = await activeAppOAuthConsent(config, claims.client_id, claims.sub, scopes)
  if (!consent || consent.id !== claims[config.consentClaim]) return rejectedTokenResponse()
  if (typeof issued.refresh_token === 'string') {
    const row = await config.refreshStore.findByHash(await refreshHash(issued.refresh_token))
    if (!row || row.clientId !== claims.client_id || row.userId !== claims.sub) return rejectedTokenResponse()
    if (grantType === 'authorization_code') {
      if (!await config.refreshStore.bindIfUnbound(row.id, consent.id)) return rejectedTokenResponse()
    } else if (row.referenceId !== consent.id) return rejectedTokenResponse()
  }
  return response
}

export interface AppOAuthPrincipal {
  userId: string
  clientId: string
  scopes: readonly string[]
}

/** Verify bearer tokens and current host grants before any private tool is listed. */
export function createAppOAuthResourceVerifier(config: AppOAuthResourceConfig & {
  jwksFetch: AppOAuthJwksFetch
}) {
  validate(config)
  const jwksCacheKey = {}
  return async (request: Request): Promise<AppOAuthPrincipal | null> => {
    if (request.headers.has('dpop')) return null
    const token = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]
    if (!token || /^(sk-|gak_|svc_)/.test(token)) return null
    let claims: Awaited<ReturnType<typeof verifyJwsAccessToken>>
    try {
      claims = await verifyJwsAccessToken(token, {
        jwksCacheKey,
        jwksFetch: async () => {
          try {
            const jwks = await config.jwksFetch()
            if (!jwks || !Array.isArray(jwks.keys)) throw new Error('Invalid JWKS response')
            return jwks
          }
          catch (cause) {
            const error = new Error('App OAuth JWKS unavailable', { cause })
            Object.defineProperty(error, OPERATIONAL_ERROR, { value: true })
            throw error
          }
        },
        verifyOptions: { issuer: config.issuer, audience: config.resource,
          algorithms: ASYMMETRIC_ALGORITHMS, requiredClaims: ['exp'] },
      })
    } catch (error) {
      if (typeof error === 'object' && error !== null && (error as Record<PropertyKey, unknown>)[OPERATIONAL_ERROR]) throw error
      return null
    }
    if (!claims || typeof claims.sub !== 'string' || !claims.sub || claims.cnf !== undefined
      || typeof claims.client_id !== 'string' || !claims.client_id
      || typeof claims.sid !== 'string' || !claims.sid) return null
    const consentId = claims[config.consentClaim]
    if (typeof consentId !== 'string' || !consentId) return null
    const clientId = claims.client_id
    const userId = claims.sub
    const tokenScopes = typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : []
    const authority = config.authority
    if ('readSnapshot' in authority) {
      const snapshot = await authority.readSnapshot({ clientId, userId, sessionId: claims.sid,
        consentId, resource: config.resource, scopes: tokenScopes, claims: { ...claims } })
      if (!snapshot?.active || !snapshot.clientActive || !snapshot.resourceActive
        || !snapshot.clientResourceLinked || !snapshot.sessionActive || !snapshot.userActive
        || consentFromRows(config, snapshot.consents, tokenScopes)?.id !== consentId) return null
    } else {
      if (!await authority.clientActive(clientId)
        || !await authority.resourceActive(config.resource)
        || !await authority.clientResourceLinked(clientId, config.resource)) return null
      const consent = await activeAppOAuthConsent({ ...config, authority }, clientId, userId, tokenScopes)
      if (!consent || consent.id !== consentId) return null
      if (!await authority.sessionActive(claims.sid, userId)
        || !await authority.userActive(userId)) return null
    }
    return { userId, clientId, scopes: tokenScopes.filter(scope => config.scopes.includes(scope)) }
  }
}

function withoutDpop(metadata: object): Record<string, unknown> {
  const bearerOnly = { ...metadata } as Record<string, unknown>
  delete bearerOnly.dpop_signing_alg_values_supported
  return bearerOnly
}

/** Strip unsupported DPoP advertisement from Better Auth's issuer metadata. */
export async function appOAuthMetadataResponse(request: Request, handler: (request: Request) => Promise<Response>): Promise<Response> {
  const response = await handler(request)
  if (!response.ok) return response
  const metadata = await response.json() as Record<string, unknown>
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return Response.json(withoutDpop(metadata), { status: response.status, headers })
}

/** RFC 9728 metadata for an issuer-hosted or separate protected resource. */
export async function appOAuthProtectedResourceMetadata(
  config: AppOAuthConfig, auth?: NonNullable<Parameters<typeof oauthProviderResourceClient>[0]>,
) {
  validate(config)
  const overrides = {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [...config.scopes, 'offline_access'],
  }
  const metadata = auth
    ? await oauthProviderResourceClient(auth).getActions().getProtectedResourceMetadata(overrides)
    : await oauthProviderResourceClient().getActions().getProtectedResourceMetadata(overrides, {
      externalScopes: overrides.scopes_supported,
    })
  return withoutDpop(metadata)
}
