import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  checkDependencySources,
  checkInstalledIntegrity,
  classifyDependencySpecifier,
  describeDependencySourceFinding,
  formatDependencySourceReport,
  resolveLocalPathSource,
} from './dependency-source'
import { parsePeerCheckArgs } from './cli'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Same convention as `check.test.ts`: the fixture trees are COMMITTED and their
 * module directory is `fixture_modules`, because every repo gitignores
 * `node_modules` — a fixture using that name could not be committed, and a
 * calibration proof that is not committed is a proof that stops running.
 */
const MODULES = 'fixture_modules'
const vendoredTarball = join(here, 'fixtures', 'vendored-tarball')
const inRepoSource = join(here, 'fixtures', 'in-repo-source')

describe('classifyDependencySpecifier', () => {
  it('reads the registry forms as reproducible', () => {
    for (const spec of ['^0.45.35', '0.45.35', '>=0.42.1 <0.44.0', 'latest', 'npm:@scope/other@^1.0.0', '*']) {
      expect(classifyDependencySpecifier(spec)).toBe('registry')
    }
  })

  it('separates a local DIRECTORY from a local TARBALL, because only one is reviewable', () => {
    expect(classifyDependencySpecifier('file:..')).toBe('file')
    expect(classifyDependencySpecifier('link:../../packages/toolkit')).toBe('link')
    expect(classifyDependencySpecifier('portal:./packages/toolkit')).toBe('portal')
    // The insurance pin, verbatim.
    expect(classifyDependencySpecifier('file:./vendor/agent-app/tangle-network-agent-app-0.45.33.tgz'))
      .toBe('tarball')
    expect(classifyDependencySpecifier('link:./vendor/pkg.tar.gz')).toBe('tarball')
  })

  it('reads git and remote forms', () => {
    expect(classifyDependencySpecifier('git+https://github.com/o/r.git#abc')).toBe('git')
    expect(classifyDependencySpecifier('github:owner/repo')).toBe('git')
    expect(classifyDependencySpecifier('owner/repo#v1')).toBe('git')
    expect(classifyDependencySpecifier('https://example.com/pkg-1.0.0.tgz')).toBe('tarball')
    expect(classifyDependencySpecifier('https://example.com/feed')).toBe('remote')
  })

  it('does not mistake a scoped package range for github shorthand', () => {
    // `@scope/name` contains a slash exactly like `owner/repo` does. Getting
    // this wrong flags every scoped dependency in the fleet.
    expect(classifyDependencySpecifier('@tangle-network/agent-app')).toBe('registry')
  })

  it('treats workspace and catalog indirection as reproducible', () => {
    expect(classifyDependencySpecifier('workspace:*')).toBe('workspace')
    expect(classifyDependencySpecifier('catalog:')).toBe('catalog')
  })
})

describe('the legitimate exception is a RULE, not a path allowlist', () => {
  // agent-app's own playground declares `"@tangle-network/agent-app": "file:.."`
  // and that is correct. The property is not the path — it is that the
  // dependency is satisfied by in-repo SOURCE a reviewer sees in the diff.
  it('exempts an in-repo directory whose package.json names the dependency', () => {
    expect(resolveLocalPathSource({
      fromDir: join(inRepoSource, 'playground'),
      repoDir: inRepoSource,
      path: '..',
      name: '@tangle-network/agent-app',
    })).toBe('in-repo-source')
  })

  it('refuses the same shape pointed OUTSIDE the repository', () => {
    expect(resolveLocalPathSource({
      fromDir: join(inRepoSource, 'playground'),
      repoDir: join(inRepoSource, 'playground'),
      path: '..',
      name: '@tangle-network/agent-app',
    })).toBe('outside-repo')
  })

  it('refuses an in-repo directory that declares a different package', () => {
    expect(resolveLocalPathSource({
      fromDir: inRepoSource,
      repoDir: inRepoSource,
      path: './packages/shared-toolkit',
      name: '@tangle-network/agent-app',
    })).toBe('name-mismatch')
  })

  it('refuses a tarball, wherever it sits — opaque bytes are never in-repo source', () => {
    expect(resolveLocalPathSource({
      fromDir: vendoredTarball,
      repoDir: vendoredTarball,
      path: './vendor/agent-app/tangle-network-agent-app-0.45.33.tgz',
      name: '@tangle-network/agent-app',
    })).toBe('not-a-directory')
  })
})

