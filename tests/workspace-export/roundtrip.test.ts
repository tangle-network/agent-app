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
  createExportEngine,
  createMemoryExportStorage,
  createWorkspaceExport,
  d1WorkspaceTables,
  sandboxArchive,
  sandboxFiles,
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
    CREATE TABLE _migrations_applied (name TEXT PRIMARY KEY, applied_at INTEGER);
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
    expect(coverage.has('_migrations_applied')).toBe(false)
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
    expect(sources.get('workspace')?.archive?.files).toBeGreaterThanOrEqual(3)
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

describe('sandboxArchive', () => {
  function fakeBox(status: string) {
    const calls: string[] = []
    const box = {
      status,
      async resume() { calls.push('resume'); box.status = 'running' },
      async stop() { calls.push('stop'); box.status = 'stopped' },
      async waitFor() { calls.push('waitFor') },
      fs: {
        async openArchive(dir: string) {
          calls.push(`open:${dir}`)
          if (box.status !== 'running') throw new Error(`Sandbox is not running (status: ${box.status})`)
          return new Blob([new Uint8Array([1, 2, 3])]).stream() as ReadableStream<Uint8Array>
        },
      },
    }
    return { box, calls }
  }

  it('resumes a stopped box, reads it, and stops it again', async () => {
    const { box, calls } = fakeBox('stopped')
    const source = sandboxArchive({ name: 'box', getBox: async () => box })
    const stream = await source.open()
    expect([...new Uint8Array(await new Response(stream).arrayBuffer())]).toEqual([1, 2, 3])
    expect(calls).toEqual(['resume', 'waitFor', 'open:.', 'stop'])
    expect(box.status).toBe('stopped')
  })

  it('reads a running box without touching its state, and skips a deleted one', async () => {
    const running = fakeBox('running')
    await new Response(await sandboxArchive({ name: 'a', getBox: async () => running.box }).open()).arrayBuffer()
    expect(running.calls).toEqual(['open:.'])
    const gone = fakeBox('deleted')
    expect(await sandboxArchive({ name: 'b', getBox: async () => gone.box }).open()).toBeNull()
    expect(await sandboxArchive({ name: 'c', getBox: async () => null }).open()).toBeNull()
  })
})

describe('many sandboxes', () => {
  it('reads several boxes at once and retries a failed box on its own', async () => {
    let inFlight = 0
    let peak = 0
    let flaky = 0
    const box = tarGz()
    const exporter = createWorkspaceExport({
      app: 'testapp',
      storage: createMemoryExportStorage(),
      signingSecret: SIGNING,
      authorize: async () => ({ userId: 'u-owner', role: 'owner' }),
      archiveConcurrency: 3,
      plan: async () => ({
        sources: Array.from({ length: 7 }, (_, i) => ({
          kind: 'archive' as const,
          name: `box-${i}`,
          dataClass: 'sandbox' as const,
          async open() {
            inFlight += 1
            peak = Math.max(peak, inFlight)
            // Each box waits on its runtime before streaming, as a resume does.
            await new Promise((resolve) => setTimeout(resolve, 20))
            inFlight -= 1
            if (i === 1 && flaky++ === 0) throw new Error('box was still starting')
            return new Blob([box as BlobPart]).stream() as ReadableStream<Uint8Array>
          },
        })),
      }),
    })
    const call = (path: string, init: RequestInit = {}) =>
      exporter.route(new Request(`https://app.test/api/workspaces/${WS}/exports${path ? `/${path}` : ''}`, init), { workspaceId: WS, path })
    const { id } = (await (await call('', { method: 'POST' })).json()) as { id: string }
    let progress: { status: string; units: { name: string; status: string }[] } = { status: 'running', units: [] }
    let requests = 0
    while (progress.status === 'running' && requests < 10) {
      progress = (await (await call(`${id}/advance`, { method: 'POST' })).json()) as typeof progress
      requests += 1
    }
    expect(progress.status).toBe('complete')
    expect(progress.units.every((u) => u.status === 'done')).toBe(true)
    expect(peak).toBe(3)
    // Request 1 fails box-1 inside the first batch and keeps boxes 0 and 2;
    // request 2 retries box-1 alone, then runs the rest three at a time.
    expect(flaky).toBe(2)
    expect(requests).toBe(2)
  })
})

