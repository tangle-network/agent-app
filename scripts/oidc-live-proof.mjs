/** Run the built SSO caller against a real registered staging OIDC client. */
import { createServer } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { createTangleSsoHandlers } from '../dist/platform/index.js'
import { PlatformOidcClient, PlatformAuthError } from '@tangle-network/agent-runtime/platform'

const required = (name) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}
const origin = new URL(required('GTR_ORIGIN')).origin
const issuer = required('TANGLE_OIDC_ISSUER')
const issuerUrl = new URL(issuer)
if (issuerUrl.protocol !== 'https:' && !(issuerUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(issuerUrl.hostname))) throw new Error('Issuer requires HTTPS except on loopback')
const clientId = required('TANGLE_OIDC_CLIENT_ID')
const secure = origin.startsWith('https:')
const port = Number(process.env.PORT || 8789)
const cookieName = secure ? '__Host-gtr_oidc' : 'gtr_oidc'
const stateName = secure ? '__Host-gtr_oidc_state' : 'gtr_oidc_state'
const users = new Map()
const sessions = new Map()
const sha = (value) => createHash('sha256').update(value).digest('hex')
const emit = (data) => console.log(JSON.stringify({ at: new Date().toISOString(), ...data }))
const cookie = (value, maxAge = 3600) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
const client = new PlatformOidcClient({
  baseUrl: issuer, clientId, clientSecret: process.env.TANGLE_OIDC_CLIENT_SECRET,
  redirectUri: `${origin}/auth/tangle/callback`,
  scope: 'openid profile email offline_access',
  fetchImpl: async (input, init = {}) => {
    const response = await fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) })
    const form = init.body instanceof URLSearchParams ? init.body : typeof init.body === 'string' ? new URLSearchParams(init.body) : null
    emit({ kind: 'provider_http', origin: new URL(String(input)).origin, path: new URL(String(input)).pathname, method: init.method || 'GET', grant: form?.get('grant_type') || null, status: response.status })
    return response
  },
})
const handlers = createTangleSsoHandlers({
  protocol: 'oidc', auth: client,
  callbackUrl: `${origin}/auth/tangle/callback`, stateCookieName: stateName,
  stateSecret: randomBytes(32).toString('hex'), secureCookies: secure,
  defaultRedirectPath: '/', loginPath: '/', sessionTtlSeconds: 3600,
  setSessionCookie: ({ token }) => [cookie(token)],
  log: (message) => emit({ kind: 'caller_error', message }),
  store: {
    async resolveAccount({ platformUserId }) { return users.has(platformUserId) ? { kind: 'existing', userId: platformUserId, matchedBy: 'platform-id' } : { kind: 'create' } },
    async upsertUserByEmail({ tangleUserId, email, name }) { users.set(tangleUserId, { id: tangleUserId, email, name }); return { userId: tangleUserId } },
    async createSession({ userId, expiresAt }) { const token = randomBytes(32).toString('hex'); sessions.set(token, { userId, expiresAt: +expiresAt, busy: false, blocked: false }); return { token } },
    async saveTangleLink({ sessionToken, tokens, accessTokenExpiresAt }) { Object.assign(sessions.get(sessionToken), { tokens, accessTokenExpiresAt: +accessTokenExpiresAt }); emit({ kind: 'sign_in', clientId, issuer, access_sha256: sha(tokens.accessToken), refresh_sha256: sha(tokens.refreshToken), scope: tokens.scope }) },
    async deleteSession({ sessionToken }) { sessions.delete(sessionToken) },
  },
})
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } })
const publicSession = (session) => ({ user: users.get(session.userId), expiresAt: session.expiresAt, accessTokenExpiresAt: session.accessTokenExpiresAt, refreshAvailable: Boolean(session.tokens.refreshToken) })
const page = `<!doctype html><meta charset="utf-8"><title>Tangle OIDC live proof</title><h1>Tangle OIDC live proof</h1><p><a href="/auth/tangle">Sign in through staging</a></p><button id="session">Session</button> <button id="refresh">Refresh</button> <button id="disconnect">Disconnect and prove revoked refresh</button><pre id="output"></pre><script src="/proof.js"></script>`
const script = `for(const action of ['session','refresh','disconnect']) document.getElementById(action).onclick=async()=>{const r=await fetch('/api/'+action,{method:action==='session'?'GET':'POST'});document.getElementById('output').textContent=JSON.stringify({status:r.status,...await r.json()},null,2)}`

