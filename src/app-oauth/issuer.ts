/**
 * A product-hosted OAuth issuer for its MCP resource: one better-auth instance
 * with the JWT and OAuth provider plugins over the product's drizzle database,
 * reading the same session cookie as the product's own auth instance, plus the
 * host authority (consent, client, resource, session and user rows) that the
 * `./app-oauth` primitives check before a token is minted or accepted.
 *
 * The product supplies its database, tables (`./app-auth/drizzle` and
 * `./app-oauth/drizzle`), scopes, consent claim and names. The origin and
 * secret are read from `BETTER_AUTH_URL` and `BETTER_AUTH_SECRET` when first
 * used, after the Worker binds its environment.
 */

import { betterAuth, type BetterAuthPlugin } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { jwt } from 'better-auth/plugins'
import { and, eq, gt, isNull } from 'drizzle-orm'
import type { AnySQLiteColumn, AnySQLiteTable, BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type { AppOAuthTables } from './drizzle'
import {
  activeAppOAuthConsent,
  appOAuthMetadataResponse,
  appOAuthProtectedResourceMetadata,
  appOAuthTokenResponse,
  createAppOAuthProvider,
  createAppOAuthResourceVerifier,
  type AppOAuthAuthority,
  type AppOAuthConfig,
  type AppOAuthPrincipal,
  type AppOAuthRefreshStore,
} from './index'

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']

/** The product's drizzle SQLite database (D1 or any async SQLite driver). */
export type AppOAuthIssuerDatabase = BaseSQLiteDatabase<'async', any, any>

/** The auth and OAuth tables the issuer reads and the provider writes. */
export interface AppOAuthIssuerTables extends AppOAuthTables {
  users: AnySQLiteTable & { id: AnySQLiteColumn; emailVerified: AnySQLiteColumn }
  sessions: AnySQLiteTable & { id: AnySQLiteColumn; userId: AnySQLiteColumn; expiresAt: AnySQLiteColumn }
  accounts: AnySQLiteTable
  verifications: AnySQLiteTable
}

export interface CreateAppOAuthIssuerOptions {
  /** better-auth app name. */
  appName: string
  /** The product auth instance's cookie prefix, so both read one session. */
  cookiePrefix: string
  db: AppOAuthIssuerDatabase
  tables: AppOAuthIssuerTables
  /** OAuth permissions the product offers for its resource. */
  scopes: readonly string[]
  /** Scope granted to a dynamically registered client by default. */
  defaultClientScope: string
  /** Access-token claim holding the consent row ID. Changing it invalidates issued tokens. */
  consentClaim: string
  /** Default '/login'. */
  loginPage?: string
  /** Default '/agents/consent'. */
  consentPage?: string
  /** Path of the protected resource on the product origin. Default '/api/agents/mcp'. */
  resourcePath?: string
  /** Default `process.env`. */
  env?: () => { BETTER_AUTH_URL?: string; BETTER_AUTH_SECRET?: string }
}

/** An admitted principal's grant, rechecked when later work commits on its behalf. */
export interface AppOAuthGrant {
  userId: string
  clientId: string
  consentId: string
  sessionId: string
  scopes: readonly string[]
}

function applicationOrigin(configured: string | undefined): string {
  if (!configured) throw new Error('BETTER_AUTH_URL is required for Agents OAuth')
  const url = new URL(configured)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname)))) {
    throw new Error('Agents OAuth requires an HTTPS application origin or a local loopback origin')
  }
  return url.origin
}

/** The issuer's better-auth instance, as products use it. */
export interface AppOAuthIssuerAuth {
  handler(request: Request): Promise<Response>
  /** Resolves once better-auth has initialised (seeding the resource row). */
  $context: Promise<unknown>
}

