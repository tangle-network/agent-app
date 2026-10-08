/**
 * better-auth config factory for agent products (#188 Phase 1). Every product
 * hand-rolls the same ~70–150 line setup — drizzle adapter over the standard
 * users/sessions/accounts/verifications tables, email+password with branded
 * reset/verification mail (`./email`), env-gated GitHub/Google social providers, session
 * cookie cache, and a per-app cookie prefix — and tax additionally
 * re-implemented better-auth's cookie signing for its Tangle SSO callback.
 * `createAppAuth` owns that mechanism once and returns the configured
 * better-auth instance plus the request guards products actually use.
 *
 * Domain stays a parameter: the drizzle db + schema, email client, provider
 * credentials, and SSO store/client all come from the product. No product
 * import, no engine re-implementation — the SSO path composes the existing
 * `platform/sso` cookie minter (`createBetterAuthSessionCookieMinter`), which
 * is byte-compatible with better-auth's own `makeSignature` contract.
 *
 * better-auth is an OPTIONAL peer: only this subpath imports it, so it is
 * deliberately NOT re-exported from the root barrel.
 */

import { betterAuth, type Auth, type BetterAuthOptions, type Session, type User } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { noticeEmail, type EmailAttachment, type EmailMessage, type EmailProduct } from '../email'
import { createAuthGuard, type AuthGuard } from '../platform/guards'
import {
  createBetterAuthSessionCookieMinter,
  createTangleSsoHandlers,
  type TangleSsoAccountStore,
  type TangleSsoAuthClient,
  type TangleSsoHandlers,
  type TangleIdentitySsoAccountStore,
  type TangleIdentitySsoAuthClient,
  type TangleOidcSsoAccountStore,
  type TangleOidcSsoAuthClient,
} from '../platform/sso'

const DEFAULT_STATE_COOKIE = 'tangle_sso_state'
const DEFAULT_SESSION_COOKIE_CACHE_SECONDS = 5 * 60

/** Structural slice of a Resend-style client — no `resend` import. */
export interface AppAuthEmailClient {
  emails: {
    send(message: {
      from: string
      to: string
      subject: string
      html: string
      text?: string
      /** Inline images the HTML references by `cid:`, such as the Tangle mark. */
      attachments?: EmailAttachment[]
    }): Promise<unknown>
  }
}

/** Define email configuration for app authentication including client, sender, verification, and warning options */
export interface AppAuthEmailConfig {
  /** A Resend-style client, or a lazy getter returning null when the API key
   *  is absent (the products' dev default — mail is skipped with a warning,
   *  sign-up itself must not crash). */
  resend: AppAuthEmailClient | (() => AppAuthEmailClient | null)
  /** RFC 5322 From; build it with `emailSender` from `./email`, e.g. `Legal Agent · Tangle <noreply@tangle.tools>`. */
  from: string
  /** Send a verification email on sign-up and auto-sign-in after verifying
   *  (the tax/gtm behavior). Default false (the legal behavior). */
  verifyOnSignUp?: boolean
  /** Receives the "email client unavailable" warning. Default console.warn. */
  warn?: (message: string) => void
}

/** Env-shaped: pass the env vars straight through; the provider is registered
 *  only when BOTH values are non-empty, so unset env disables it. */
export interface AppAuthSocialProviderConfig {
  clientId?: string
  clientSecret?: string
}

/** Define social authentication configuration options for GitHub and Google providers */
export interface AppAuthSocialConfig {
  github?: AppAuthSocialProviderConfig
  google?: AppAuthSocialProviderConfig
}

/** Cross-site Tangle SSO wiring. The factory supplies the better-auth side —
 *  `setSessionCookie` via `createBetterAuthSessionCookieMinter(auth)` (signed
 *  `__Secure-`/prefixed cookie that `auth.api.getSession` accepts) — so the
 *  product no longer touches `better-auth/crypto` itself. */
export interface AppAuthSsoConfig {
  protocol?: 'legacy'
  /** Platform wire client (authorizeUrl + exchange). */
  client: TangleSsoAuthClient
  /** Product persistence: user upsert, session row, platform link. */
  store: TangleSsoAccountStore
  /** Absolute callback URL registered with the platform. */
  callbackUrl: string
  /** Default 'tangle_sso_state'. */
  stateCookieName?: string
  /** HMAC secret for the CSRF state cookie. Default: the auth `secret`. */
  stateSecret?: string
  /** Default: `baseURL` is https. Must match better-auth's own
   *  secure-cookie decision or the cookie name lookup diverges. */
  secureCookies?: boolean
  sessionTtlSeconds?: number
  stateTtlSeconds?: number
  /** Post-login redirect fallback. Default '/app'. */
  defaultRedirectPath?: string
  /** Default: the top-level `loginPath`. */
  loginPath?: string
  /** Failure log hook (e.g. console.error). Default no-op. */
  log?: (message: string, error?: unknown) => void
}

