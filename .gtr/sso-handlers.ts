export function createTangleSsoHandlers(
  opts: TangleSsoHandlerOptions | TangleOidcSsoHandlerOptions,
): TangleSsoHandlers {
  if (!opts.stateSecret) throw new Error('TangleSsoHandlerOptions.stateSecret is required')
  if (!opts.callbackUrl) throw new Error('TangleSsoHandlerOptions.callbackUrl is required')
  if (!opts.stateCookieName) throw new Error('TangleSsoHandlerOptions.stateCookieName is required')
  const callbackUrl = new URL(opts.callbackUrl)
  if (opts.protocol === 'oidc') {
    if (opts.stateSecret.length < 32) throw new Error('OIDC stateSecret must contain at least 32 characters')
    if (callbackUrl.username || callbackUrl.password || callbackUrl.hash || callbackUrl.search) {
      throw new Error('OIDC callbackUrl must be fixed and have no credentials, query, or fragment')
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(callbackUrl.hostname)
    if (callbackUrl.protocol !== 'https:' && !(callbackUrl.protocol === 'http:' && loopback)) {
      throw new Error('OIDC requires HTTPS except on loopback')
    }
    if (callbackUrl.protocol === 'https:' && !opts.secureCookies) {
      throw new Error('OIDC HTTPS callbacks require Secure cookies')
    }
  }
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
    throw new Error('TangleSsoHandlerOptions requires setSessionCookie or sessionCookieSecret')
  }
  const sessionTtlSeconds = opts.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS
  const stateTtlSeconds = opts.stateTtlSeconds ?? DEFAULT_STATE_TTL_SECONDS
  if (!Number.isFinite(stateTtlSeconds) || stateTtlSeconds <= 0
    || !Number.isFinite(sessionTtlSeconds) || sessionTtlSeconds <= 0) {
    throw new Error('SSO lifetimes must be positive and finite')
  }
  const defaultRedirectPath = sanitizeRedirectPath(opts.defaultRedirectPath ?? DEFAULT_REDIRECT_PATH, DEFAULT_REDIRECT_PATH)
  const loginPath = sanitizeRedirectPath(opts.loginPath ?? DEFAULT_LOGIN_PATH, DEFAULT_LOGIN_PATH)
  const log = opts.log ?? (() => {})
  const now = opts.now ?? Date.now
  const stateConfig: SsoStateConfig = { secret: opts.stateSecret, ttlMs: stateTtlSeconds * 1000, now }
  const stateCookieOpts = { name: opts.stateCookieName, secure: opts.secureCookies }
  function loginErrorRedirect(code: string): Response {
    const headers = new Headers()
    headers.append('Set-Cookie', clearCookieHeader(stateCookieOpts))
    const target = new URL(loginPath, REDIRECT_REFERENCE_ORIGIN)
    target.searchParams.set('error', code)
    return redirectResponse(`${target.pathname}${target.search}${target.hash}`, headers)
  }
  return {
    async start(request) {
      if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } })
      const url = new URL(request.url)
      if (opts.protocol === 'oidc' && url.origin !== callbackUrl.origin) {
        return loginErrorRedirect('tangle_origin_mismatch')
      }
      const redirectPath = sanitizeRedirectPath(url.searchParams.get('redirect'), defaultRedirectPath)
      const state = await createSignedSsoState(stateConfig)
      const payload: StateCookiePayload = { s: state, r: redirectPath }
      let authorizationUrl: string
      if (opts.protocol === 'oidc') {
        const { createPkcePair } = await import('@tangle-network/agent-runtime/platform')
        const pkce = await createPkcePair()
        payload.v = pkce.verifier
        payload.m = await hmacHex(opts.stateSecret, stateBinding(payload, opts.callbackUrl))
        authorizationUrl = opts.auth.authorizeUrl({ state, codeChallenge: pkce.challenge })
        if (new URL(authorizationUrl).searchParams.get('redirect_uri') !== opts.callbackUrl) {
          throw new Error('PlatformOidcClient.redirectUri must equal callbackUrl')
        }
      } else {
        authorizationUrl = opts.auth.authorizeUrl({ state, redirectUri: opts.callbackUrl })
      }
      const cookie = serializeCookie(JSON.stringify(payload), {
        ...stateCookieOpts,
        maxAgeSeconds: stateTtlSeconds,
      })
      const headers = new Headers()
      headers.append('Set-Cookie', cookie)
      return redirectResponse(authorizationUrl, headers)
    },
    async callback(request) {
      if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } })
      const url = new URL(request.url)
      if (opts.protocol === 'oidc'
        && (url.origin !== callbackUrl.origin || url.pathname !== callbackUrl.pathname)) {
        return loginErrorRedirect('tangle_origin_mismatch')
      }
      const code = url.searchParams.get('code')
      const stateFromPlatform = url.searchParams.get('state')
      if (!code || !stateFromPlatform || url.searchParams.has('error')) return loginErrorRedirect('tangle_callback_missing')
      const payload = parseStateCookiePayload(readCookieValue(request.headers.get('cookie'), opts.stateCookieName))
      if (!payload || !constantTimeEqual(payload.s, stateFromPlatform)) return loginErrorRedirect('tangle_state_mismatch')
      if (!(await verifySignedSsoState(payload.s, stateConfig))) return loginErrorRedirect('tangle_state_mismatch')
      if (opts.protocol === 'oidc' && (!payload.v || !/^[A-Za-z0-9_-]{43,128}$/.test(payload.v)
        || !payload.m || !constantTimeEqual(payload.m, await hmacHex(opts.stateSecret, stateBinding(payload, opts.callbackUrl))))) {
        return loginErrorRedirect('tangle_state_mismatch')
      }
      const tokenRequestedAt = now()
      let oidcTokens: OidcTokens | undefined
      let legacyExchange: TangleSsoExchangeResult | undefined
      let createdSession: string | undefined
      let committed = false
      try {
        let exchanged: { user: TangleSsoExchangeResult['user']; emailVerified: boolean }
        try {
          if (opts.protocol === 'oidc') {
            const result = await opts.auth.exchange(code, payload.v!)
            oidcTokens = result.tokens
            if (!oidcTokens.refreshToken || !Number.isFinite(oidcTokens.expiresIn) || oidcTokens.expiresIn! <= 0) {
              throw new Error('OIDC requires offline_access and a finite access-token lifetime')
            }
            exchanged = { user: result.user, emailVerified: result.user.emailVerified }
          } else {
            legacyExchange = await opts.auth.exchange(code)
            exchanged = legacyExchange
          }
        } catch {
          log('[tangle-sso] exchange failed')
          return loginErrorRedirect('tangle_exchange_failed')
        }
        if (exchanged.emailVerified !== true) {
          log('[tangle-sso] exchange did not include a verified-email proof')
          return loginErrorRedirect('tangle_exchange_failed')
        }
        let userId: string
        try {
          const email = normalizeTangleSsoEmail(exchanged.user.email)
          const resolution = await opts.store.resolveAccount({ email, platformUserId: exchanged.user.id })
          if (resolution.kind === 'reject') throw new TangleSsoAccountConflictError(resolution.reason)
          ;({ userId } = await opts.store.upsertUserByEmail({
            email,
            name: exchanged.user.name ?? null,
            tangleUserId: exchanged.user.id,
            resolution,
          }))
        } catch (err) {
          if (err instanceof TangleSsoAccountConflictError) {
            log('[tangle-sso] account linking conflict', err.reason)
            return loginErrorRedirect('tangle_account_conflict')
          }
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
        createdSession = token
        const link = {
          userId,
          sessionToken: token,
          tangleUserId: exchanged.user.id,
          email: normalizeTangleSsoEmail(exchanged.user.email),
          name: exchanged.user.name ?? null,
        }
        if (opts.protocol === 'oidc') {
          await opts.store.saveTangleLink({
            ...link,
            tokens: oidcTokens!,
            accessTokenExpiresAt: new Date(tokenRequestedAt + oidcTokens!.expiresIn! * 1000),
          })
        } else {
          await opts.store.saveTangleLink({ ...link, apiKey: legacyExchange!.apiKey, planTier: legacyExchange!.plan?.tier ?? null })
        }
        const headers = new Headers()
        headers.append('Set-Cookie', clearCookieHeader(stateCookieOpts))
        const sessionCookies = await mintSessionCookies({ token, expiresAt, ttlSeconds: sessionTtlSeconds, secure: opts.secureCookies })
        for (const cookie of sessionCookies) headers.append('Set-Cookie', cookie)
        committed = true
        return redirectResponse(sanitizeRedirectPath(payload.r, defaultRedirectPath), headers)
      } catch (error) {
        if (opts.protocol !== 'oidc') throw error
        log('[tangle-sso] local session persistence failed')
        return loginErrorRedirect('tangle_session_failed')
      } finally {
        if (opts.protocol === 'oidc' && !committed) {
          if (createdSession) {
            try { await opts.store.deleteSession({ sessionToken: createdSession }) }
            catch { log('[tangle-sso] unpublished session cleanup failed') }
          }
          if (oidcTokens) {
            try { if (oidcTokens.refreshToken) await opts.auth.revoke(oidcTokens.refreshToken, 'refresh_token') }
            catch { log('[tangle-sso] rejected grant refresh revocation failed') }
            try { await opts.auth.revoke(oidcTokens.accessToken, 'access_token') }
            catch { log('[tangle-sso] rejected grant access revocation failed') }
          }
        }
      }
    },
  }
}
