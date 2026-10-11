import { mkdirSync, mkdtempSync, openSync, closeSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertNoSecrets, replaceNeedles, scrubJsonl, scrubTrace } from '../../src/journeys/scrub'
import { createZipWriter, inflateEntry, readCentralDirectory, readRaw } from '../../src/journeys/trace-zip'

const PASSWORD = 'correct-horse-battery-staple'
const COOKIE = 'sess_9f8e7d6c5b4a39281706f5e4d3c2b1a0'
const EMAIL = 'smoke@example.com'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'journeys-scrub-'))
  dirs.push(d)
  return d
}

function readZip(path: string): Map<string, string> {
  const fd = openSync(path, 'r')
  try {
    return new Map(readCentralDirectory(fd).map((e) => [e.name, inflateEntry(e, readRaw(fd, e)).toString('utf8')]))
  } finally {
    closeSync(fd)
  }
}

/** A trace shaped like Playwright's: events, network log, and stored bodies under resources/. */
function writeTrace(path: string, opts: { forceZip64?: boolean } = {}): void {
  const events = [
    { type: 'resource-snapshot', snapshot: {
      request: { url: 'https://app.example.com/api/auth/get-session', headers: [{ name: 'Cookie', value: `__Secure-session=${COOKIE}` }], cookies: [{ name: 's', value: COOKIE }] },
      response: { headers: [{ name: 'set-cookie', value: `__Secure-session=${COOKIE}` }], content: { _sha1: 'session-body.json' } },
    } },
    { type: 'resource-snapshot', snapshot: {
      request: { url: 'https://app.example.com/app/ws?token=abc123def&x=1', headers: [{ name: 'accept', value: 'text/html' }], queryString: [{ name: 'token', value: 'abc123def' }] },
      response: { headers: [], content: { _sha1: 'page.html' } },
    } },
    { type: 'context-options', options: { storageState: { cookies: [{ value: COOKIE }] } } },
  ]
  const w = createZipWriter(path, opts)
  w.add('trace.trace', Buffer.from(events.map((e) => JSON.stringify(e)).join('\n')))
  w.add('trace.network', Buffer.from(`not json ?access_token=zzz999 tail\n`))
  w.add('resources/session-body.json', Buffer.from(JSON.stringify({ user: { email: EMAIL }, session: { token: COOKIE } })))
  w.add('resources/page.html', Buffer.from(`<p>Signed in as ${EMAIL}</p>`))
  w.add('resources/frame.jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))
  w.close()
}

describe('scrubTrace', () => {
  it('removes cookies, tokens, auth bodies and needles, and copies untouched entries as stored', () => {
    const dir = tempDir()
    const raw = join(dir, 'raw.zip')
    writeTrace(raw)
    const clean = join(dir, 'out', 'clean.zip')
    mkdirSync(join(dir, 'out'))
    const result = scrubTrace(raw, clean, [PASSWORD, COOKIE, EMAIL])
    expect(result).toEqual({ entries: 5, dropped: 1, rewritten: 3 })

    const entries = readZip(clean)
    expect([...entries.keys()]).toEqual(['trace.trace', 'trace.network', 'resources/page.html', 'resources/frame.jpeg'])
    const trace = entries.get('trace.trace')!
    expect(trace).not.toContain(COOKIE)
    expect(trace).not.toContain('abc123def')
    expect(trace).toContain('"storageState":null')
    expect(entries.get('trace.network')).toBe('not json ?access_token=REDACTED tail\n')
    expect(entries.get('resources/page.html')).toBe('<p>Signed in as REDACTED</p>')
    expect(assertNoSecrets(join(dir, 'out'), { hard: [PASSWORD, COOKIE], soft: [EMAIL] }).softHits).toEqual([])
    expect(() => assertNoSecrets(dir, { hard: [COOKIE], soft: [] })).toThrow(/REFUSING: secret material found in .*raw\.zip/)
  })

  it('reads and writes zip64 records, which an hour-long trace needs', () => {
    const dir = tempDir()
    const raw = join(dir, 'raw64.zip')
    writeTrace(raw, { forceZip64: true })
    const entries = readZip(raw)
    expect(entries.get('resources/page.html')).toBe(`<p>Signed in as ${EMAIL}</p>`)
    const clean = join(dir, 'clean64.zip')
    expect(scrubTrace(raw, clean, [COOKIE, EMAIL]).dropped).toBe(1)
    expect(readZip(clean).get('resources/page.html')).toBe('<p>Signed in as REDACTED</p>')
  })
})

describe('scrubJsonl and replaceNeedles', () => {
  it('drops the stored body of a sensitive call and blanks sensitive header keys', () => {
    const drop = new Set<string>()
    const out = scrubJsonl(JSON.stringify({ request: { url: 'https://x/oauth/callback?code=secretcode', postData: { text: 'p=1' } }, response: { content: { _file: 'resources/a.dat' } }, authorization: 'Bearer t' }), drop)
    expect([...drop]).toEqual(['a.dat'])
    expect(out).toContain('"text":"REDACTED"')
    expect(out).toContain('"authorization":"REDACTED"')
    expect(out).toContain('code=REDACTED')
  })

  it('replaces every occurrence and returns the same buffer when nothing matched', () => {
    const b = Buffer.from('a-NEEDLE-b-NEEDLE')
    expect(replaceNeedles(b, ['NEEDLE']).toString()).toBe('a-REDACTED-b-REDACTED')
    expect(replaceNeedles(b, ['absent'])).toBe(b)
  })
})