/** Registered OIDC client configuration. The caller supplies Runtime PKCE; login does not mint an API key. */
export interface AppAuthOidcSsoConfig extends Omit<AppAuthSsoConfig, 'protocol' | 'client' | 'store'> {
  protocol: 'oidc'
  client: TangleOidcSsoAuthClient
  store: TangleOidcSsoAccountStore
  /** Pass the Runtime's `createPkcePair` helper from the OIDC-only caller. */
  createPkcePair: () => Promise<{ verifier: string; challenge: string }>
}

/** First-party identity login; no Platform API key is issued or stored. */
export interface AppAuthIdentitySsoConfig extends Omit<AppAuthSsoConfig, 'protocol' | 'client' | 'store'> {
  protocol: 'identity'
  client: TangleIdentitySsoAuthClient
  store: TangleIdentitySsoAccountStore
}

/** Define the structure for application authentication data including users, sessions, accounts, and verifications */
export interface AppAuthSchema {
  users: unknown
  sessions: unknown
  accounts: unknown
  verifications: unknown
}

/** Define configuration settings for app authentication including app name, base URL, secrets, and trusted origins */
export interface AppAuthConfig {
  /** Product name — used in email subjects and as the cookie-prefix default. */
  appName: string
  /** Absolute origin better-auth serves from (`BETTER_AUTH_URL`). */
  baseURL: string
  /** better-auth HMAC secret. Optional only because better-auth falls back to
   *  the BETTER_AUTH_SECRET env var; `sso` needs it explicitly (or
   *  `sso.stateSecret`). */
  secret?: string
  trustedOrigins?: string[]
  /**
   * Session-cookie prefix. Default: slugified `appName`. A per-app prefix is
   * load-bearing, not cosmetic: the platform (id.tangle.tools) mints its own
   * better-auth cookie `Domain=.tangle.tools`-wide under the DEFAULT name, and
   * the platform's (older) cookie wins the Cookie-header order — an app on the
   * default prefix reads the platform's token, fails its own signature check,
   * and every fresh login lands back on /login.
   */
  cookiePrefix?: string
  /** Drizzle database instance; wired through better-auth's drizzle adapter
   *  together with `schema`. */
  db?: unknown
  /** The product's users/sessions/accounts/verifications tables (mapped to
   *  better-auth's user/session/account/verification models). */
  schema?: AppAuthSchema
  /** Drizzle dialect. Default 'sqlite' (D1). */
  provider?: 'sqlite' | 'pg' | 'mysql'
  /** Escape hatch: a pre-built better-auth database adapter (e.g.
   *  `memoryAdapter` in tests). Wins over `db`/`schema`. */
  database?: BetterAuthOptions['database']
  /** Email+password sign-in. Default true (all current products enable it). */
  emailAndPassword?: boolean
  /** Reset/verification mail. Omit to disable password reset entirely. */
  email?: AppAuthEmailConfig
  social?: AppAuthSocialConfig
  /** Session cookie-cache TTL in seconds; `false` disables the cache.
   *  Default 300. */
  sessionCookieCacheSeconds?: number | false
  /** Tangle cross-site SSO (start/callback handlers). */
  sso?: AppAuthSsoConfig | AppAuthOidcSsoConfig | AppAuthIdentitySsoConfig
  /** Where guards redirect unauthenticated page requests. Default '/login'. */
  loginPath?: string
  /** Merged over the factory's `advanced` block (cookiePrefix stays unless
   *  overridden here). */
  advanced?: BetterAuthOptions['advanced']
}

/** The configured better-auth instance, typed at better-auth's base surface
 *  (`handler`, `api`, `$context`, `$Infer`). */
export type AppAuthInstance = Auth

/** What `getSession`/guards resolve: better-auth's base session + user rows. */
export interface AppAuthSession {
  session: Session
  user: User
}

/** Define authentication guard with session retrieval and optional SSO handlers for app requests */
export interface AppAuth extends AuthGuard<AppAuthSession> {
  auth: AppAuthInstance
  /** `auth.api.getSession` over a `Request` — the seam the guards consume. */
  getSession(request: Request): Promise<AppAuthSession | null>
  /** Tangle SSO start/callback handlers; null unless `sso` was configured. */
  sso: TangleSsoHandlers | null
}

