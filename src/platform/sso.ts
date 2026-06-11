/**
 * Cross-site Tangle SSO for agent apps: signed-state CSRF cookies plus the
 * full start/callback orchestration against the platform's /cross-site
 * bridge. The platform wire client and account persistence are structural
 * seams (`TangleSsoAuthClient` / `TangleSsoAccountStore`), so this module
 * never imports agent-runtime, an auth framework, or a database driver.
 * WebCrypto only — runs in workerd without node compatibility flags.
 */

import { clearCookieHeader, readCookieValue, serializeCookie } from '../web/index'

const DEFAULT_STATE_TTL_SECONDS = 600
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7
const DEFAULT_REDIRECT_PATH = '/app'
const DEFAULT_LOGIN_PATH = '/login'
const DEFAULT_SESSION_COOKIE = 'better-auth.session_token'

// ── Signed state ────────────────────────────────────────────────────────────

export interface SsoStateConfig {
  /** HMAC-SHA256 secret (e.g. the app's auth secret). */
  secret: string
  /** State lifetime in ms. Default 600 000. */
  ttlMs?: number
  /** Injectable clock (ms since epoch). Default Date.now. */
  now?: () => number
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

async function hmacBytes(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))
}

async function hmacHex(secret: string, value: string): Promise<string> {
  return Array.from(await hmacBytes(secret, value), (b) => b.toString(16).padStart(2, '0')).join('')
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Mint a `<randomHex32>.<timestamp36>.<hmacHex>` state value. The timestamp
 *  is inside the signed payload, so expiry survives cookie-attribute tampering. */
export async function createSignedSsoState(config: SsoStateConfig): Promise<string> {
  if (!config.secret) throw new Error('SsoStateConfig.secret is required')
  const now = config.now ?? Date.now
  const payload = `${randomHex(16)}.${now().toString(36)}`
  return `${payload}.${await hmacHex(config.secret, payload)}`
}

/** Verify the MAC (constant-time) and the signed TTL. */
export async function verifySignedSsoState(state: string, config: SsoStateConfig): Promise<boolean> {
  if (!config.secret) throw new Error('SsoStateConfig.secret is required')
  const parts = state.split('.')
  if (parts.length !== 3) return false
  const [random, timestamp, mac] = parts
  if (!random || !timestamp || !mac) return false
  const expected = await hmacHex(config.secret, `${random}.${timestamp}`)
  if (!constantTimeEqual(mac, expected)) return false
  const mintedAt = parseInt(timestamp, 36)
  if (!Number.isFinite(mintedAt)) return false
  const now = config.now ?? Date.now
  const ttlMs = config.ttlMs ?? DEFAULT_STATE_TTL_SECONDS * 1000
  return now() - mintedAt <= ttlMs
}

// ── Seams ───────────────────────────────────────────────────────────────────

export interface TangleSsoExchangeResult {
  apiKey: string
  user: { id: string; email: string; name?: string | null }
  plan?: { tier: string } | null
}

/** Structural mirror of the platform auth wire client — any object with these
 *  two methods satisfies it without this module importing the concrete class. */
export interface TangleSsoAuthClient {
  authorizeUrl(options: { state: string; redirectUri?: string }): string
  exchange(code: string): Promise<TangleSsoExchangeResult>
}

/** Thrown by `upsertUserByEmail` when the app-local user row cannot be
 *  created; the callback handler maps it to `?error=tangle_user_create_failed`.
 *  Any other store error propagates. */
export class TangleSsoUserCreateError extends Error {
  constructor(message = 'Failed to create local user for Tangle SSO') {
    super(message)
    this.name = 'TangleSsoUserCreateError'
  }
}

/**
 * Account persistence seam. Covers both storage styles in use: link-table
 * apps (a per-user platform-link row) and session-column apps (the key on the
 * session row) — `saveTangleLink` receives both `userId` and `sessionToken`,
 * and each app persists with the key it needs. `createSession` runs first so
 * the token is always available to `saveTangleLink`.
 */
export interface TangleSsoAccountStore {
  /** Find-or-create the app-local user. `tangleUserId` is the platform's
   *  stable user id — match on it first when the app stores it (emails are
   *  mutable on the platform; the id is not), falling back to email for
   *  first-time logins. */
  upsertUserByEmail(input: { email: string; name: string | null; tangleUserId: string }): Promise<{ userId: string }>
  /** Create an app session row; returns the session-cookie token value. */
  createSession(input: {
    userId: string
    expiresAt: Date
    ipAddress: string | null
    userAgent: string | null
  }): Promise<{ token: string }>
  /** Persist the platform link (API key + platform identity). */
  saveTangleLink(input: {
    userId: string
    sessionToken: string
    tangleUserId: string
    email: string
    name: string | null
    apiKey: string
    planTier: string | null
  }): Promise<void>
}

// ── Session cookie ──────────────────────────────────────────────────────────

/** Successful-login context handed to the `setSessionCookie` seam. */
export interface TangleSsoSessionCookieArgs {
  /** Session token returned by `store.createSession`. */
  token: string
  /** Session expiry (now + `sessionTtlSeconds`). */
  expiresAt: Date
  /** Mirrors `sessionTtlSeconds` after defaulting. */
  ttlSeconds: number
  /** Mirrors `TangleSsoHandlerOptions.secureCookies`. */
  secure: boolean
}

/**
 * Sign a session token to better-call's signed-cookie contract — the value
 * better-auth's `getSignedCookie` verifies: `<token>.<signature>` where the
 * signature is the raw HMAC-SHA256 of the token under `secret`, encoded as
 * STANDARD base64 WITH padding (32 bytes → 44 chars ending `=`; better-call
 * rejects any other length or suffix, so url-safe/unpadded variants read back
 * as a null session). The joined value is percent-encoded once at cookie
 * serialization, matching better-call's `serializeSignedCookie` byte-exactly.
 */
export async function signSessionCookieValue(token: string, secret: string): Promise<string> {
  if (!secret) throw new Error('signSessionCookieValue requires a non-empty secret')
  const sig = await hmacBytes(secret, token)
  let bin = ''
  for (const byte of sig) bin += String.fromCharCode(byte)
  return `${token}.${btoa(bin)}`
}

// ── Handlers ────────────────────────────────────────────────────────────────

export interface TangleSsoHandlerOptions {
  auth: TangleSsoAuthClient
  store: TangleSsoAccountStore
  /** HMAC secret for the state cookie. */
  stateSecret: string
  /** Absolute callback URL registered with the platform. */
  callbackUrl: string
  stateCookieName: string
  /** Default 'better-auth.session_token'. Ignored when `setSessionCookie` is
   *  provided. The default path prepends `__Secure-` iff `secureCookies`. */
  sessionCookieName?: string
  /** Mint the host auth framework's own session cookie(s); return complete
   *  Set-Cookie header values (the handler appends them verbatim and sets no
   *  session cookie itself). Supply this when the framework should stay
   *  authoritative over name/prefix/signing/attributes — e.g. better-auth:
   *  `auth.$context.authCookies.sessionToken` + `makeSignature`. */
  setSessionCookie?: (
    args: TangleSsoSessionCookieArgs,
  ) => readonly string[] | Promise<readonly string[]>
  /** HMAC-SHA256 secret the host auth framework verifies session cookies with
   *  (better-auth: its `secret`). Required when `setSessionCookie` is absent —
   *  the default cookie is minted to better-call's signed contract via
   *  `signSessionCookieValue`; an unsigned or mis-signed value reads back as a
   *  null session, so there is deliberately no fallback to `stateSecret`
   *  (which is not guaranteed to be the auth secret). */
  sessionCookieSecret?: string
  /** Adds `Secure` to every cookie this module sets, and (default session
   *  cookie only) the `__Secure-` name prefix. Must match the auth
   *  framework's own secure-cookie decision (better-auth: https `baseURL` /
   *  `advanced.useSecureCookies`), or it will look up a different cookie name
   *  than the one set here. */
  secureCookies: boolean
  /** Default 604 800 (7 days). */
  sessionTtlSeconds?: number
  /** Default 600. Applies to both the cookie Max-Age and the signed TTL. */
  stateTtlSeconds?: number
  /** Default '/app'. */
  defaultRedirectPath?: string
  /** Default '/login'. */
  loginPath?: string
  /** Failure log hook (e.g. console.error). Default no-op. */
  log?: (message: string, error?: unknown) => void
  now?: () => number
}

export interface TangleSsoHandlers {
  /** GET start route: mint + sign state, set the state cookie, 302 to the
   *  platform authorize URL. `?redirect=` carries the post-login path. */
  start(request: Request): Promise<Response>
  /** GET callback route: verify state, exchange the code, upsert the user,
   *  create the session, save the platform link, set the session cookie
   *  (via the `setSessionCookie` seam, else signed to better-call's contract
   *  with `sessionCookieSecret`), 302 to the saved redirect. Every failure
   *  302s to `loginPath?error=…` with the state cookie cleared. */
  callback(request: Request): Promise<Response>
}

/** Accept only same-origin absolute paths (rejects `//host` protocol-relative URLs). */
function sanitizeRedirectPath(value: string | null, fallback: string): string {
  if (value && value.startsWith('/') && !value.startsWith('//')) return value
  return fallback
}

function redirectResponse(location: string, headers = new Headers()): Response {
  headers.set('Location', location)
  return new Response(null, { status: 302, headers })
}

/** Real client IP: `CF-Connecting-IP` behind Cloudflare, else the first
 *  `x-forwarded-for` hop (the rest of the list is sender-controlled). */
function clientIp(request: Request): string | null {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    null
  )
}

