/**
 * The box↔Vault sync engine against its production dependencies: agent-app's
 * Vault coordinator in a real workerd Durable Object (Miniflare) over real KV
 * and Durable Object storage, and a box whose files, shell, `find`, `sha256sum`,
 * `stat` and `base64` are a real directory and a real bash. Each case is written
 * so that removing the mechanism it names makes it fail.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import type { KVStore } from '../../src/store'
import { createVaultStore, type VaultCoordinatorNamespace, type VaultFrontmatterCodec } from '../../src/vault/store/store'
import { createSandboxVaultSync } from '../../src/vault/store/sandbox-engine'
import { vaultBinaryDocument } from '../../src/vault/store/sandbox-sync'

const require = createRequire(import.meta.url)
const wrangler = createRequire(require.resolve('wrangler/package.json'))
const { Miniflare, convertV4MiniflareOptions } = wrangler('miniflare') as {
  convertV4MiniflareOptions(options: Record<string, unknown>): Record<string, unknown>
  Miniflare: new (options: Record<string, unknown>) => Runtime
}
interface Runtime {
  getKVNamespace(binding: string): Promise<KVStore>
  getDurableObjectNamespace(binding: string): Promise<VaultCoordinatorNamespace>
  dispose(): Promise<void>
}

/** Flat `key: value` frontmatter, the shape Creative stores. */
const codec: VaultFrontmatterCodec = {
  parse(raw) {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/)
    if (!match) return { succeeded: true, frontmatter: {}, body: raw }
    const frontmatter: Record<string, unknown> = {}
    for (const line of match[1]!.split('\n')) {
      const colon = line.indexOf(':')
      if (colon > 0) frontmatter[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
    }
    return { succeeded: true, frontmatter, body: match[2]! }
  },
  serialize(frontmatter, body) {
    return `---\n${Object.entries(frontmatter).map(([key, value]) => `${key}: ${String(value)}`).join('\n')}\n---\n\n${body}`
  },
}

const scratch = mkdtempSync(join(tmpdir(), 'agent-app-vault-sync-'))
let runtime: Runtime
let vault: ReturnType<typeof createVaultStore<VaultCoordinatorNamespace>>
let workspace = 0
let workspaceId = ''

beforeAll(async () => {
  const bundle = join(scratch, 'bundle')
  const config = join(scratch, 'wrangler.toml')
  writeFileSync(config, [
    'name = "vault-sync-fixture"',
    `main = ${JSON.stringify(resolve(dirname(fileURLToPath(import.meta.url)), 'sandbox-sync.worker.ts'))}`,
    'compatibility_date = "2026-09-01"',
    'compatibility_flags = ["nodejs_compat"]',
    '[[durable_objects.bindings]]', 'name = "VAULT_COORDINATOR"', 'class_name = "VaultCoordinatorDO"',
    '[[migrations]]', 'tag = "v1"', 'new_classes = ["VaultCoordinatorDO"]',
  ].join('\n'))
  execFileSync(process.execPath, [require.resolve('wrangler'), 'deploy', '--dry-run', '--config', config, '--outdir', bundle],
    { cwd: scratch, stdio: 'pipe' })
  runtime = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: 'vault-sync-fixture', modules: true, scriptPath: join(bundle, 'sandbox-sync.worker.js'), modulesRoot: bundle,
      compatibilityDate: '2026-09-01', compatibilityFlags: ['nodejs_compat'],
      kvNamespaces: ['VAULT_KV'], durableObjects: { VAULT_COORDINATOR: 'VaultCoordinatorDO' },
    }],
  }))
  vault = createVaultStore<VaultCoordinatorNamespace>({ codec })
  vault.setVaultKV(await runtime.getKVNamespace('VAULT_KV'))
  vault.setVaultCoordinator(await runtime.getDurableObjectNamespace('VAULT_COORDINATOR'))
}, 120_000)

