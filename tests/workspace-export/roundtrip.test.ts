/**
 * One export through the real routes: start, advance to completion, download
 * the zip, then check it with the system `unzip` and `tar` the way an owner
 * would. Covers the contracts that matter: every source lands, counts match the
 * database, checksums match the bytes, no credential survives anywhere, and
 * every refusal path fails closed.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import {
  createMemoryExportStorage,
  createWorkspaceExport,
  d1WorkspaceTables,
  type D1ExportDatabase,
  type ExportPrincipal,
} from '../../src/workspace-export'

const WS = 'ws-test-1'
const OTHER = 'ws-test-2'
const ANTHROPIC = `sk-ant-api03-${'A1b2C3d4'.repeat(6)}`
const GITHUB = `ghp_${'x9Y8z7W6'.repeat(5)}`
const PRODUCT_KEY = 'tangle-product-key-0123456789abcdef'
const SIGNING = 'test-signing-secret'

function d1(db: DatabaseSync): D1ExportDatabase {
  const run = (sql: string, values: unknown[]) => ({ results: db.prepare(sql).all(...(values as never[])) as never[] })
  return {
    prepare(sql) {
      return {
        bind: (...values: unknown[]) => ({ all: async () => run(sql, values) }),
        all: async () => run(sql, []),
      }
    },
  }
}

function seed(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE workspace (id TEXT PRIMARY KEY, name TEXT, config TEXT);
    CREATE TABLE workspace_member (id INTEGER PRIMARY KEY, workspace_id TEXT, user_id TEXT, role TEXT, invite_token TEXT);
    CREATE TABLE thread (id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT);
    CREATE TABLE message (id INTEGER PRIMARY KEY, thread_id TEXT, content TEXT, input_tokens INTEGER, accessToken TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, token TEXT, user_id TEXT);
    CREATE TABLE eval_global (id INTEGER PRIMARY KEY, score REAL);
  `)
  db.prepare('INSERT INTO workspace VALUES (?, ?, ?)').run(WS, 'Inn', JSON.stringify({ published: { remoteBearerToken: 'bearer-abcdefgh' }, theme: 'dark' }))
  db.prepare('INSERT INTO workspace VALUES (?, ?, ?)').run(OTHER, 'Other', '{}')
  db.prepare('INSERT INTO workspace_member (workspace_id, user_id, role, invite_token) VALUES (?, ?, ?, ?)').run(WS, 'u-owner', 'owner', 'invite-secret-1234')
  db.prepare('INSERT INTO thread VALUES (?, ?, ?)').run('t1', WS, 'Check-in')
  db.prepare('INSERT INTO thread VALUES (?, ?, ?)').run('t2', OTHER, 'Not ours')
  const insert = db.prepare('INSERT INTO message (thread_id, content, input_tokens, accessToken) VALUES (?, ?, ?, ?)')
  for (let i = 0; i < 1203; i += 1) insert.run('t1', i === 7 ? `my key is ${ANTHROPIC}` : `message ${i}`, i, i % 2 ? 'oauth-access-xyz' : null)
  insert.run('t2', 'other workspace', 1, null)
  db.prepare('INSERT INTO session VALUES (?, ?, ?)').run('s1', 'session-token-1', 'u-owner')
  return db
}

function tarGz(): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), 'wx-box-'))
  mkdirSync(join(dir, 'project'), { recursive: true })
  mkdirSync(join(dir, '.codex'), { recursive: true })
  writeFileSync(join(dir, 'project', 'notes.md'), '# Notes\nGuest list is in guests.csv\n')
  writeFileSync(join(dir, 'project', '.env'), `GITHUB_TOKEN=${GITHUB}\nPRODUCT=${PRODUCT_KEY}\nMODE=prod\n`)
  writeFileSync(join(dir, '.codex', 'auth.json'), JSON.stringify({ refresh: 'opaque-refresh-value-123' }))
  const out = join(tmpdir(), `wx-box-${Date.now()}.tar.gz`)
  execFileSync('tar', ['-czf', out, '-C', dir, '.'])
  const bytes = readFileSync(out)
  rmSync(dir, { recursive: true, force: true })
  rmSync(out, { force: true })
  return new Uint8Array(bytes)
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

const scratch = mkdtempSync(join(tmpdir(), 'wx-test-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function setup(principal: () => ExportPrincipal | null | Promise<ExportPrincipal | null>) {
  const db = seed()
  const storage = createMemoryExportStorage()
  const box = tarGz()
  const exporter = createWorkspaceExport({
    app: 'testapp',
    storage,
    signingSecret: SIGNING,
    authorize: async () => principal(),
    knownSecrets: () => [PRODUCT_KEY],
    async plan({ workspaceId }) {
      const tables = await d1WorkspaceTables({
        db: d1(db),
        workspaceId,
        workspaceColumns: ['workspace_id'],
        scoped: { workspace: 'id = ?', message: 'thread_id IN (SELECT id FROM thread WHERE workspace_id = ?)' },
        exclude: { session: 'login sessions are credentials' },
        classify: (t) => (t === 'message' || t === 'thread' ? 'conversations' : t === 'workspace_member' ? 'people' : 'records'),
        pageSize: 250,
      })
      return {
        sources: [
          ...tables.sources,
          {
            kind: 'files',
            name: 'uploads',
            dataClass: 'files',
            async *files() {
              yield { path: '/guest/../../etc/passwd-attempt.txt', open: async () => `uploaded ${PRODUCT_KEY}` }
              yield { path: 'photo.bin', open: async () => new Uint8Array([0, 1, 2, 255]) }
            },
          },
          {
            kind: 'archive',
            name: 'workspace',
            dataClass: 'sandbox',
            open: async () => new Blob([box as BlobPart]).stream() as ReadableStream<Uint8Array>,
          },
          { kind: 'archive', name: 'missing-box', dataClass: 'sandbox', open: async () => null },
          {
            kind: 'json',
            name: 'connections',
            dataClass: 'connections',
            value: async () => [{ provider: 'cloudbeds', status: 'active', accessToken: 'never-this', scopes: ['read'] }],
          },
        ],
        notes: { database: tables.coverage },
      }
    },
  })
  const url = (path: string) => `https://app.test/api/workspaces/${WS}/exports${path ? `/${path}` : ''}`
  const call = (path: string, init: RequestInit = {}) =>
    exporter.route(new Request(url(path), { ...init, headers: { Origin: 'https://app.test', ...init.headers } }), { workspaceId: WS, path })
  return { exporter, call, db }
}

describe('workspace export round trip', () => {
  const owner = () => ({ userId: 'u-owner', role: 'owner' })

  it('produces a complete, verifiable, secret-free archive', async () => {
    const { call, exporter } = setup(owner)
    const started = await call('', { method: 'POST' })
    expect(started.status).toBe(202)
    const { id } = (await started.json()) as { id: string }

    let progress: Record<string, unknown> = {}
    for (let i = 0; i < 20; i += 1) {
      progress = (await (await call(`${id}/advance`, { method: 'POST' })).json()) as Record<string, unknown>
      if (progress.status !== 'running') break
    }
    expect(progress.status).toBe('complete')
    const downloadUrl = progress.downloadUrl as string
    expect(downloadUrl).toMatch(new RegExp(`^/api/workspaces/${WS}/exports/${id}/download\\?key=`))

    const path = `${id}/download`
    const response = await exporter.route(new Request(`https://app.test${downloadUrl}`), { workspaceId: WS, path })
    expect(response.status).toBe(200)
    const zip = new Uint8Array(await response.arrayBuffer())
    expect(Number(response.headers.get('Content-Length'))).toBe(zip.length)

    const zipPath = join(scratch, 'export.zip')
    const out = join(scratch, 'out')
    writeFileSync(zipPath, zip)
    expect(execFileSync('unzip', ['-t', zipPath]).toString()).toContain('No errors detected')
    execFileSync('unzip', ['-q', zipPath, '-d', out])

    // Every file in the archive is in the manifest with a matching checksum.
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
    const listed = new Map<string, string>(manifest.files.map((f: { path: string; sha256: string }) => [f.path, f.sha256]))
    const actual = walk(out).map((p) => relative(out, p)).filter((p) => p !== 'manifest.json' && p !== 'README.txt')
    expect(actual.sort()).toEqual([...listed.keys()].sort())
    for (const file of actual) {
      expect(createHash('sha256').update(readFileSync(join(out, file))).digest('hex'), file).toBe(listed.get(file))
    }

    // Counts reconcile with the database, and only this workspace's rows are present.
    const sources = new Map<string, { rows?: number; expectedRows?: number; status: string; archive?: { files: number; blanked: string[] } }>(
      manifest.sources.map((s: { name: string }) => [s.name, s]),
    )
    expect(sources.get('db.message')).toMatchObject({ rows: 1203, expectedRows: 1203 })
    expect(sources.get('db.thread')).toMatchObject({ rows: 1, expectedRows: 1 })
    expect(sources.get('db.workspace')).toMatchObject({ rows: 1 })
    expect(sources.get('missing-box')?.status).toBe('empty')
    expect(sources.has('db.session')).toBe(false)
    const coverage = new Map(manifest.notes.database.map((c: { table: string; status: string }) => [c.table, c.status]))
    expect(coverage.get('session')).toBe('excluded')
    expect(coverage.get('eval_global')).toBe('unscoped')
    const lines = readFileSync(join(out, 'data/db.message.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(1203)
    expect(lines.every((m) => m.thread_id === 't1')).toBe(true)
    expect(lines[3].input_tokens).toBe(3)
    expect(lines[1].accessToken).toBe('[redacted]')
    expect(lines[7].content).toBe('my key is [redacted]')
    expect(manifest.classes.conversations).toContain('data/db.message.ndjson')

    // The sandbox tar extracts, keeps ordinary files, and carries no credentials.
    const box = join(scratch, 'box')
    mkdirSync(box)
    execFileSync('tar', ['-xzf', join(out, 'sandbox/workspace.tar.gz'), '-C', box])
    expect(readFileSync(join(box, 'project/notes.md'), 'utf8')).toContain('Guest list')
    expect(readFileSync(join(box, 'project/.env'), 'utf8')).toContain('MODE=prod')
    expect(readFileSync(join(box, '.codex/auth.json'), 'utf8')).toMatch(/^\*+$/)
    expect(sources.get('workspace')?.archive?.files).toBe(3)
    expect(sources.get('workspace')?.archive?.blanked).toEqual(['./.codex/auth.json'])

    // Paths cannot escape their folder; binary bytes survive.
    expect(readFileSync(join(out, 'files/uploads/guest/etc/passwd-attempt.txt'), 'utf8')).not.toContain(PRODUCT_KEY)
    expect([...readFileSync(join(out, 'files/uploads/photo.bin'))]).toEqual([0, 1, 2, 255])

    // No credential appears anywhere: archive members, extracted sandbox, or the zip bytes.
    const everything = [...walk(out), ...walk(box)].map((p) => readFileSync(p, 'latin1')).join('\n')
    for (const secret of [ANTHROPIC, GITHUB, PRODUCT_KEY, 'bearer-abcdefgh', 'invite-secret-1234', 'oauth-access-xyz', 'never-this', 'opaque-refresh-value-123', 'session-token-1']) {
      expect(everything.includes(secret), secret).toBe(false)
    }
    expect(JSON.parse(readFileSync(join(out, 'data/db.workspace.ndjson'), 'utf8')).config).toContain('"theme":"dark"')
  })

  it('refuses everyone but the owner, and fails closed', async () => {
    const member = setup(() => ({ userId: 'u-2', role: 'admin' }))
    expect((await member.call('', { method: 'POST' })).status).toBe(403)
    const stranger = setup(() => null)
    expect((await stranger.call('', { method: 'GET' })).status).toBe(403)
    const broken = setup(() => {
      throw new Error('auth db down')
    })
    expect((await broken.call('', { method: 'POST' })).status).toBe(503)
    const owned = setup(owner)
    const crossSite = await owned.call('', { method: 'POST', headers: { Origin: 'https://evil.test' } })
    expect(crossSite.status).toBe(403)
  })

  it('rejects tampered, foreign and expired download links', async () => {
    const { call, exporter } = setup(owner)
    const { id } = (await (await call('', { method: 'POST' })).json()) as { id: string }
    let progress: { status: string; downloadUrl?: string } = { status: 'running' }
    while (progress.status === 'running') progress = (await (await call(`${id}/advance`, { method: 'POST' })).json()) as typeof progress
    const link = progress.downloadUrl!
    const fetchLink = (href: string, workspaceId = WS) =>
      exporter.route(new Request(`https://app.test${href}`), { workspaceId, path: `${id}/download` })

    expect((await fetchLink(link.replace(/sig=[^&]+/, 'sig=AAAA'))).status).toBe(403)
    expect((await fetchLink(link, OTHER)).status).toBe(403)
    const exp = Number(new URL(`https://x${link}`).searchParams.get('exp'))
    expect((await fetchLink(link.replace(`exp=${exp}`, `exp=${exp + 1000}`))).status).toBe(403)
    expect((await fetchLink(link)).status).toBe(200)
  })
})

describe('large files sources', () => {
  it('continue across requests and keep every file exactly once', async () => {
    const storage = createMemoryExportStorage()
    let listings = 0
    const exporter = createWorkspaceExport({
      app: 'testapp',
      storage,
      signingSecret: SIGNING,
      authorize: async () => ({ userId: 'u-owner', role: 'owner' }),
      plan: async () => ({
        sources: [{
          kind: 'files',
          name: 'many',
          dataClass: 'files',
          async *files() {
            listings += 1
            for (let i = 0; i < 450; i += 1) yield { path: `f/${String(i).padStart(3, '0')}.txt`, open: async () => `file ${i}` }
          },
        }],
      }),
    })
    const call = (path: string, init: RequestInit = {}) =>
      exporter.route(new Request(`https://app.test/api/workspaces/${WS}/exports${path ? `/${path}` : ''}`, init), { workspaceId: WS, path })
    const { id } = (await (await call('', { method: 'POST' })).json()) as { id: string }
    let progress: { status: string; downloadUrl?: string } = { status: 'running' }
    let requests = 0
    while (progress.status === 'running' && requests < 10) {
      progress = (await (await call(`${id}/advance`, { method: 'POST' })).json()) as typeof progress
      requests += 1
    }
    expect(progress.status).toBe('complete')
    expect(requests).toBe(3)
    expect(listings).toBe(3)
    const zip = await exporter.route(new Request(`https://app.test${progress.downloadUrl}`), { workspaceId: WS, path: `${id}/download` })
    const zipPath = join(scratch, 'many.zip')
    writeFileSync(zipPath, new Uint8Array(await zip.arrayBuffer()))
    const members = execFileSync('unzip', ['-Z1', zipPath]).toString().trim().split('\n').filter((m) => m.startsWith('files/many/'))
    expect(members).toHaveLength(450)
    expect(new Set(members).size).toBe(450)
    expect(execFileSync('unzip', ['-p', zipPath, 'files/many/f/449.txt']).toString()).toBe('file 449')
  })
})