describe('many tables', () => {
  it('writes several table sources at once and keeps each one exact', async () => {
    let inFlight = 0
    let peak = 0
    const exporter = createWorkspaceExport({
      app: 'testapp',
      storage: createMemoryExportStorage(),
      signingSecret: SIGNING,
      authorize: async () => ({ userId: 'u-owner', role: 'owner' }),
      rowConcurrency: 5,
      plan: async () => ({
        sources: Array.from({ length: 12 }, (_, i) => ({
          kind: 'rows' as const,
          name: `db.t${i}`,
          dataClass: 'records' as const,
          expectedCount: async () => i % 3,
          async *rows() {
            inFlight += 1
            peak = Math.max(peak, inFlight)
            // Each table waits on its database round trip, as D1 does.
            await new Promise((resolve) => setTimeout(resolve, 20))
            inFlight -= 1
            yield Array.from({ length: i % 3 }, (_, n) => ({ id: `${i}-${n}` }))
          },
        })),
      }),
    })
    const call = (path: string, init: RequestInit = {}) =>
      exporter.route(new Request(`https://app.test/api/workspaces/${WS}/exports${path ? `/${path}` : ''}`, init), { workspaceId: WS, path })
    const { id } = (await (await call('', { method: 'POST' })).json()) as { id: string }
    const progress = (await (await call(`${id}/advance`, { method: 'POST' })).json()) as {
      status: string
      units: { name: string; status: string; rows?: number }[]
    }
    expect(progress.status).toBe('complete')
    expect(peak).toBe(5)
    expect(progress.units.map((u) => u.rows)).toEqual(Array.from({ length: 12 }, (_, i) => i % 3))
  })
})

describe('job lease', () => {
  it('lets the next request continue a minute after a request died holding it', async () => {
    let clock = Date.parse('2026-10-11T00:00:00Z')
    const storage = createMemoryExportStorage()
    const engine = createExportEngine({
      app: 'testapp',
      storage,
      now: () => clock,
      plan: async () => ({
        sources: [{
          kind: 'json',
          name: 'doc',
          dataClass: 'records',
          value: async () => {
            // The lease the engine stores while this unit runs.
            const running = JSON.parse(new TextDecoder().decode(storage.objects.get(`workspace-exports/${WS}/${job.id}/job.json`)!))
            leaseWhileRunning = running.lease.until - clock
            return { ok: true }
          },
        }],
      }),
    })
    let leaseWhileRunning = Number.POSITIVE_INFINITY
    const job = await engine.start(WS, 'u-owner')
    // A request that died mid-unit leaves its lease behind.
    const key = `workspace-exports/${WS}/${job.id}/job.json`
    const stored = JSON.parse(new TextDecoder().decode(storage.objects.get(key)!))
    stored.lease = { id: 'dead-request', until: clock + 60_000 }
    await storage.put(key, new TextEncoder().encode(JSON.stringify(stored)))

    clock += 30_000
    expect((await engine.advance(WS, job.id))!.status).toBe('running')
    clock += 31_000
    expect((await engine.advance(WS, job.id))!.status).toBe('complete')
    expect(leaseWhileRunning).toBeLessThanOrEqual(60_000)
  })

  it('hands the lease back when a request fails outside a unit, so a retry continues at once', async () => {
    const clock = Date.parse('2026-10-11T00:00:00Z')
    const storage = createMemoryExportStorage()
    let planCalls = 0
    const engine = createExportEngine({
      app: 'testapp',
      storage,
      now: () => clock,
      plan: async () => {
        planCalls += 1
        // Every advance plans again; the second one meets a transient database error.
        if (planCalls === 2) throw new Error('D1_ERROR: Network connection lost.')
        return { sources: [{ kind: 'json', name: 'doc', dataClass: 'records', value: async () => ({ ok: true }) }] }
      },
    })
    const job = await engine.start(WS, 'u-owner')
    await expect(engine.advance(WS, job.id)).rejects.toThrow('Network connection lost')
    const stored = JSON.parse(new TextDecoder().decode(storage.objects.get(`workspace-exports/${WS}/${job.id}/job.json`)!))
    expect(stored.lease).toBeUndefined()
    // Same instant: no lease to wait out.
    expect((await engine.advance(WS, job.id))!.status).toBe('complete')
  })
})