afterAll(async () => {
  await runtime?.dispose()
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(() => {
  workspace += 1
  workspaceId = `ws-${workspace}`
})

/** A box over a real directory and a real bash, recording each write request's JSON size. */
function realBox(incarnation = 'incarnation-1') {
  const home = mkdtempSync(join(scratch, 'box-'))
  const root = join(home, 'vault')
  const writeRequestBytes: number[] = []
  const uploads: string[] = []
  const box = {
    id: `box-${workspace}`,
    filesystemIncarnationId: incarnation,
    filesystemIncarnationProvenance: 'fresh' as const,
    filesystemIncarnationReadiness: 'ready' as const,
    fs: {
      exists: async (path: string) => existsSync(path),
      writeMany: async (files: Array<{ path: string; content: string }>) => {
        writeRequestBytes.push(Buffer.byteLength(JSON.stringify({ files })))
        for (const file of files) {
          mkdirSync(dirname(file.path), { recursive: true })
          writeFileSync(file.path, file.content)
        }
      },
      delete: async (path: string) => rmSync(path, { recursive: true, force: true }),
      mkdir: async (path: string) => { mkdirSync(path, { recursive: true }) },
      uploadData: async (path: string, data: Uint8Array) => {
        uploads.push(path)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, data)
        return { size: data.byteLength }
      },
    },
    exec: async (command: string) => {
      const result = spawnSync('bash', ['-c', command], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
      return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
    },
    read: async (path: string) => {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path))
      } catch {
        throw Object.assign(new Error('File is not valid UTF-8; request base64 instead'), { code: 'INVALID_UTF8' })
      }
    },
  }
  return { box, root, writeRequestBytes, uploads, sync: createSandboxVaultSync({ vault, root }) }
}

it('hydrates text and binary heads byte-exact, records the baseline, and a second pass writes nothing', async () => {
  const bytes = Uint8Array.from({ length: 4096 }, (_, index) => (index * 31) % 256)
  await vault.writeVaultRawFile(workspaceId, 'notes/plan.md', '# Plan\n\nShip it.\n')
  await vault.writeVaultRawFile(workspaceId, 'media/logo.png', vaultBinaryDocument(codec, { type: 'upload' }, Buffer.from(bytes).toString('base64')))
  const { box, root, sync } = realBox()

  const first = await sync.hydrate(box, workspaceId)
  expect(first).toEqual({ succeeded: true, value: expect.objectContaining({ written: 2 }) })
  expect(readFileSync(join(root, 'notes/plan.md'), 'utf8')).toBe('# Plan\n\nShip it.\n')
  expect(new Uint8Array(readFileSync(join(root, 'media/logo.png')))).toEqual(bytes)
  const baseline = await vault.readVaultSandboxBaseline(workspaceId, box.id)
  expect(Object.keys(baseline?.files ?? {}).sort()).toEqual(['media/logo.png', 'notes/plan.md'])
  expect(baseline?.files['media/logo.png']?.binary).toBe(true)

  const second = await sync.hydrate(box, workspaceId)
  expect(second).toEqual({ succeeded: true, value: expect.objectContaining({ written: 0, unchanged: 2 }) })
}, 60_000)

it('commits box edits and new files to the Vault, and refuses a box delete that is not a rename', async () => {
  await vault.writeVaultRawFile(workspaceId, 'notes/plan.md', 'v1\n')
  await vault.writeVaultRawFile(workspaceId, 'notes/keep.md', 'keep\n')
  const { box, root, sync } = realBox()
  expect((await sync.hydrate(box, workspaceId)).succeeded).toBe(true)

  writeFileSync(join(root, 'notes/plan.md'), 'v2 from the box\n')
  writeFileSync(join(root, 'notes/new.md'), 'made in the box\n')
  rmSync(join(root, 'notes/keep.md'))
  const result = await sync.reconcile(box, workspaceId)

  expect(result.appliedPaths.sort()).toEqual(['notes/new.md', 'notes/plan.md'])
  expect(result.refusedDeletionPaths).toEqual(['notes/keep.md'])
  expect((await vault.readVaultFileState(workspaceId, 'notes/plan.md')).content).toBe('v2 from the box\n')
  expect((await vault.readVaultFileState(workspaceId, 'notes/new.md')).content).toBe('made in the box\n')
  expect((await vault.readVaultFileState(workspaceId, 'notes/keep.md')).content).toBe('keep\n')
}, 60_000)