async function route(request) {
  const url = new URL(request.url)
  if (request.method === 'GET' && url.pathname === '/') return new Response(page, { headers: { 'content-type': 'text/html', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self'; frame-ancestors 'none'" } })
  if (request.method === 'GET' && url.pathname === '/proof.js') return new Response(script, { headers: { 'content-type': 'application/javascript' } })
  if (url.pathname === '/auth/tangle') return handlers.start(request)
  if (url.pathname === '/auth/tangle/callback') return handlers.callback(request)
  const token = request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
  const session = token && sessions.get(token)
  if (!session || session.expiresAt <= Date.now()) return json({ error: 'authentication_required' }, 401)
  if (url.pathname === '/api/session' && request.method === 'GET') return session.blocked ? json({ error: 'session_blocked' }, 401) : json(publicSession(session))
  if (!['/api/refresh', '/api/disconnect'].includes(url.pathname)) return json({ error: 'not_found' }, 404)
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' })
  if (request.headers.get('origin') !== origin) return json({ error: 'origin_required' }, 403)
  if (session.busy) return json({ error: 'operation_in_progress' }, 409, { 'retry-after': '1' })
  session.busy = true
  try {
    if (url.pathname === '/api/refresh') {
      if (session.blocked) return json({ error: 'session_blocked' }, 401)
      const previous = session.tokens
      const requestedAt = Date.now()
      const next = await client.refresh(previous.refreshToken)
      session.tokens = { ...next, refreshToken: next.refreshToken || previous.refreshToken, scope: next.scope || previous.scope }
      session.blocked = true
      const identity = await client.userinfo(next.accessToken)
      if (identity.id !== session.userId || identity.emailVerified !== true || !Number.isFinite(next.expiresIn) || next.expiresIn <= 0) throw new Error('Invalid refreshed identity or lifetime')
      session.accessTokenExpiresAt = requestedAt + next.expiresIn * 1000
      session.blocked = false
      const evidence = { kind: 'refresh', status: 200, subjectUnchanged: true, accessChanged: next.accessToken !== previous.accessToken, refreshRotated: session.tokens.refreshToken !== previous.refreshToken, access_sha256: sha(next.accessToken), refresh_sha256: sha(session.tokens.refreshToken) }
      emit(evidence)
      return json({ ...publicSession(session), evidence })
    }
    session.blocked = true
    const revokedRefresh = session.tokens.refreshToken
    await client.revoke(revokedRefresh, 'refresh_token')
    await client.revoke(session.tokens.accessToken, 'access_token')
    let rejected = false
    let status
    let unexpected
    try {
      unexpected = await client.refresh(revokedRefresh)
    } catch (error) {
      status = error instanceof PlatformAuthError ? error.status : undefined
      rejected = error instanceof PlatformAuthError && error.status === 400 && error.body?.error === 'invalid_grant'
    }
    // Cleanup failure is not evidence that the refresh request was rejected.
    if (unexpected) {
      try { await client.revoke(unexpected.refreshToken || revokedRefresh, 'refresh_token') } catch {}
      try { await client.revoke(unexpected.accessToken, 'access_token') } catch {}
    }
    sessions.delete(token)
    const evidence = { kind: 'disconnect', revokedRefreshRejected: rejected, revokedRefreshStatus: status, refresh_sha256: sha(revokedRefresh) }
    emit(evidence)
    return json(evidence, rejected ? 200 : 502, { 'set-cookie': cookie('', 0) })
  } catch {
    session.blocked = true
    emit({ kind: 'lifecycle_failure', path: url.pathname })
    return json({ error: 'lifecycle_failed', retryDisconnect: true }, 502)
  } finally { session.busy = false }
}

createServer(async (req, res) => {
  try {
    const request = new Request(new URL(req.url || '/', origin), { method: req.method, headers: req.headers })
    const response = await route(request)
    res.statusCode = response.status
    for (const [name, value] of response.headers) if (name !== 'set-cookie') res.setHeader(name, value)
    const cookies = response.headers.getSetCookie()
    if (cookies.length) res.setHeader('set-cookie', cookies)
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"caller_failed"}') }
}).listen(port, process.env.HOST || '127.0.0.1', () => emit({ kind: 'listening', origin, issuer, clientId, port }))