export interface AppOAuthIssuer {
  /** The protected resource URL (RFC 8707 audience). */
  resource(): string
  /** The issuer URL, including better-auth's /api/auth base path. */
  issuer(): string
  /** Construct only after the Worker binds its database and env. */
  auth(): AppOAuthIssuerAuth
  /** Issuer metadata without the unsupported DPoP advertisement. */
  metadataResponse(request: Request): Promise<Response>
  /** The token endpoint, binding each refresh row to the current consent. */
  tokenResponse(request: Request): Promise<Response>
  /** Bearer tokens only: DPoP would need a replay store shared across Workers. */
  verifyRequest(request: Request): Promise<AppOAuthPrincipal | null>
  /** RFC 9728 metadata for the resource, without DPoP advertisement. */
  protectedResourceMetadata(): Promise<{ resource: string; authorization_servers: string[]; [key: string]: unknown }>
  /** Whether the grant that admitted a principal is still current. */
  grantActive(grant: AppOAuthGrant): Promise<boolean>
  loginPage: string
  consentPage: string
}

/** Build the product's OAuth issuer, its token and metadata routes, and its resource verifier. */
export function createAppOAuthIssuer(options: CreateAppOAuthIssuerOptions): AppOAuthIssuer {
  const { db, tables } = options
  const { users, sessions, oauthClient, oauthResource, oauthClientResource, oauthConsent, oauthRefreshToken } = tables
  const env = options.env ?? (() => process.env)
  const loginPage = options.loginPage ?? '/login'
  const consentPage = options.consentPage ?? '/agents/consent'
  const resourcePath = options.resourcePath ?? '/api/agents/mcp'

  const origin = () => applicationOrigin(env().BETTER_AUTH_URL)
  const resource = () => `${origin()}${resourcePath}`
  const issuer = () => `${origin()}/api/auth`
  const config = (): AppOAuthConfig => ({
    resource: resource(), issuer: issuer(), scopes: options.scopes,
    defaultClientScope: options.defaultClientScope, consentClaim: options.consentClaim,
  })

  async function userVerified(userId: string): Promise<boolean> {
    const [user] = await db.select({ emailVerified: users.emailVerified }).from(users)
      .where(eq(users.id, userId)).limit(1)
    return user?.emailVerified === true
  }

  const authority: AppOAuthAuthority = {
    findConsents: (clientId, userId) => db.select({ id: oauthConsent.id, scopes: oauthConsent.scopes,
      resources: oauthConsent.resources }).from(oauthConsent)
      .where(and(eq(oauthConsent.clientId, clientId), eq(oauthConsent.userId, userId))).limit(2),
    clientActive: async (clientId) => (await db.select({ id: oauthClient.id }).from(oauthClient)
      .where(and(eq(oauthClient.clientId, clientId), eq(oauthClient.disabled, false))).limit(1)).length > 0,
    resourceActive: async (identifier) => (await db.select({ id: oauthResource.id }).from(oauthResource)
      .where(and(eq(oauthResource.identifier, identifier), eq(oauthResource.disabled, false))).limit(1)).length > 0,
    clientResourceLinked: async (clientId, identifier) => (await db.select({ id: oauthClientResource.id })
      .from(oauthClientResource).where(and(eq(oauthClientResource.clientId, clientId),
        eq(oauthClientResource.resourceId, identifier))).limit(1)).length > 0,
    sessionActive: async (sessionId, userId) => (await db.select({ id: sessions.id }).from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())))
      .limit(1)).length > 0,
    userActive: userVerified,
  }

  const refreshStore: AppOAuthRefreshStore = {
    async findByHash(hash) {
      const [row] = await db.select({ id: oauthRefreshToken.id, clientId: oauthRefreshToken.clientId,
        userId: oauthRefreshToken.userId, referenceId: oauthRefreshToken.referenceId })
        .from(oauthRefreshToken).where(eq(oauthRefreshToken.token, hash)).limit(1)
      return row ?? null
    },
    async bindIfUnbound(id, consentId) {
      const bound = await db.update(oauthRefreshToken).set({ referenceId: consentId })
        .where(and(eq(oauthRefreshToken.id, id), isNull(oauthRefreshToken.referenceId)))
        .returning({ id: oauthRefreshToken.id })
      return bound.length > 0
    },
  }

  function build() {
    const secret = env().BETTER_AUTH_SECRET
    if (!secret) throw new Error('BETTER_AUTH_SECRET is required for Agents OAuth')
    const applicationUrl = origin()
    return betterAuth({
      appName: options.appName,
      baseURL: applicationUrl,
      secret,
      trustedOrigins: [applicationUrl],
      // Tokens leave only through `tokenResponse`, which binds refresh rows to consent.
      disabledPaths: ['/token'],
      database: drizzleAdapter(db, {
        provider: 'sqlite',
        schema: {
          user: users, session: sessions, account: tables.accounts, verification: tables.verifications,
          jwks: tables.jwks, oauthClient, oauthResource, oauthClientResource, oauthRefreshToken,
          oauthAccessToken: tables.oauthAccessToken, oauthConsent, oauthClientAssertion: tables.oauthClientAssertion,
        },
      }),
      session: { cookieCache: { enabled: false } },
      advanced: { cookiePrefix: options.cookiePrefix },
      plugins: [
        jwt({ disableSettingJwtHeader: true }),
        // Typed as better-auth's own plugin: a workspace may resolve the provider against a second
        // @better-auth/core copy. Callers use the handler and the JWT plugin's API only.
        createAppOAuthProvider({ ...config(), authority, loginPage, consentPage,
          humanUserEligible: userVerified }) as unknown as BetterAuthPlugin,
      ],
    })
  }

  let built: { auth: ReturnType<typeof build>; verify: (request: Request) => Promise<AppOAuthPrincipal | null> } | null = null
  function instance() {
    if (built) return built
    const auth = build()
    const verify = createAppOAuthResourceVerifier({ ...config(), authority, jwksFetch: () => auth.api.getJwks() })
    built = { auth, verify }
    return built
  }

  return {
    resource,
    issuer,
    auth: () => instance().auth,
    metadataResponse: (request: Request) => appOAuthMetadataResponse(request, instance().auth.handler),
    tokenResponse: (request: Request) => appOAuthTokenResponse(request, {
      ...config(), authority, refreshStore, handler: instance().auth.handler,
    }),
    verifyRequest: (request: Request) => instance().verify(request),
    async protectedResourceMetadata() {
      const metadata = await appOAuthProtectedResourceMetadata(config(), instance().auth)
      // The same values the metadata was built from; restated so the shape is typed.
      return { ...metadata, resource: resource(), authorization_servers: [issuer()] }
    },
    async grantActive(grant: AppOAuthGrant): Promise<boolean> {
      const { userId, clientId, consentId, sessionId, scopes } = grant
      if (!userId || !clientId || !consentId || !sessionId || !scopes.length) return false
      const identifier = resource()
      const checks = await Promise.all([
        authority.clientActive(clientId),
        authority.resourceActive(identifier),
        authority.clientResourceLinked(clientId, identifier),
        authority.userActive(userId),
        authority.sessionActive(sessionId, userId),
        activeAppOAuthConsent({ ...config(), authority }, clientId, userId, scopes)
          .then((consent) => consent?.id === consentId),
      ])
      return checks.every(Boolean)
    },
    loginPage,
    consentPage,
  }
}