describe('checkDependencySources — the insurance-agent shape', () => {
  // CALIBRATION. This fixture is insurance-agent's real defect, copied from the
  // commit that removed it (`insurance-agent` f7d0f51): the `pnpm-workspace.yaml`
  // override, the lockfile's three shapes, the committed 2.6 MB pack, and the
  // virtual-store directory it installed as.
  it('rejects the tree that installed cleanly, typechecked green and passed its gate', () => {
    const report = checkDependencySources({ repoDir: vendoredTarball, modulesDir: MODULES })
    expect(report.ok).toBe(false)
  })

  // THE POINT OF THE WHOLE MODULE. `package.json` read
  // `"@tangle-network/agent-app": "^0.45.33"` throughout — an ordinary registry
  // range. A checker that reads only the root manifest's dependencies sees a
  // clean repo. The override lane is the one that shipped.
  it('finds nothing in the manifest and everything in the override lane', () => {
    const report = checkDependencySources({ repoDir: vendoredTarball, modulesDir: MODULES })
    expect(report.findings.filter((f) => f.check === 'declared')).toEqual([])
    const override = report.findings.find((f) => f.check === 'override')
    expect(override).toMatchObject({
      name: '@tangle-network/agent-app',
      specifier: 'file:./vendor/agent-app/tangle-network-agent-app-0.45.33.tgz',
      protocol: 'tarball',
    })
    expect(override?.where).toContain('pnpm-workspace.yaml')
  })

  it('catches it independently in the lockfile, which is what actually resolved', () => {
    const report = checkDependencySources({ repoDir: vendoredTarball, modulesDir: MODULES })
    const lockfile = report.findings.filter((f) => f.check === 'lockfile')
    expect(lockfile.length).toBeGreaterThan(0)
    expect(lockfile.every((f) => f.name === '@tangle-network/agent-app')).toBe(true)
  })

  it('catches the committed pack itself, even with nothing pointing at it', () => {
    const report = checkDependencySources({ repoDir: vendoredTarball, modulesDir: MODULES })
    const tarball = report.findings.find((f) => f.check === 'vendored-tarball')
    expect(tarball?.where).toBe('vendor/agent-app/tangle-network-agent-app-0.45.33.tgz')
  })

  it('catches it in the INSTALLED tree, which survives a tidied manifest', () => {
    // The install evidence is COMMITTED, and it has to be checked directly:
    // pnpm's virtual store nests a second module directory inside the first, so
    // hardcoding `node_modules` for that level put this file behind the
    // gitignore rule the `fixture_modules` convention exists to dodge — the
    // fixture would vanish on a fresh clone and the scan below would quietly
    // degrade to naming a path instead of a package.
    expect(existsSync(join(
      vendoredTarball,
      MODULES, '.pnpm', 'file+vendor+agent-app+tangle-network-agent-app-0.45.33.tgz',
      MODULES, '@tangle-network', 'agent-app', 'package.json',
    ))).toBe(true)

    const report = checkDependencySources({ repoDir: vendoredTarball, modulesDir: MODULES })
    const installed = report.findings.find(
      (f) => f.check === 'installed' && f.where.includes('.pnpm'),
    )
    expect(installed).toMatchObject({ name: '@tangle-network/agent-app', protocol: 'tarball' })
  })

  it('names the fix rather than the symptom', () => {
    const report = checkDependencySources({ repoDir: vendoredTarball, modulesDir: MODULES })
    const message = describeDependencySourceFinding(report.findings[0]!)
    expect(message).toContain('DEPENDENCY SOURCE')
    expect(message).toContain('Publish the change and pin the published range')
  })

  it('renders a report that names the tarball and its location', () => {
    const text = formatDependencySourceReport(
      checkDependencySources({ repoDir: vendoredTarball, modulesDir: MODULES }),
    )
    expect(text).toContain('FAIL')
    expect(text).toContain('tangle-network-agent-app-0.45.33.tgz')
    expect(text).toContain('OVERRIDE')
  })

  it('can be silenced only by naming the path, never by accident', () => {
    const report = checkDependencySources({
      repoDir: vendoredTarball,
      modulesDir: MODULES,
      exclude: ['vendor'],
    })
    // The committed pack is gone from the walk — and the override, the lockfile
    // and the installed tree still fail, because excluding a directory is not a
    // way to approve a dependency.
    expect(report.findings.some((f) => f.check === 'vendored-tarball')).toBe(false)
    expect(report.ok).toBe(false)
  })
})

describe('checkDependencySources — the legitimate shapes stay quiet', () => {
  it('passes a repo whose local specifiers are all in-repo source', () => {
    const report = checkDependencySources({ repoDir: inRepoSource, modulesDir: MODULES })
    expect(report.findings).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.manifestsScanned).toBe(3)
  })
})