/** Lowercased, non-alphanumerics collapsed to '-': `'Legal Agent'` → `'legal-agent'`. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function emailProduct(config: AppAuthConfig): EmailProduct {
  return { name: config.appName, url: config.baseURL }
}

function resolveEmailClient(email: AppAuthEmailConfig): AppAuthEmailClient | null {
  return typeof email.resend === 'function' ? email.resend() : email.resend
}

type DrizzleAuthAdapter = ReturnType<ReturnType<typeof drizzleAdapter>>

/** Better Auth reads adapter identity during startup, before Workers inject D1.
 * Build the Drizzle adapter on its first database operation. */
function deferDrizzleAdapter(
  db: Record<string, unknown>,
  config: Parameters<typeof drizzleAdapter>[1],
): ReturnType<typeof drizzleAdapter> {
  return (options) => {
    let adapter: DrizzleAuthAdapter | undefined
    const resolve = () => (adapter ??= drizzleAdapter(db, config)(options))

    return {
      id: 'drizzle',
      create: (data) => resolve().create(data),
      findOne: (data) => resolve().findOne(data),
      findMany: (data) => resolve().findMany(data),
      count: (data) => resolve().count(data),
      update: (data) => resolve().update(data),
      updateMany: (data) => resolve().updateMany(data),
      delete: (data) => resolve().delete(data),
      deleteMany: (data) => resolve().deleteMany(data),
      consumeOne: (data) => resolve().consumeOne(data),
      incrementOne: (data) => resolve().incrementOne(data),
      transaction: (callback) => resolve().transaction(callback),
    }
  }
}

/** Resend reports failures in the resolved value, not by rejecting — surface
 *  them loud so better-auth's flow (and the caller's logs) see the failure. */
async function sendEmail(client: AppAuthEmailClient, from: string, to: string, message: EmailMessage): Promise<void> {
  const { subject, html, text, attachments } = message
  const result = (await client.emails.send({ from, to, subject, html, text, attachments })) as
    | { error?: { message?: string } | null }
    | null
    | undefined
  if (result && typeof result === 'object' && result.error) {
    throw new Error(`[app-auth] email send failed: ${result.error.message ?? 'unknown error'}`)
  }
}

function resolveDatabase(config: AppAuthConfig): NonNullable<BetterAuthOptions['database']> {
  if (config.database) return config.database
  if (config.db && config.schema) {
    return deferDrizzleAdapter(config.db as Record<string, unknown>, {
      provider: config.provider ?? 'sqlite',
      schema: {
        user: config.schema.users,
        session: config.schema.sessions,
        account: config.schema.accounts,
        verification: config.schema.verifications,
      } as Record<string, unknown>,
    })
  }
  throw new Error(
    'createAppAuth requires a database: pass `db` + `schema` (drizzle) or `database` (a better-auth adapter)',
  )
}

function resolveSocialProviders(social: AppAuthSocialConfig | undefined): BetterAuthOptions['socialProviders'] {
  const providers: NonNullable<BetterAuthOptions['socialProviders']> = {}
  if (social?.github?.clientId && social.github.clientSecret) {
    providers.github = { clientId: social.github.clientId, clientSecret: social.github.clientSecret }
  }
  if (social?.google?.clientId && social.google.clientSecret) {
    providers.google = { clientId: social.google.clientId, clientSecret: social.google.clientSecret }
  }
  return Object.keys(providers).length > 0 ? providers : undefined
}

function emailAndPasswordOptions(config: AppAuthConfig): BetterAuthOptions['emailAndPassword'] {
  const email = config.email
  if (!email) return { enabled: true }
  const warn = email.warn ?? ((message: string) => console.warn(message))
  return {
    enabled: true,
    sendResetPassword: async ({ user, url }) => {
      const client = resolveEmailClient(email)
      if (!client) {
        warn('[app-auth] email client unavailable — password reset email not sent')
        return
      }
      await sendEmail(client, email.from, user.email, noticeEmail(emailProduct(config), {
        subject: 'Reset your password',
        title: 'Reset your password',
        body: `Someone asked to reset the password for ${user.email}. If it was not you, ignore this email.`,
        action: { label: 'Reset password', url },
        showLink: true,
        note: 'This link expires in 1 hour.',
        footer: { reason: 'You received this because a password reset was requested for this address.' },
      }))
    },
  }
}

