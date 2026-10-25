/**
 * Sign-in for the conformance runner: the two ways a member reaches an agent app, and one question both answer,
 * "does the app accept this session?". Nothing here is specific to an app; a product whose sign-in differs
 * fails the check with the status it answered.
 */

export type SignInMode = 'password' | 'sso'

/** A check failed for a reason worth reporting; its message is the cause. */
export class Failure extends Error {}

export interface MemberSession {
  origin: string
  /** A request to the app as the signed-in member; `path` is root-relative. */
  fetch(path: string, init?: RequestInit): Promise<Response>
}

const REQUEST_MS = 30_000

/** Cookies by origin: enough of a jar for one sign-in and the calls after it. */
class Jar {
  private readonly byOrigin = new Map<string, Map<string, string>>()

  header(url: string): string {
    return [...(this.byOrigin.get(new URL(url).origin) ?? [])].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  async send(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    const cookie = this.header(url)
    if (cookie) headers.set('cookie', cookie)
    const response = await fetch(url, { ...init, headers, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(REQUEST_MS) })
    this.absorb(url, response)
    return response
  }

  private absorb(url: string, response: Response): void {
    const origin = new URL(url).origin
    const jar = this.byOrigin.get(origin) ?? new Map<string, string>()
    for (const line of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split(';')
      const eq = pair.indexOf('=')
      if (eq < 1) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      const attribute = (key: string) => attributes.map(item => item.trim()).find(item => item.toLowerCase().startsWith(`${key}=`))?.slice(key.length + 1)
      const maxAge = attribute('max-age')
      const expires = attribute('expires')
      const gone = !value || (maxAge !== undefined && Number(maxAge) <= 0)
        || (maxAge === undefined && expires !== undefined && Date.parse(expires) <= Date.now())
      if (gone) jar.delete(name)
      else jar.set(name, value)
    }
    this.byOrigin.set(origin, jar)
  }
}

const snippet = async (response: Response) => (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160)

/** A sign-in POST. An auth service that answers 429 is asked again after its Retry-After (at most 20 s), twice at most. */
async function postSignIn(jar: Jar, origin: string, email: string, password: string): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await jar.send(`${origin}/api/auth/sign-in/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ email, password }),
    })
    if (response.status !== 429 || attempt === 2) return response
    const wait = Number(response.headers.get('retry-after'))
    await response.body?.cancel().catch(() => {})
    await new Promise(resolve => setTimeout(resolve, Math.min(20, Number.isFinite(wait) && wait > 0 ? wait : 5) * 1000))
  }
}

async function passwordSignIn(jar: Jar, origin: string, email: string, password: string): Promise<void> {
  const response = await postSignIn(jar, origin, email, password)
  if (response.status !== 200) throw new Failure(`password sign-in answered ${response.status}: ${await snippet(response)}`)
}

const TANGLE_AUTH_PATH = /(^|\/)auth\/tangle\//

/**
 * The app's "Log in with Tangle": its start route sends the browser to Platform, Platform signs the member in and
 * authorizes, and the app's callback sets its own session. Apps mount the start route at `/auth/tangle/start` or
 * under `/api`.
 */
async function ssoSignIn(jar: Jar, origin: string, email: string, password: string): Promise<void> {
  const answers: string[] = []
  let location: string | null = null
  for (const path of ['/auth/tangle/start', '/api/auth/tangle/start']) {
    const start = await jar.send(`${origin}${path}`)
    location = start.headers.get('location')
    if (location) break
    answers.push(`${path} answered ${start.status}`)
  }
  if (!location) throw new Failure(`SSO start sent the member nowhere (${answers.join('; ')})`)
  const authorize = new URL(location, origin)
  const platform = authorize.origin
  const member = await postSignIn(jar, platform, email, password)
  if (member.status !== 200) throw new Failure(`Platform sign-in answered ${member.status}: ${await snippet(member)}`)
  let next = authorize.href
  for (let hop = 0; hop < 8; hop += 1) {
    const response = await jar.send(next)
    const redirect = response.headers.get('location')
    if (!redirect) throw new Failure(`SSO stopped at ${new URL(next).pathname} with ${response.status}`)
    const url = new URL(redirect, next)
    if (url.origin === origin && !TANGLE_AUTH_PATH.test(url.pathname)) {
      if (url.pathname.startsWith('/login') || url.searchParams.has('error') || url.searchParams.get('connection') === 'failed') {
        throw new Failure(`the app's SSO callback sent the member to ${url.pathname}${url.search.slice(0, 80)}`)
      }
      return
    }
    next = url.href
  }
  throw new Failure('SSO did not return to the app within 8 redirects')
}

/** A redirect to sign-in or an error page is an app that did not accept the session. */
async function sessionAccepted(session: MemberSession): Promise<string> {
  const who = await session.fetch('/api/auth/get-session')
  if (who.status === 200) {
    const body = await who.json().catch(() => null) as { user?: { id?: unknown } } | null
    if (typeof body?.user?.id === 'string' && body.user.id) return 'GET /api/auth/get-session returned the user'
  }
  const workspaces = await session.fetch('/api/workspaces')
  if (workspaces.status === 200) return 'GET /api/workspaces answered 200 as the member'
  throw new Failure(`signed in, but the app does not accept the session: GET /api/auth/get-session answered ${who.status}, GET /api/workspaces ${workspaces.status}`)
}

/** Signs in and proves the app accepts the session; the detail names the proof. */
export async function signIn(input: { origin: string; mode: SignInMode; email: string; password: string }): Promise<{ session: MemberSession; detail: string }> {
  const jar = new Jar()
  if (input.mode === 'password') await passwordSignIn(jar, input.origin, input.email, input.password)
  else await ssoSignIn(jar, input.origin, input.email, input.password)
  const session: MemberSession = {
    origin: input.origin,
    fetch: (path, init = {}) => {
      const headers = new Headers(init.headers)
      if (!headers.has('origin')) headers.set('origin', input.origin)
      return jar.send(`${input.origin}${path}`, { ...init, headers })
    },
  }
  return { session, detail: `${input.mode}: ${await sessionAccepted(session)}` }
}