export interface CreateAppOAuthConsentOptions {
  issuer: AppOAuthIssuer
  /** The product's browser session for this request. */
  getSession(request: Request): Promise<{ user?: { emailVerified?: boolean | null } | null } | null>
  /** Every scope the consent page may show; any other requested scope is refused. */
  scopeLabels: Readonly<Record<string, string>>
  /**
   * Which client destinations may leave the consent page. `'web'` (default)
   * allows only HTTPS or loopback without credentials. `'native'` also allows
   * the private-use URI schemes native apps register (RFC 8252, e.g. an editor's
   * own scheme) and refuses only script, data, blob and file schemes.
   */
  redirectPolicy?: 'web' | 'native'
}

export interface AppOAuthConsentView {
  query: string
  clientName: string
  /** The requested scopes, in request order. */
  scopes: string[]
  /** The label of each requested scope. */
  labels: Record<string, string>
}

function invalidRequest(): Response {
  return new Response('Invalid authorization request', { status: 400 })
}

const UNSAFE_NATIVE_SCHEMES = ['javascript:', 'data:', 'vbscript:', 'blob:', 'file:']

function safeRedirect(target: string, policy: 'web' | 'native'): boolean {
  try {
    const url = new URL(target)
    if (policy === 'native') return !UNSAFE_NATIVE_SCHEMES.includes(url.protocol.toLowerCase())
    return !url.username && !url.password && (url.protocol === 'https:'
      || (url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname)))
  } catch { return false }
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } })
}