describe('background continuation', () => {
  it('finishes an export with nobody driving it, then forgets it', async () => {
    const storage = createMemoryExportStorage()
    const engine = createExportEngine({
      app: 'testapp',
      storage,
      plan: async () => ({
        sources: [
          { kind: 'json', name: 'a', dataClass: 'records', value: async () => ({ a: 1 }) },
          { kind: 'json', name: 'b', dataClass: 'records', value: async () => ({ b: 2 }) },
        ],
      }),
    })
    const job = await engine.start(WS, 'u-owner')
    // The owner closed the tab right after clicking Export; only the cron runs.
    for (let i = 0; i < 5 && (await engine.get(WS, job.id))!.status === 'running'; i += 1) await engine.continueRunning()
    expect((await engine.get(WS, job.id))!.status).toBe('complete')
    expect([...storage.objects.keys()].some((k) => k.includes('/_running/'))).toBe(false)
    expect(await engine.continueRunning()).toBe(0)
  })
})

describe('background continuation of older exports', () => {
  it('indexes an unindexed running export when a request touches it, so the sweep finishes it', async () => {
    const storage = createMemoryExportStorage()
    const engine = createExportEngine({
      app: 'testapp',
      storage,
      plan: async () => ({
        sources: Array.from({ length: 3 }, (_, i) => ({ kind: 'json' as const, name: `d${i}`, dataClass: 'records' as const, value: async () => ({ i }) })),
      }),
    })
    const job = await engine.start(WS, 'u-owner')
    // An export started before the index existed has no index entry.
    for (const key of [...storage.objects.keys()]) if (key.includes('/_running/')) storage.objects.delete(key)
    expect(await engine.continueRunning()).toBe(0)
    // The owner reopens the panel once; one advance runs, then the tab closes.
    await engine.advance(WS, job.id, 0)
    for (let i = 0; i < 5 && (await engine.get(WS, job.id))!.status === 'running'; i += 1) await engine.continueRunning()
    expect((await engine.get(WS, job.id))!.status).toBe('complete')
  })
})

describe('a source removed while the export runs', () => {
  it('becomes an empty unit with the reason, and the export still completes', async () => {
    let boxes = ['box-a', 'box-b']
    const engine = createExportEngine({
      app: 'testapp',
      storage: createMemoryExportStorage(),
      plan: async () => ({
        sources: [
          { kind: 'json', name: 'doc', dataClass: 'records', value: async () => ({ ok: true }) },
          ...boxes.map((name) => ({ kind: 'json' as const, name, dataClass: 'sandbox' as const, value: async () => ({ name }) })),
        ],
      }),
    })
    const job = await engine.start(WS, 'u-owner')
    boxes = ['box-a'] // box-b is deleted after the export started
    let current = job
    for (let i = 0; i < 5 && current.status === 'running'; i += 1) current = (await engine.advance(WS, job.id))!
    expect(current.status).toBe('complete')
    const removed = current.units.find((u) => u.name === 'box-b')!
    expect(removed).toMatchObject({ status: 'empty', error: 'removed from the workspace while the export ran' })
  })
})

describe('files sources', () => {
  it('copy files concurrently and keep each exactly once, in listing order', async () => {
    const storage = createMemoryExportStorage()
    let activeReads = 0
    let peakReads = 0
    let releaseFirstChunk!: () => void
    const firstChunkOpen = new Promise<void>((resolve) => { releaseFirstChunk = resolve })
    const engine = createExportEngine({
      app: 'testapp',
      storage,
      plan: async () => ({
        sources: [{
          kind: 'files',
          name: 'vault',
          dataClass: 'knowledge',
          async *files() {
            for (let i = 0; i < 40; i += 1) {
              yield { path: `n/${String(i).padStart(2, '0')}.md`, open: async () => {
                activeReads += 1
                peakReads = Math.max(peakReads, activeReads)
                if (peakReads === 4) releaseFirstChunk()
                if (i < 4) await firstChunkOpen
                activeReads -= 1
                return `note ${i}`
              } }
            }
          },
        }],
      }),
    })
    const job = await engine.start(WS, 'u-owner')
    let current = job
    for (let i = 0; i < 5 && current.status === 'running'; i += 1) current = (await engine.advance(WS, job.id))!
    expect(current.status).toBe('complete')
    const unit = current.units.find((u) => u.name === 'vault')!
    expect(unit.entries.map((e) => e.path)).toEqual(Array.from({ length: 40 }, (_, i) => `files/vault/n/${String(i).padStart(2, '0')}.md`))
    expect(peakReads).toBe(4)
  })
})