describe('this repository audits itself', () => {
  // The gate agent-app publishes must be one agent-app passes. `fixtures/` is
  // excluded by NAME and for a stated reason: those trees exist to CONTAIN the
  // violation, and a calibration tree that also had to be clean could not
  // calibrate anything.
  it('declares no dependency whose source is not the registry', () => {
    const root = join(here, '..', '..')
    const report = checkDependencySources({
      repoDir: root,
      exclude: ['src/peer-floors/fixtures'],
    })
    expect(report.findings.map((f) => `${f.check} ${f.where}`)).toEqual([])
  })

  // The playground's `file:..` is the exception's reference shape, and it must
  // pass through the REAL scan, not only the unit rule above.
  it('accepts the playground pointing at its own parent package', () => {
    const root = join(here, '..', '..')
    // The real declaration, resolved against the real tree — not a restatement
    // of the fixture. This is the exception's reference shape.
    expect(resolveLocalPathSource({
      fromDir: join(root, 'playground'),
      repoDir: root,
      path: '..',
      name: '@tangle-network/agent-app',
    })).toBe('in-repo-source')
    const report = checkDependencySources({ repoDir: root, exclude: ['src/peer-floors/fixtures'] })
    expect(report.findings.some((f) => f.where.startsWith('playground/'))).toBe(false)
  })
})