/**
 * Server half of the product's consent page. `loader` throws a redirect to
 * sign-in or a 400; `action` returns `{ error }` for an expired request and
 * otherwise a redirect to the client.
 */
export function createAppOAuthConsent(options: CreateAppOAuthConsentOptions) {
  const { issuer, scopeLabels, redirectPolicy = 'web' } = options
  const rawQuery = (request: Request) => new URL(request.url).search.replace(/^\?/, '')

  async function clientForConsent(request: Request): Promise<AppOAuthConsentView> {
    const query = rawQuery(request)
    if (!query || query.length > 8192) throw invalidRequest()
    const params = new URLSearchParams(query)
    const clientId = params.get('client_id')
    if (!clientId) throw invalidRequest()
    const url = new URL('/api/auth/oauth2/public-client-prelogin', request.url)
    const response = await issuer.auth().handler(new Request(url, { method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json',
      'x-requested-with': 'XMLHttpRequest', origin: url.origin,
      cookie: request.headers.get('cookie') ?? '',
    }, body: JSON.stringify({ client_id: clientId, oauth_query: query }) }))
    if (!response.ok) throw invalidRequest()
    const client = await response.json() as { client_id?: string; client_name?: string }
    if (client.client_id !== clientId) throw invalidRequest()
    const scopes = (params.get('scope') ?? '').split(/\s+/).filter(Boolean)
    if (!scopes.length || scopes.some((scope) => !Object.hasOwn(scopeLabels, scope)) || params.has('claims')) {
      throw new Response('Unsupported authorization scope', { status: 400 })
    }
    return { query, clientName: client.client_name || 'An application',
      scopes, labels: Object.fromEntries(scopes.map((scope) => [scope, scopeLabels[scope]!])) }
  }

  return {
    async loader(request: Request): Promise<AppOAuthConsentView> {
      const session = await options.getSession(request)
      if (!session?.user?.emailVerified) {
        const next = `${issuer.consentPage}?${rawQuery(request)}`
        throw redirectTo(`${issuer.loginPage}?redirect=${encodeURIComponent(next)}`)
      }
      return clientForConsent(request)
    },
    async action(request: Request): Promise<{ error: string } | Response> {
      const origin = request.headers.get('origin')
      const canonicalOrigin = new URL(issuer.resource()).origin
      if (origin !== canonicalOrigin || new URL(request.url).origin !== canonicalOrigin) {
        throw new Response('Invalid request origin', { status: 403 })
      }
      const session = await options.getSession(request)
      if (!session?.user?.emailVerified) throw new Response('Sign in again', { status: 401 })
      const { query } = await clientForConsent(request)
      const choice = (await request.formData()).get('choice')
      if (choice !== 'allow' && choice !== 'deny') throw new Response('Invalid decision', { status: 400 })
      const url = new URL('/api/auth/oauth2/consent', request.url)
      const response = await issuer.auth().handler(new Request(url, { method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json', origin,
        cookie: request.headers.get('cookie') ?? '',
      }, body: JSON.stringify({ accept: choice === 'allow', oauth_query: query }) }))
      const result = await response.json().catch(() => ({})) as { url?: string; redirect_uri?: string }
      if (!response.ok) return { error: 'The authorization request expired. Return to your app and try again.' }
      const target = result.url ?? result.redirect_uri
      if (!target || !safeRedirect(target, redirectPolicy)) throw new Response('Invalid authorization destination', { status: 502 })
      return redirectTo(target)
    },
  }
}
