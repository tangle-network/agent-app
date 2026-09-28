import { describe, it, expect, vi } from 'vitest'
import { PlatformOidcClient } from '@tangle-network/agent-runtime/platform'
import {
  createTangleSsoHandlers,
  type TangleOidcSsoAccountStore,
  type TangleOidcSsoAuthClient,
} from '../src/platform/index'

const ORIGIN = 'http://127.0.0.1:8789'
const CALLBACK = `${ORIGIN}/auth/tangle/callback`
const STATE_SECRET = 'oidc-callback-test-state-secret-32-bytes'
const NativeResponse = Response

function harness(overrides: {
  setSessionCookie?: () => Promise<readonly string[]>
  saveTangleLink?: TangleOidcSsoAccountStore['saveTangleLink']
} = {}) {
  const calls: string[] = []
  const state = { grantPersisted: false }
  const auth: TangleOidcSsoAuthClient = {
    authorizeUrl: ({ state }) => {
      const url = new URL('http://127.0.0.1:4100/api/auth/oauth2/authorize')
      url.searchParams.set('client_id', 'local-test-client')
      url.searchParams.set('redirect_uri', CALLBACK)
      url.searchParams.set('state', state)
      return url.toString()
    },
    exchange: async () => ({
      tokens: {
        accessToken: 'access-secret',
        tokenType: 'Bearer',
        expiresIn: 3600,
        refreshToken: 'refresh-secret',
        scope: 'openid profile email offline_access',
      },
      user: { id: 'local-user', email: 'local@example.test', emailVerified: true, name: 'Local User' },
    }),
    revoke: async (_token, tokenTypeHint) => { calls.push(`revoke:${tokenTypeHint}`) },
  }
  const store: TangleOidcSsoAccountStore = {
    resolveAccount: async () => ({ kind: 'create' }),
    upsertUserByEmail: async () => ({ userId: 'local-user' }),
    createSession: async () => ({ token: 'local-session' }),
    saveTangleLink: async (input) => {
      calls.push('save-link')
      state.grantPersisted = true
      if (overrides.saveTangleLink) return overrides.saveTangleLink(input)
    },
    deleteSession: async ({ sessionToken }) => {
      calls.push(`delete-session:${sessionToken}`)
      state.grantPersisted = false
    },
  }
  const handlers = createTangleSsoHandlers({
    protocol: 'oidc',
    auth,
    store,
    stateSecret: STATE_SECRET,
    callbackUrl: CALLBACK,
    stateCookieName: 'local_oidc_state',
    secureCookies: false,
    createPkcePair: async () => ({ verifier: 'v'.repeat(43), challenge: 'c'.repeat(43) }),
    setSessionCookie: overrides.setSessionCookie ?? (async () => {
      calls.push('mint-cookie')
      return ['local_session=local-session; Path=/; HttpOnly']
    }),
    log: () => {},
  })
  return { handlers, calls, state }
}

async function callback(
  handlers: ReturnType<typeof createTangleSsoHandlers>,
  beforeCallback: () => void = () => {},
) {
  const started = await handlers.start(new Request(`${ORIGIN}/auth/tangle/start?redirect=/app`))
  const stateCookie = started.headers.getSetCookie().find((value) => value.startsWith('local_oidc_state='))!
    .split(';')[0]!
  const state = new URL(started.headers.get('Location')!).searchParams.get('state')!
  const request = new Request(`${CALLBACK}?code=local-code&state=${encodeURIComponent(state)}`, {
    headers: { cookie: stateCookie },
  })
  beforeCallback()
  return handlers.callback(request)
}

describe('OIDC callback persistence boundary', () => {
  it('accepts the maintained runtime OIDC client structurally', () => {
    const client = new PlatformOidcClient({
      baseUrl: 'http://127.0.0.1:4100',
      clientId: 'local-test-client',
      redirectUri: CALLBACK,
    })
    const auth: TangleOidcSsoAuthClient = client
    expect(auth).toBe(client)
  })

  it('prepares cookies before saving the grant on success', async () => {
    const h = harness()
    const response = await callback(h.handlers)
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/app')
    expect(h.calls).toEqual(['mint-cookie', 'save-link'])
  })

  it('mints cookies before saving the grant and cleans up when cookie minting fails', async () => {
    const h = harness({
      setSessionCookie: async () => {
        throw new Error('cookie mint failed')
      },
    })
    const response = await callback(h.handlers)
    expect(response.headers.get('Location')).toBe('/login?error=tangle_session_failed')
    expect(response.headers.getSetCookie().every((value) => !value.startsWith('local_session='))).toBe(true)
    expect(h.calls).toEqual([
      'delete-session:local-session',
      'revoke:refresh_token',
      'revoke:access_token',
    ])
    expect(h.state.grantPersisted).toBe(false)
  })

  it('constructs the redirect before saving the grant', async () => {
    const h = harness()
    try {
      const response = await callback(h.handlers, () => {
        vi.stubGlobal('Response', class extends NativeResponse {
          constructor(body: BodyInit | null, init?: ResponseInit) {
            if (init?.status === 302 && new Headers(init.headers).get('Location') === '/app') {
              throw new Error('redirect response construction failed')
            }
            super(body, init)
          }
        })
      })
      expect(response.headers.get('Location')).toBe('/login?error=tangle_session_failed')
      expect(h.calls).toEqual([
        'mint-cookie',
        'delete-session:local-session',
        'revoke:refresh_token',
        'revoke:access_token',
      ])
      expect(h.state.grantPersisted).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('asks the store to remove a grant partially written before save failure', async () => {
    const h = harness({
      saveTangleLink: async () => {
        throw new Error('grant store failed after partial write')
      },
    })
    const response = await callback(h.handlers)
    expect(response.headers.get('Location')).toBe('/login?error=tangle_session_failed')
    expect(h.calls).toEqual([
      'mint-cookie',
      'save-link',
      'delete-session:local-session',
      'revoke:refresh_token',
      'revoke:access_token',
    ])
    expect(h.state.grantPersisted).toBe(false)
  })
})