describe('installed integrity — what the store-CAS basis can and cannot see', () => {
  const PACKAGE_FILES = {
    'package.json': '{ "name": "@tangle-network/agent-app", "version": "0.45.29" }',
    'dist/index.js': 'export const a = 1\n',
    'dist/spend/index.d.ts': 'export declare const reconcileSpend: unknown\n',
  } as const

  /**
   * A pnpm-shaped tree: a content-addressed store (`<store>/files/<2>/<rest>`
   * of each file's sha512), a `.modules.yaml` naming it, and an installed
   * package hard-linked out of it. `link` false writes copies instead, which is
   * what `packageImportMethod=copy` and a cross-filesystem store produce.
   */
  async function makeTree(options: { link: boolean } = { link: true }): Promise<{ root: string; packageDir: string; store: string }> {
    const root = await mkdtemp(join(tmpdir(), 'dep-source-integrity-'))
    const store = join(root, 'store', 'v11')
    const packageDir = join(root, MODULES, '.pnpm', '@tangle-network+agent-app@0.45.29', MODULES, '@tangle-network', 'agent-app')
    mkdirSync(join(packageDir, 'dist', 'spend'), { recursive: true })
    mkdirSync(join(root, MODULES), { recursive: true })
    writeFileSync(join(root, MODULES, '.modules.yaml'), `{ "storeDir": ${JSON.stringify(store)} }`)
    for (const [name, body] of Object.entries(PACKAGE_FILES)) {
      const stored = storeBlob(store, body)
      const installed = join(packageDir, name)
      if (options.link) linkSync(stored, installed)
      else writeFileSync(installed, body)
    }
    return { root, packageDir, store }
  }

  /** Write `body` into a store at its content address and return the path. */
  function storeBlob(store: string, body: string): string {
    const hex = createHash('sha512').update(body).digest('hex')
    const dir = join(store, 'files', hex.slice(0, 2))
    mkdirSync(dir, { recursive: true })
    const path = join(dir, hex.slice(2))
    writeFileSync(path, body)
    return path
  }

  it('verifies a clean install and finds nothing', async () => {
    const { root } = await makeTree()
    try {
      const result = checkInstalledIntegrity({ repoDir: root, modulesDir: MODULES, scope: '@tangle-network/' })
      expect(result.coverage).toMatchObject({
        basis: 'store-cas',
        storeLocated: true,
        packagesExamined: 1,
        filesExamined: 3,
        // Every file shares an inode with a store blob, so none needed hashing.
        filesHashed: 0,
      })
      expect(result.findings).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // THE SECOND MEASURED DEFECT: a worktree whose installed agent-app@0.45.29
  // had `dist/spend/index.d.ts` replaced with a newer version's content. The
  // manifest, the lockfile and the version on disk all still agreed.
  it('catches a file whose bytes the store has never held', async () => {
    const { root, packageDir } = await makeTree()
    try {
      // A rename-based write — what an editor, `mv`, and every write-to-temp-
      // then-rename tool does.
      const target = join(packageDir, 'dist', 'spend', 'index.d.ts')
      writeFileSync(`${target}.tmp`, 'export declare const boxLivenessInWindow: unknown\n')
      renameSync(`${target}.tmp`, target)
      const result = checkInstalledIntegrity({ repoDir: root, modulesDir: MODULES, scope: '@tangle-network/' })
      expect(result.findings).toHaveLength(1)
      expect(result.findings[0]?.where).toContain('dist/spend/index.d.ts')
      expect(result.findings[0]?.detail).toContain('never contained')
      expect(result.coverage.filesHashed).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // THE FALSE POSITIVE THAT KILLED THE HARD-LINK-ONLY DESIGN. legal-agent's
  // installed `@tangle-network/agent-interface@0.32.0` carries an unlinked
  // `dist/environment-provider.js`, and `npm pack` of the published 0.32.0
  // yields that identical 11-byte `export {};` — pnpm wrote the copy instead of
  // linking it. An unlinked file is a reason to READ it, never a verdict.
  it('does not flag an unlinked file whose bytes are in the store', async () => {
    const { root, packageDir, store } = await makeTree()
    try {
      const target = join(packageDir, 'dist', 'index.js')
      const body = PACKAGE_FILES['dist/index.js']
      storeBlob(store, body)
      writeFileSync(`${target}.tmp`, body)
      renameSync(`${target}.tmp`, target)
      const result = checkInstalledIntegrity({ repoDir: root, modulesDir: MODULES, scope: '@tangle-network/' })
      expect(result.findings).toEqual([])
      expect(result.coverage.filesHashed).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // A copy-installed tree is fully verifiable — every file is read and looked
  // up. The hard-link step is only a shortcut, never the evidence.
  it('verifies a copy-installed package by reading every file', async () => {
    const { root } = await makeTree({ link: false })
    try {
      const result = checkInstalledIntegrity({ repoDir: root, modulesDir: MODULES, scope: '@tangle-network/' })
      expect(result.findings).toEqual([])
      expect(result.coverage).toMatchObject({ storeLocated: true, filesExamined: 3, filesHashed: 3 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // LIMIT, PINNED so nobody reads a clean integrity line as more than it is.
  // An edit that PRESERVES the inode — `> file`, `cp onto`, and Node's own
  // `writeFileSync` over an existing path — corrupts the STORE copy along with
  // the installed one, so both agree and nothing local disagrees. This is the
  // ceiling of the basis, and the test exists so the ceiling cannot move
  // quietly.
  it('CANNOT catch an in-place edit that preserves the inode', async () => {
    const { root, packageDir } = await makeTree()
    try {
      writeFileSync(join(packageDir, 'dist', 'spend', 'index.d.ts'), 'export declare const boxLivenessInWindow: unknown\n')
      const result = checkInstalledIntegrity({ repoDir: root, modulesDir: MODULES, scope: '@tangle-network/' })
      expect(result.findings).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // The other limit: CAS membership answers "has this store held these bytes",
  // not "do these bytes belong to this package at this version". A patch taken
  // from another version already on the machine passes.
  it('CANNOT catch a patch sourced from another package already in the store', async () => {
    const { root, packageDir, store } = await makeTree()
    try {
      const newer = 'export declare const boxLivenessInWindow: unknown\n'
      storeBlob(store, newer) // as if agent-app@0.45.35 were also installed here
      const target = join(packageDir, 'dist', 'spend', 'index.d.ts')
      writeFileSync(`${target}.tmp`, newer)
      renameSync(`${target}.tmp`, target)
      const result = checkInstalledIntegrity({ repoDir: root, modulesDir: MODULES, scope: '@tangle-network/' })
      expect(result.findings).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // pnpm GENERATES `.bin` shims inside a package's nested `node_modules`, and
  // those are never store content. Counting them made 3 of this repo's 8
  // installed @tangle-network packages look partially replaced.
  it('ignores the pnpm-generated shims in a package\'s nested node_modules', async () => {
    const { root, packageDir } = await makeTree()
    try {
      mkdirSync(join(packageDir, MODULES, '.bin'), { recursive: true })
      writeFileSync(join(packageDir, MODULES, '.bin', 'tsc'), '#!/bin/sh\n')
      const result = checkInstalledIntegrity({ repoDir: root, modulesDir: MODULES, scope: '@tangle-network/' })
      expect(result.findings).toEqual([])
      expect(result.coverage.filesExamined).toBe(3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // A pass that verified nothing must not render like a pass that verified
  // everything — this gate's own failure class, turned on itself.
  it('says NOT VERIFIED on its face when no store is reachable', () => {
    const report = checkDependencySources({ repoDir: inRepoSource, modulesDir: MODULES })
    expect(report.integrity.storeLocated).toBe(false)
    const text = formatDependencySourceReport(report)
    expect(text).toContain('NOT VERIFIED')
    expect(text).toContain('installed bytes UNVERIFIED')
  })

  // …and it is never a FINDING, because failing every npm/yarn consumer for
  // ever is how a gate gets deleted rather than adopted.
  it('does not turn an unreachable store into a violation', () => {
    const report = checkDependencySources({ repoDir: inRepoSource, modulesDir: MODULES })
    expect(report.ok).toBe(true)
  })
})

describe('the bin takes a repo and an exclusion, and nothing else', () => {
  it('parses both spellings of --exclude and defaults the directory', () => {
    expect(parsePeerCheckArgs(['/repo', '--exclude', 'fixtures', '--exclude=vendor/test-data']))
      .toEqual({ appDir: '/repo', exclude: ['fixtures', 'vendor/test-data'] })
    expect(parsePeerCheckArgs([]).exclude).toEqual([])
  })
})
