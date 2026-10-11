import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { credentialNames, loadJourneysConfig, resolveJourneysConfig, threadRouteIn, type JourneysConfig } from '../../src/journeys/config'
import { DEFAULT_FAILURE_TEXT } from '../../src/journeys/score'

const GTM: JourneysConfig = {
  app: 'gtm',
  baseUrl: 'https://gtm.example.com/',
  identities: {
    owner: { emailEnv: 'OWNER_EMAIL', passwordEnv: 'OWNER_PASSWORD', signIn: 'password' },
    member: { emailEnv: 'MEMBER_EMAIL', passwordEnv: 'MEMBER_PASSWORD', signIn: 'tangle' },
  },
  chat: {
    assistant: '.gtm-assistant-markdown',
    failureText: [/stopped before finishing/i],
    threadPath: /^\/app\/(?<workspaceId>[^/]+)\/chat\/(?<threadId>[0-9a-f]{32})\/?$/,
  },
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('resolveJourneysConfig', () => {
  it('fills agent-app defaults, keeps the app copy after the package copy, and trims the origin', () => {
    const c = resolveJourneysConfig(GTM, {})
    expect(c.baseUrl).toBe('https://gtm.example.com')
    expect(c.chat.composer).toBe('[data-testid="composer-card"]')
    expect(c.chat.failureText).toEqual([...DEFAULT_FAILURE_TEXT, /stopped before finishing/i])
    expect(c.maxTurns).toBe(6)
    expect(c.outDir.endsWith('/agent-app-journeys/gtm/out')).toBe(true)
    expect(resolveJourneysConfig(c)).toBe(c)
  })

  it('lets JOURNEYS_BASE_URL point the same journeys at a local stack', () => {
    expect(resolveJourneysConfig(GTM, { JOURNEYS_BASE_URL: 'http://localhost:5173' }).baseUrl).toBe('http://localhost:5173')
  })

  it('refuses a credential value where a variable name belongs, and the reserved anon identity', () => {
    const bad = { ...GTM, identities: { anon: { emailEnv: 'founder@example.com', passwordEnv: 'P', signIn: 'password' as const } } }
    expect(() => resolveJourneysConfig(bad, {})).toThrow(/"anon" is reserved.*emailEnv must be an environment variable NAME/)
  })

  it('needs a threadId group in a thread path', () => {
    expect(() => resolveJourneysConfig({ ...GTM, chat: { threadPath: /^\/chat\/([0-9a-f]+)$/ } }, {})).toThrow(/named group/)
  })
})

describe('threadRouteIn', () => {
  const c = resolveJourneysConfig(GTM, {})
  const thread = 'https://gtm.example.com/app/ws1/chat/0123456789abcdef0123456789abcdef'
  it('reads both ids from a thread URL on the app origin', () => {
    expect(threadRouteIn(thread, c)).toEqual({ workspaceId: 'ws1', threadId: '0123456789abcdef0123456789abcdef' })
  })
  it('refuses another origin and a non-thread path', () => {
    expect(threadRouteIn(thread.replace('gtm.example.com', 'evil.example.com'), c)).toBeNull()
    expect(threadRouteIn('https://gtm.example.com/app/ws1/chat/new', c)).toBeNull()
  })
})

describe('credentialNames and loadJourneysConfig', () => {
  it('lists each credential variable once', () => {
    expect(credentialNames(GTM)).toEqual(['OWNER_EMAIL', 'OWNER_PASSWORD', 'MEMBER_EMAIL', 'MEMBER_PASSWORD'])
  })

  it('loads journeys.config.mjs from the app root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'journeys-config-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'journeys.config.mjs'), `export default { app: 'tax', baseUrl: 'https://tax.example.com', identities: { member: { emailEnv: 'M_EMAIL', passwordEnv: 'M_PASSWORD', signIn: 'tangle' } } }\n`)
    const c = await loadJourneysConfig(dir, {})
    expect(c.app).toBe('tax')
    expect(c.chat.threadPath).toBeNull()
    await expect(loadJourneysConfig(join(dir, 'missing'), {})).rejects.toThrow(/no journeys.config.mjs/)
  })
})
