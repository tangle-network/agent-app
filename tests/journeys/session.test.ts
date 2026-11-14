import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveJourneysConfig } from '../../src/journeys/config'
import { secretNeedles, storageStateFor } from '../../src/journeys/session'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  delete process.env.JOURNEY_TEST_EMAIL
  delete process.env.JOURNEY_TEST_PASSWORD
})

describe('secretNeedles', () => {
  it('collects passwords and every cached cookie value, whole, decoded and as its token half', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'journeys-state-'))
    dirs.push(stateDir)
    process.env.JOURNEY_TEST_EMAIL = 'smoke@example.com'
    process.env.JOURNEY_TEST_PASSWORD = 'correct-horse-battery-staple'
    const config = resolveJourneysConfig({
      app: 'tax',
      baseUrl: 'https://tax.example.com',
      stateDir,
      identities: { member: { emailEnv: 'JOURNEY_TEST_EMAIL', passwordEnv: 'JOURNEY_TEST_PASSWORD', signIn: 'tangle' } },
    }, {})
    const sessions = join(stateDir, 'sessions', 'tax.example.com')
    mkdirSync(sessions, { recursive: true })
    const token = 'abcdefghijklmnopqrstuvwx'
    writeFileSync(join(sessions, 'member.storage.json'), JSON.stringify({ cookies: [
      { value: `${token}.c2lnbmF0dXJlPT0%3D` },
      { value: 'short' },
    ] }))
    writeFileSync(join(sessions, 'member.storage.json.tmp'), '{ half-written')
    const needles = secretNeedles(config)
    expect(needles.soft).toEqual(['smoke@example.com'])
    expect(needles.hard).toEqual(['correct-horse-battery-staple', `${token}.c2lnbmF0dXJlPT0%3D`, `${token}.c2lnbmF0dXJlPT0=`, token])
  })
})

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

describe('storageStateFor with "Log in with Tangle"', () => {
  it('follows the redirect chain through the app callback and accepts a session endpoint that returns the user itself', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'journeys-state-'))
    dirs.push(stateDir)
    process.env.JOURNEY_TEST_EMAIL = 'smoke@example.com'
    process.env.JOURNEY_TEST_PASSWORD = 'correct-horse-battery-staple'
    const hits: string[] = []
    let appOrigin = ''
    // Platform: email sign-in sets its session; authorize returns the person to the app callback with a code.
    const platform = await listen((req, res) => {
      const url = new URL(req.url!, 'http://platform')
      hits.push(`platform ${req.method} ${url.pathname}`)
      if (req.method === 'POST' && url.pathname === '/api/auth/sign-in/email') {
        let body = ''
        req.on('data', (chunk) => (body += chunk))
        req.on('end', () => {
          const { email, password } = JSON.parse(body) as { email: string; password: string }
          if (email !== 'smoke@example.com' || password !== 'correct-horse-battery-staple') return res.writeHead(401).end()
          res.writeHead(200, { 'set-cookie': 'platform_session=p1; Path=/; HttpOnly', 'content-type': 'application/json' }).end('{}')
        })
        return
      }
      if (url.pathname === '/authorize') {
        if (!req.headers.cookie?.includes('platform_session=p1')) return res.writeHead(302, { location: '/sign-in' }).end()
        return res.writeHead(302, { location: `${url.searchParams.get('redirect_uri')}?code=c1` }).end()
      }
      res.writeHead(404).end()
    })
    // App: start -> Platform, /callback exchanges the code and redirects on, /api/auth/me answers with a bare user.
    const app = await listen((req, res) => {
      const url = new URL(req.url!, appOrigin)
      hits.push(`app ${req.method} ${url.pathname}`)
      const signedIn = req.headers.cookie?.includes('app_session=a1') === true
      if (url.pathname === '/api/auth/login') {
        return res.writeHead(302, { location: `${platform.origin}/authorize?redirect_uri=${encodeURIComponent(`${appOrigin}/callback`)}` }).end()
      }
      if (url.pathname === '/callback') {
        if (url.searchParams.get('code') !== 'c1') return res.writeHead(302, { location: '/login?error=bad_code' }).end()
        return res.writeHead(302, { location: '/dashboard', 'set-cookie': 'app_session=a1; Path=/; HttpOnly' }).end()
      }
      if (url.pathname === '/dashboard') {
        if (!signedIn) return res.writeHead(302, { location: '/login' }).end()
        return res.writeHead(200, { 'content-type': 'text/html' }).end('<main>Dashboard</main>')
      }
      if (url.pathname === '/api/auth/me') {
        if (!signedIn) return res.writeHead(401).end()
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'u1', name: 'Smoke', email: 'smoke@example.com' }))
      }
      res.writeHead(404).end()
    })
    appOrigin = app.origin
    try {
      const config = resolveJourneysConfig({
        app: 'browser',
        baseUrl: app.origin,
        stateDir,
        identities: { member: { emailEnv: 'JOURNEY_TEST_EMAIL', passwordEnv: 'JOURNEY_TEST_PASSWORD', signIn: 'tangle' } },
        auth: { session: '/api/auth/me', tangleStart: '/api/auth/login' },
      }, {})
      const { user } = await storageStateFor(config, 'member')
      expect(user).toEqual({ id: 'u1', name: 'Smoke', emailVerified: false })
      expect(hits).toContain('app GET /callback')
      expect(hits).toContain('app GET /dashboard')
    } finally {
      app.server.close()
      platform.server.close()
    }
  })
})