describe('an export an owner can read', () => {
  // Hospitality J5, 2026-10-11: 1 of 3 exports failed on a busy sandbox while the
  // bar read 93 of 93; the zip was 42.6 MB of node_modules and empty tables,
  // with knowledge only as content hashes.
  function boxWithPackages(): Uint8Array {
    const dir = mkdtempSync(join(tmpdir(), 'wx-pkg-'))
    mkdirSync(join(dir, 'notes'), { recursive: true })
    mkdirSync(join(dir, '.opencode/node_modules/left-pad'), { recursive: true })
    mkdirSync(join(dir, '.sidecar/state'), { recursive: true })
    writeFileSync(join(dir, 'notes', 'plan.md'), '# Plan\n')
    writeFileSync(join(dir, '.opencode/node_modules/left-pad', `${'deep-name-'.repeat(12)}.js`), 'x'.repeat(5000))
    writeFileSync(join(dir, '.sidecar/state', 'run.json'), '{}')
    const out = join(tmpdir(), `wx-pkg-${Date.now()}.tar.gz`)
    execFileSync('tar', process.platform === 'darwin' ? ['-czf', out, '-C', dir, '.'] : ['--format=gnu', '-czf', out, '-C', dir, '.'])
    const bytes = new Uint8Array(readFileSync(out))
    rmSync(dir, { recursive: true, force: true })
    rmSync(out, { force: true })
    return bytes
  }

  it('drops packages, writes spreadsheets and named documents, and skips empty tables', async () => {
    const tar = boxWithPackages()
    const vault = {
      status: 'stopped',
      async resume() { vault.status = 'running' },
      async stop() { vault.status = 'stopped' },
      async waitFor() {},
      fs: {
        async openArchive() { return new Blob([tar as BlobPart]).stream() as ReadableStream<Uint8Array> },
        async read(path: string) { return path === '.vault/objects/abc/1' ? '# House rules\nQuiet after 10pm\n' : 'missing' },
      },
    }
    const exporter = createWorkspaceExport({
      app: 'testapp',
      storage: createMemoryExportStorage(),
      signingSecret: SIGNING,
      authorize: async () => ({ userId: 'u-owner', role: 'owner' }),
      plan: async () => ({
        sources: [
          {
            kind: 'rows', name: 'tasks', dataClass: 'records', format: 'csv', columns: ['title', 'due', 'notes'],
            async *rows() { yield [{ title: 'Restock, towels', due: '2026-10-12', notes: '=HYPERLINK("x")' }, { title: 'Say "hi"', due: null, notes: { a: 1 } }] },
          },
          { kind: 'rows', name: 'db.empty_table', dataClass: 'records', async *rows() { yield [] } },
          sandboxArchive({ name: 'box', getBox: async () => vault }),
          sandboxFiles({ name: 'knowledge', getBox: async () => vault, list: async () => [{ path: 'house-rules.md', boxPath: '.vault/objects/abc/1' }] }),
        ],
      }),
    })
    const call = (path: string, init: RequestInit = {}) =>
      exporter.route(new Request(`https://app.test/api/workspaces/${WS}/exports${path ? `/${path}` : ''}`, init), { workspaceId: WS, path })
    const { id } = (await (await call('', { method: 'POST' })).json()) as { id: string }
    let progress: { status: string; downloadUrl?: string } = { status: 'running' }
    for (let i = 0; i < 5 && progress.status === 'running'; i += 1) progress = (await (await call(`${id}/advance`, { method: 'POST' })).json()) as typeof progress
    expect(progress.status).toBe('complete')
    const zip = new Uint8Array(await (await exporter.route(new Request(`https://app.test${progress.downloadUrl}`), { workspaceId: WS, path: `${id}/download` })).arrayBuffer())
    const zipPath = join(scratch, 'readable.zip')
    writeFileSync(zipPath, zip)
    const members = execFileSync('unzip', ['-Z1', zipPath]).toString().trim().split('\n').sort()
    expect(members).toEqual(['README.txt', 'files/knowledge/house-rules.md', 'manifest.json', 'sandbox/box.tar.gz', 'spreadsheets/tasks.csv'])
    expect(execFileSync('unzip', ['-p', zipPath, 'files/knowledge/house-rules.md']).toString()).toContain('Quiet after 10pm')
    expect(execFileSync('unzip', ['-p', zipPath, 'spreadsheets/tasks.csv']).toString()).toBe(
      'title,due,notes\r\n"Restock, towels",2026-10-12,"\'=HYPERLINK(""x"")"\r\n"Say ""hi""",,"{""a"":1}"\r\n',
    )
    const box = join(scratch, 'readable-box')
    mkdirSync(box)
    const tarPath = join(scratch, 'readable-box.tar.gz')
    writeFileSync(tarPath, execFileSync('unzip', ['-p', zipPath, 'sandbox/box.tar.gz']))
    expect(execFileSync('tar', ['-tzf', tarPath]).toString().split('\n').filter((m) => /node_modules|sidecar/.test(m))).toEqual([])
    execFileSync('tar', ['-xzf', tarPath, '-C', box])
    expect(readFileSync(join(box, 'notes/plan.md'), 'utf8')).toBe('# Plan\n')
    const readme = execFileSync('unzip', ['-p', zipPath, 'README.txt']).toString()
    expect(readme).toContain('spreadsheets/ 1 file')
    expect(readme).not.toContain('data/')
    expect(readme).toContain('1 source was empty')
    expect(vault.status).toBe('stopped')
  })

  it('waits out a busy or failed-to-start sandbox without spending attempts, and never counts a failed source as done', async () => {
    // Two lifecycle refusals, then two platform resume failures (HTTP 500, 2026-10-12:
    // "Project sidecar could not be reprovisioned for resume"), then the box starts.
    let refusals = 4
    let clock = 1_000_000
    const box = {
      status: 'stopped',
      async resume() {
        refusals -= 1
        if (refusals >= 2) throw Object.assign(new Error('A sandbox lifecycle operation is already in progress'), { status: 409, code: 'SANDBOX_LIFECYCLE_IN_PROGRESS' })
        if (refusals >= 0) throw Object.assign(new Error('Failed to resume project'), { status: 500 })
        box.status = 'running'
      },
      async stop() { box.status = 'stopped' },
      async waitFor() {},
      fs: { async openArchive() { return new Blob([boxWithPackages() as BlobPart]).stream() as ReadableStream<Uint8Array> } },
    }
    const engine = createExportEngine({
      app: 'testapp',
      storage: createMemoryExportStorage(),
      now: () => clock,
      plan: async () => ({
        sources: [
          sandboxArchive({ name: 'busy', getBox: async () => box }),
          { kind: 'json', name: 'settings', dataClass: 'workspace', value: async () => ({ ok: true }) },
        ],
      }),
    })
    const job = await engine.start(WS, 'u-owner')
    let current = (await engine.advance(WS, job.id))!
    // A deferred source waits its turn: an immediate retry does not touch the box.
    const triesAfterFirst = refusals
    current = (await engine.advance(WS, job.id))!
    expect(refusals).toBe(triesAfterFirst)
    for (let i = 0; i < 8 && current.status === 'running'; i += 1) {
      clock += 31_000
      current = (await engine.advance(WS, job.id))!
    }
    expect(current.status).toBe('complete')
    const unit = current.units.find((u) => u.name === 'busy')!
    expect(unit).toMatchObject({ status: 'done', deferrals: 4, attempts: 1 })

    const broken = createExportEngine({
      app: 'testapp',
      storage: createMemoryExportStorage(),
      plan: async () => ({
        sources: [
          { kind: 'json', name: 'a', dataClass: 'workspace', value: async () => ({}) },
          { kind: 'archive', name: 'b', dataClass: 'sandbox', open: async () => { throw new Error('disk gone') } },
        ],
      }),
    })
    const failing = await broken.start(WS, 'u-owner')
    let failed = failing
    for (let i = 0; i < 6 && failed.status === 'running'; i += 1) failed = (await broken.advance(WS, failing.id))!
    expect(failed.status).toBe('failed')
    expect(broken.progress(failed)).toMatchObject({ unitsTotal: 2, unitsDone: 1, unitsFailed: 1 })
  })
})