interface StateCookiePayload {
  s: string
  r: string
}

function parseStateCookiePayload(raw: string | null): StateCookiePayload | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object') return null
    const { s, r } = parsed as Record<string, unknown>
    if (typeof s !== 'string' || typeof r !== 'string') return null
    return { s, r }
  } catch {
    return null
  }
}

export function createTangleSsoHandlers(opts: TangleSsoHandlerOptions): TangleSsoHandlers {
  if (!opts.stateSecret) throw new Error('TangleSsoHandlerOptions.stateSecret is required')
  if (!opts.callbackUrl) throw new Error('TangleSsoHandlerOptions.callbackUrl is required')
  if (!opts.stateCookieName) throw new Error('TangleSsoHandlerOptions.stateCookieName is required')

  const sessionCookieName = opts.sessionCookieName ?? DEFAULT_SESSION_COOKIE

  let mintSessionCookies: (args: TangleSsoSessionCookieArgs) => Promise<readonly string[]>
  if (opts.setSessionCookie) {
    const seam = opts.setSessionCookie
    mintSessionCookies = async (args) => await seam(args)
  } else if (opts.sessionCookieSecret) {
    const secret = opts.sessionCookieSecret
    mintSessionCookies = async ({ token, secure, ttlSeconds }) => [
      serializeCookie(await signSessionCookieValue(token, secret), {
        name: secure ? `__Secure-${sessionCookieName}` : sessionCookieName,
        secure,
        maxAgeSeconds: ttlSeconds,
      }),
    ]
  } else {
    throw new Error(
      'TangleSsoHandlerOptions requires setSessionCookie or sessionCookieSecret: ' +
        'better-auth only accepts HMAC-signed (and, on https, __Secure--prefixed) session cookies, ' +
        'so an unsigned default would mint sessions that read back null',
    )
  }
  const sessionTtlSeconds = opts.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS
  const stateTtlSeconds = opts.stateTtlSeconds ?? DEFAULT_STATE_TTL_SECONDS
  const defaultRedirectPath = opts.defaultRedirectPath ?? DEFAULT_REDIRECT_PATH
  const loginPath = opts.loginPath ?? DEFAULT_LOGIN_PATH
  const log = opts.log ?? (() => {})
  const now = opts.now ?? Date.now
  const stateConfig: SsoStateConfig = { secret: opts.stateSecret, ttlMs: stateTtlSeconds * 1000, now }

  const stateCookieOpts = { name: opts.stateCookieName, secure: opts.secureCookies }

  function loginErrorRedirect(code: string): Response {
    const headers = new Headers()
    headers.append('Set-Cookie', clearCookieHeader(stateCookieOpts))
    return redirectResponse(`${loginPath}?error=${code}`, headers)
  }

  return {
    async start(request) {
      const url = new URL(request.url)
      const redirectPath = sanitizeRedirectPath(url.searchParams.get('redirect'), defaultRedirectPath)
      const state = await createSignedSsoState(stateConfig)
      const cookie = serializeCookie(JSON.stringify({ s: state, r: redirectPath }), {
        ...stateCookieOpts,
        maxAgeSeconds: stateTtlSeconds,
      })
      const headers = new Headers()
      headers.append('Set-Cookie', cookie)
      return redirectResponse(opts.auth.authorizeUrl({ state, redirectUri: opts.callbackUrl }), headers)
    },

    async callback(request) {
      const url = new URL(request.url)
      const code = url.searchParams.get('code')
      const stateFromPlatform = url.searchParams.get('state')
      if (!code || !stateFromPlatform) return loginErrorRedirect('tangle_callback_missing')

      const payload = parseStateCookiePayload(readCookieValue(request.headers.get('cookie'), opts.stateCookieName))
      if (!payload || payload.s !== stateFromPlatform) return loginErrorRedirect('tangle_state_mismatch')
      if (!(await verifySignedSsoState(payload.s, stateConfig))) return loginErrorRedirect('tangle_state_mismatch')

      let exchanged: TangleSsoExchangeResult
      try {
        exchanged = await opts.auth.exchange(code)
      } catch (err) {
        log('[tangle-sso] exchange failed', err)
        return loginErrorRedirect('tangle_exchange_failed')
      }

      let userId: string
      try {
        ;({ userId } = await opts.store.upsertUserByEmail({
          email: exchanged.user.email,
          name: exchanged.user.name ?? null,
          tangleUserId: exchanged.user.id,
        }))
      } catch (err) {
        if (err instanceof TangleSsoUserCreateError) return loginErrorRedirect('tangle_user_create_failed')
        throw err
      }

      const expiresAt = new Date(now() + sessionTtlSeconds * 1000)
      const { token } = await opts.store.createSession({
        userId,
        expiresAt,
        ipAddress: clientIp(request),
        userAgent: request.headers.get('user-agent'),
      })

      await opts.store.saveTangleLink({
        userId,
        sessionToken: token,
        tangleUserId: exchanged.user.id,
        email: exchanged.user.email,
        name: exchanged.user.name ?? null,
        apiKey: exchanged.apiKey,
        planTier: exchanged.plan?.tier ?? null,
      })

      const headers = new Headers()
      headers.append('Set-Cookie', clearCookieHeader(stateCookieOpts))
      const sessionCookies = await mintSessionCookies({
        token,
        expiresAt,
        ttlSeconds: sessionTtlSeconds,
        secure: opts.secureCookies,
      })
      for (const cookie of sessionCookies) headers.append('Set-Cookie', cookie)
      return redirectResponse(sanitizeRedirectPath(payload.r, defaultRedirectPath), headers)
    },
  }
}
