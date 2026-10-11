import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveJourneysConfig } from '../../src/journeys/config'
import { secretNeedles } from '../../src/journeys/session'

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