it('parks a box edit that races a Vault edit as a conflict and keeps both copies', async () => {
  await vault.writeVaultRawFile(workspaceId, 'brief.md', 'original\n')
  const { box, root, sync } = realBox()
  expect((await sync.hydrate(box, workspaceId)).succeeded).toBe(true)

  await vault.writeVaultRawFile(workspaceId, 'brief.md', 'edited in the Vault\n')
  writeFileSync(join(root, 'brief.md'), 'edited in the box\n')
  const result = await sync.reconcile(box, workspaceId)

  expect(result.conflicts.map(conflict => conflict.path)).toEqual(['brief.md'])
  expect((await vault.readVaultFileState(workspaceId, 'brief.md')).content).toBe('edited in the Vault\n')
  const hydrated = await sync.hydrate(box, workspaceId, { conflictPaths: new Set(result.conflicts.map(conflict => conflict.path)) })
  expect(hydrated.succeeded).toBe(true)
  expect(readFileSync(join(root, 'brief.md'), 'utf8')).toBe('edited in the box\n')
}, 60_000)

it('trusts no baseline from another filesystem incarnation: a rebuilt box commits nothing until it is hydrated', async () => {
  await vault.writeVaultRawFile(workspaceId, 'brief.md', 'original\n')
  const first = realBox('incarnation-1')
  expect((await first.sync.hydrate(first.box, workspaceId)).succeeded).toBe(true)

  // Same box id, new disk: it holds a stale copy that must not overwrite the Vault.
  const rebuilt = { ...first.box, filesystemIncarnationId: 'incarnation-2' }
  writeFileSync(join(first.root, 'brief.md'), 'stale copy on the rebuilt disk\n')
  const result = await first.sync.reconcile(rebuilt, workspaceId)

  expect(result.baselineResetReason).toBe('filesystem_incarnation_changed')
  expect(result.appliedPaths).toEqual([])
  expect((await vault.readVaultFileState(workspaceId, 'brief.md')).content).toBe('original\n')
}, 60_000)

it('keeps every write request under the sandbox proxy cap and sends an oversized file as bytes', async () => {
  const medium = 'm'.repeat(300_000)
  const oversized = 'o'.repeat(1_200_000)
  for (let index = 0; index < 6; index += 1) await vault.writeVaultRawFile(workspaceId, `docs/part-${index}.md`, `${index}${medium}`)
  await vault.writeVaultRawFile(workspaceId, 'docs/huge.md', oversized)
  const { box, root, sync, writeRequestBytes, uploads } = realBox()

  expect((await sync.hydrate(box, workspaceId)).succeeded).toBe(true)

  expect(Math.max(...writeRequestBytes)).toBeLessThanOrEqual(1024 * 1024)
  expect(writeRequestBytes.length).toBeGreaterThan(1)
  expect(uploads).toEqual([join(root, 'docs/huge.md')])
  expect(readFileSync(join(root, 'docs/huge.md'), 'utf8')).toBe(oversized)
  for (let index = 0; index < 6; index += 1) expect(readFileSync(join(root, `docs/part-${index}.md`), 'utf8')).toBe(`${index}${medium}`)
}, 120_000)

it('stores a baseline larger than one Durable Object value as chunks and reads it back whole', async () => {
  // Long paths make each baseline entry large, so a few hundred files cross one value's 128 KiB.
  const stem = 'a-deliberately-long-descriptive-document-name-that-makes-each-baseline-entry-large'
  const paths = Array.from({ length: 700 }, (_, index) => `library/section-${String(index % 15).padStart(2, '0')}/${stem}-${String(index).padStart(4, '0')}.md`)
  for (let start = 0; start < paths.length; start += 90) {
    const result = await vault.commitVaultMutation({
      workspaceId, operationId: `seed-${start}`, writer: { kind: 'system', id: 'test-seed' },
      changes: paths.slice(start, start + 90).map(path => ({ path, kind: 'put' as const, content: `${path}\n`, expectedRevision: null })),
    })
    expect(result.status).toBe('applied')
  }
  const { box, sync } = realBox()

  expect((await sync.hydrate(box, workspaceId)).succeeded).toBe(true)

  const baseline = await vault.readVaultSandboxBaseline(workspaceId, box.id)
  expect(JSON.stringify(baseline).length).toBeGreaterThan(128 * 1024)
  expect(Object.keys(baseline?.files ?? {}).sort()).toEqual([...paths].sort())
  const reconciled = await sync.reconcile(box, workspaceId)
  expect(reconciled).toEqual(expect.objectContaining({ succeeded: true, complete: true, appliedPaths: [] }))
}, 600_000)