function emailVerificationOptions(config: AppAuthConfig): BetterAuthOptions['emailVerification'] {
  const email = config.email
  if (!email?.verifyOnSignUp) return undefined
  const warn = email.warn ?? ((message: string) => console.warn(message))
  return {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      const client = resolveEmailClient(email)
      if (!client) {
        warn('[app-auth] email client unavailable — verification email not sent')
        return
      }
      await sendEmail(client, email.from, user.email, noticeEmail(emailProduct(config), {
        subject: 'Verify your email',
        title: 'Verify your email',
        body: `Confirm ${user.email} to finish signing in to ${config.appName}.`,
        action: { label: 'Verify email', url },
        showLink: true,
        note: 'This link expires in 1 hour.',
        footer: { reason: `You received this because this address was used to sign in to ${config.appName}.` },
      }))
    },
  }
}

/**
 * Build the product's better-auth instance plus the request-boundary helpers:
 * `getSession` (Request → session|null), the `createAuthGuard` quartet
 * (`requireUser` 302, `requireApiUser` JSON 401, `requireSession`,
 * `getOptionalSession`), and — when `sso` is configured — the Tangle SSO
 * start/callback handlers with the session cookie minted through better-auth's
 * own name/attributes/signing (no `better-auth/crypto` in product code).
 */
export function createAppAuth(config: AppAuthConfig): AppAuth {
  if (!config.appName) throw new Error('createAppAuth: appName is required')
  if (!config.baseURL) throw new Error('createAppAuth: baseURL is required')

  const cookiePrefix = config.cookiePrefix ?? slugify(config.appName)
  if (!cookiePrefix) throw new Error('createAppAuth: cookiePrefix (or a slugifiable appName) is required')

  const socialProviders = resolveSocialProviders(config.social)
  const options: BetterAuthOptions = {
    appName: config.appName,
    baseURL: config.baseURL,
    ...(config.secret ? { secret: config.secret } : {}),
    ...(config.trustedOrigins ? { trustedOrigins: config.trustedOrigins } : {}),
    database: resolveDatabase(config),
    ...(config.emailAndPassword === false ? {} : { emailAndPassword: emailAndPasswordOptions(config) }),
    ...(config.email?.verifyOnSignUp ? { emailVerification: emailVerificationOptions(config) } : {}),
    ...(socialProviders ? { socialProviders } : {}),
    ...(config.sessionCookieCacheSeconds === false
      ? {}
      : {
          session: {
            cookieCache: {
              enabled: true,
              maxAge: config.sessionCookieCacheSeconds ?? DEFAULT_SESSION_COOKIE_CACHE_SECONDS,
            },
          },
        }),
    advanced: { cookiePrefix, ...config.advanced },
  }

  const auth: AppAuthInstance = betterAuth(options)

  const getSession = async (request: Request): Promise<AppAuthSession | null> => {
    const session = await auth.api.getSession({ headers: request.headers })
    return (session as AppAuthSession | null) ?? null
  }

  const loginPath = config.loginPath ?? '/login'
  const guard = createAuthGuard<AppAuthSession>({ getSession, loginPath })

  let sso: TangleSsoHandlers | null = null
  if (config.sso) {
    const stateSecret = config.sso.stateSecret ?? config.secret
    if (!stateSecret) {
      throw new Error(
        'createAppAuth: sso requires `secret` (or sso.stateSecret) — the signed-state CSRF cookie needs an HMAC secret',
      )
    }
    const transport = config.sso.protocol === 'oidc'
      ? { protocol: 'oidc' as const, auth: config.sso.client, store: config.sso.store, createPkcePair: config.sso.createPkcePair }
      : config.sso.protocol === 'identity'
        ? { protocol: 'identity' as const, auth: config.sso.client, store: config.sso.store }
      : { protocol: 'legacy' as const, auth: config.sso.client, store: config.sso.store }
    sso = createTangleSsoHandlers({
      ...transport,
      stateSecret,
      callbackUrl: config.sso.callbackUrl,
      stateCookieName: config.sso.stateCookieName ?? DEFAULT_STATE_COOKIE,
      setSessionCookie: createBetterAuthSessionCookieMinter(auth),
      secureCookies: config.sso.secureCookies ?? config.baseURL.startsWith('https:'),
      ...(config.sso.sessionTtlSeconds !== undefined ? { sessionTtlSeconds: config.sso.sessionTtlSeconds } : {}),
      ...(config.sso.stateTtlSeconds !== undefined ? { stateTtlSeconds: config.sso.stateTtlSeconds } : {}),
      ...(config.sso.defaultRedirectPath ? { defaultRedirectPath: config.sso.defaultRedirectPath } : {}),
      loginPath: config.sso.loginPath ?? loginPath,
      ...(config.sso.log ? { log: config.sso.log } : {}),
    })
  }

  return { auth, getSession, ...guard, sso }
}
