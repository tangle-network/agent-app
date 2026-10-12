/**
 * Signed-in browser state for an app's test identities, with no login form in
 * any recorded frame.
 *
 * Sign-in happens over HTTP, never in a rendered page, so a recording starts
 * already signed in and no frame can show a password. The resulting storage
 * state (session cookies) is cached per origin and identity under the state
 * directory (mode 0600) and reused while the app's session endpoint still
 * answers with a verified user. Journeys running in parallel share it, so a
 * burst of journeys cannot trip an auth rate limit.
 *
 * Never press Sign out in a shared session: it revokes the session every
 * journey on the host is using. A journey that signs out opens its context with
 * `{ fresh: true }`, which signs in a session of its own.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { APIRequestContext } from 'playwright'
import type { JourneyIdentity, ResolvedJourneysConfig } from './config.js'

export interface SessionUser {
  id: string
  name: string | null
  emailVerified: boolean
}

class SignInError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function playwrightRequest() {
  try {
    return (await import('playwright')).request
  } catch {
    throw new Error('journeys need the optional `playwright` peer: install playwright in the app that runs them')
  }
}

function sessionDir(config: ResolvedJourneysConfig): string {
  return join(config.stateDir, 'sessions', new URL(config.baseUrl).host)
}

function storageStatePath(config: ResolvedJourneysConfig, identity: string): string {
  return join(sessionDir(config), `${identity}.storage.json`)
}

function need(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is unset: load it from the host's vault into this process (the value is never printed)`)
  return value
}

/** The signed-in user behind a storage state, or null when it no longer signs in. */
export async function sessionUser(config: ResolvedJourneysConfig, state: string): Promise<SessionUser | null> {
  if (!existsSync(state)) return null
  const request = await playwrightRequest()
  const ctx = await request.newContext({ baseURL: config.baseUrl, storageState: state })
  try {
    const r = await ctx.get(config.auth.session, { maxRedirects: 0, timeout: 20_000 })
    if (!r.ok()) return null
    const body = (await r.json().catch(() => null)) as { user?: { id?: string; name?: string; emailVerified?: boolean } } | null
    const user = body?.user
    if (!user?.id) return null
    return { id: user.id, name: user.name ?? null, emailVerified: user.emailVerified === true }
  } finally {
    await ctx.dispose()
  }
}

async function signInWithPassword(ctx: APIRequestContext, config: ResolvedJourneysConfig, email: string, password: string): Promise<void> {
  const r = await ctx.post(`${config.baseUrl}${config.auth.passwordSignIn}`, {
    headers: { 'content-type': 'application/json', origin: config.baseUrl },
    data: { email, password },
    maxRedirects: 0,
  })
  if (r.status() !== 200) throw new SignInError(r.status(), `email sign-in returned ${r.status()}`)
}

/** "Log in with Tangle": the app's start route, Platform sign-in, authorize, the app's callback. */
async function signInWithTangle(ctx: APIRequestContext, config: ResolvedJourneysConfig, email: string, password: string): Promise<void> {
  const base = config.baseUrl
  const start = await ctx.get(`${base}${config.auth.tangleStart}`, { maxRedirects: 0 })
  const first = start.headers()['location']
  if (!first) throw new SignInError(start.status(), `SSO start returned ${start.status()} without a redirect`)
  const authorize = new URL(first, base).toString()
  const platform = new URL(authorize).origin
  const signIn = await ctx.post(`${platform}/api/auth/sign-in/email`, {
    headers: { 'content-type': 'application/json', origin: platform },
    data: { email, password },
    maxRedirects: 0,
  })
  if (signIn.status() !== 200) throw new SignInError(signIn.status(), `Platform sign-in returned ${signIn.status()}`)
  const startPrefix = config.auth.tangleStart.replace(/\/start$/, '/')
  let next = authorize
  for (let hop = 0; hop < 8; hop += 1) {
    const r = await ctx.get(next, { maxRedirects: 0 })
    const location = r.headers()['location']
    // Only a pathname is ever reported: the query carries OAuth codes.
    if (!location) throw new SignInError(r.status(), `SSO stopped at ${new URL(next).pathname} with ${r.status()}`)
    const url = new URL(location, next)
    if (url.origin === new URL(base).origin && !url.pathname.startsWith(startPrefix)) {
      if (url.pathname.startsWith('/login')) throw new SignInError(401, 'the app callback refused the sign-in')
      return
    }
    next = url.toString()
  }
  throw new SignInError(0, 'SSO did not return to the app within 8 redirects')
}

/** A cross-process lock: mkdir is atomic. A lock older than two minutes is stale. */
async function withLock<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 180_000
  for (;;) {
    try {
      mkdirSync(dir)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const age = Date.now() - (statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? Date.now())
      if (age > 120_000) rmSync(dir, { recursive: true, force: true })
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${dir}`)
      await sleep(500)
    }
  }
  try {
    return await work()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function identityOf(config: ResolvedJourneysConfig, name: string): JourneyIdentity {
  const identity = config.identities[name]
  if (!identity) throw new Error(`"${name}" is not an identity in the ${config.app} journeys config (${Object.keys(config.identities).join(', ')})`)
  return identity
}

/**
 * Path to a storage state signed in as `identity`. Reused while valid;
 * `fresh` signs in a session of its own (for a journey that signs out).
 */
export async function storageStateFor(
  config: ResolvedJourneysConfig,
  name: string,
  opts: { fresh?: boolean } = {},
): Promise<{ path: string; user: SessionUser }> {
  const identity = identityOf(config, name)
  const dir = sessionDir(config)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = opts.fresh ? join(dir, `${name}.${process.pid}.${Date.now()}.storage.json`) : storageStatePath(config, name)
  const request = await playwrightRequest()
  return withLock(join(dir, `signin-${name}.lock`), async () => {
    if (!opts.fresh) {
      const cached = await sessionUser(config, file)
      if (cached) return { path: file, user: cached }
    }
    const email = need(identity.emailEnv)
    const password = need(identity.passwordEnv)
    for (let attempt = 1; ; attempt += 1) {
      const ctx = await request.newContext({ baseURL: config.baseUrl })
      try {
        if (identity.signIn === 'password') await signInWithPassword(ctx, config, email, password)
        else await signInWithTangle(ctx, config, email, password)
        const tmp = `${file}.tmp`
        await ctx.storageState({ path: tmp })
        chmodSync(tmp, 0o600)
        renameSync(tmp, file)
        break
      } catch (error) {
        const status = error instanceof SignInError ? error.status : 0
        if (status !== 429 || attempt >= 4) throw error
        await sleep(15_000 * attempt)
      } finally {
        await ctx.dispose()
      }
    }
    const user = await sessionUser(config, file)
    if (!user) throw new Error(`${name} signed in but ${config.auth.session} has no user`)
    // A read-only journey can still run; one that chats will be refused, so say so before it tries.
    if (!user.emailVerified) console.warn(`${name} signed in but is not email-verified; an app that requires verification will refuse its chat`)
    return { path: file, user }
  })
}

/**
 * Every value that must never leave the host. `hard`: passwords and each cookie
 * value (whole, URL-decoded, and its token half). `soft`: the identities'
 * emails, which are warned about but not refused.
 */
export function secretNeedles(config: ResolvedJourneysConfig): { hard: string[]; soft: string[] } {
  const hard = new Set<string>()
  const soft = new Set<string>()
  for (const identity of Object.values(config.identities)) {
    const password = process.env[identity.passwordEnv]?.trim()
    if (password) hard.add(password)
    const email = process.env[identity.emailEnv]?.trim()
    if (email) soft.add(email)
  }
  const root = join(config.stateDir, 'sessions')
  const stack = existsSync(root) ? [root] : []
  while (stack.length) {
    const dir = stack.pop()!
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.name.endsWith('.storage.json')) addCookieNeedles(path, hard)
    }
  }
  return { hard: [...hard], soft: [...soft] }
}

function addCookieNeedles(file: string, hard: Set<string>): void {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as { cookies?: { value: string }[] }
    for (const { value } of state.cookies ?? []) {
      if (!value || value.length < 16) continue
      hard.add(value)
      let decoded = value
      try {
        decoded = decodeURIComponent(value)
      } catch {
        // A value that is not URI-encoded is already its own decoded form.
      }
      hard.add(decoded)
      const token = decoded.split('.')[0] ?? ''
      if (token.length >= 16) hard.add(token)
    }
  } catch {
    // A half-written state file holds nothing a finished run used.
  }
}
