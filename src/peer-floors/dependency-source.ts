import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Audit where a repository's dependencies COME FROM.
 *
 * `/peer-floors` already answers "is the installed version inside the declared
 * range". This answers the question underneath it — "is the installed package
 * the one the registry publishes at all" — because a version number is not an
 * identity. Two artifacts can carry `0.45.33` and ship different APIs, and every
 * gate that reads a version reads the same number for both.
 *
 * THE MEASURED DEFECT. insurance-agent's `pnpm-workspace.yaml` carried
 *
 *     overrides:
 *       '@tangle-network/agent-app': file:./vendor/agent-app/tangle-network-agent-app-0.45.33.tgz
 *
 * — a 2.6 MB `pnpm pack` of an UNMERGED pull request, committed into the
 * product repo (`insurance-agent` f7d0f51 removed it). It installed cleanly,
 * typechecked green and passed sign-off while the product ran code that existed
 * in no published release. Note where it was NOT: `package.json` still read
 * `"@tangle-network/agent-app": "^0.45.33"`, a perfectly ordinary registry
 * range. A check that reads only the root manifest's `dependencies` sees
 * nothing. The override lane is the one that shipped, so the override lane —
 * `pnpm-workspace.yaml`, `pnpm.overrides`, `resolutions` — is audited first.
 *
 * The second shape is worse because nothing declares it at all: a worktree was
 * found whose installed `agent-app@0.45.29` had `dist/spend/index.d.ts`
 * replaced with a newer version's content by hand. The manifest, the lockfile
 * and the version on disk all agreed; only the bytes disagreed, and the product
 * typechecked green against an API its declared dependency does not ship. See
 * `checkInstalledIntegrity` below for exactly how much of that class is
 * catchable cheaply and exactly how much is not.
 */

/** How a specifier says a dependency should be obtained. */
export type DependencySourceProtocol =
  /** Resolvable from the registry by anyone: `^1.2.3`, `1.2.3`, `npm:x@1`. */
  | 'registry'
  /** `workspace:` — another package in this same repo. Reviewable in one diff. */
  | 'workspace'
  /** `catalog:` — indirection into `pnpm-workspace.yaml`, which is itself audited. */
  | 'catalog'
  /** A local path. Whether it is legitimate depends on WHERE it points. */
  | 'file'
  | 'link'
  | 'portal'
  /** A path or URL ending in a packed tarball. Opaque bytes; never legitimate. */
  | 'tarball'
  /** A git ref or a remote URL that is not the registry. */
  | 'git'
  | 'remote'

const TARBALL = /\.(?:tgz|tar\.gz)$/i

/**
 * Classify one dependency specifier by the SOURCE it names.
 *
 * Pure and exported so a consumer can reuse the vocabulary, and so the rule can
 * be tested without a filesystem. Nothing here decides legitimacy — `file:` on
 * a directory inside the repo is correct and `file:` on a tarball never is, and
 * that distinction needs the disk (`resolveLocalPathSource`).
 */
export function classifyDependencySpecifier(specifier: string): DependencySourceProtocol {
  const spec = specifier.trim()
  if (spec.startsWith('workspace:')) return 'workspace'
  if (spec.startsWith('catalog:')) return 'catalog'
  for (const protocol of ['file:', 'link:', 'portal:'] as const) {
    if (spec.startsWith(protocol)) {
      const path = spec.slice(protocol.length)
      if (TARBALL.test(path)) return 'tarball'
      return protocol.slice(0, -1) as 'file' | 'link' | 'portal'
    }
  }
  if (/^(?:git|git\+ssh|git\+https?|git\+file|ssh):/.test(spec)) return 'git'
  if (/^(?:github|gitlab|bitbucket):/.test(spec)) return 'git'
  if (/^https?:\/\//.test(spec)) return TARBALL.test(spec.split(/[?#]/)[0] ?? '') ? 'tarball' : 'remote'
  // `owner/repo` and `owner/repo#ref` are npm's GitHub shorthand. A scoped
  // package name (`@scope/name`) also contains a slash, hence the leading-@ guard.
  if (/^[\w.-]+\/[\w.-]+(?:#.+)?$/.test(spec) && !spec.startsWith('@')) return 'git'
  return 'registry'
}

/** A protocol that resolves from the registry, or from this repo's own sources. */
function isReproducible(protocol: DependencySourceProtocol): boolean {
  return protocol === 'registry' || protocol === 'workspace' || protocol === 'catalog'
}

/**
 * The legitimate-exception rule, stated once so it is not a path allowlist.
 *
 * agent-app's own `playground/package.json` declares
 * `"@tangle-network/agent-app": "file:.."` and that is CORRECT: the playground
 * depends on the package it lives inside. The property that makes it correct is
 * not its path — it is that the dependency is satisfied by SOURCE ALREADY IN
 * THIS REPOSITORY, under version control, changing only in a diff a reviewer
 * sees. So the rule is:
 *
 *   A `file:` / `link:` / `portal:` specifier is exempt when it resolves to a
 *   DIRECTORY inside this repository holding a `package.json` whose `name` is
 *   the dependency being declared.
 *
 * Every clause is load-bearing. A DIRECTORY, because a `.tgz` is opaque bytes
 * that no diff shows — a packed tarball is never exempt, wherever it sits.
 * INSIDE THIS REPOSITORY, because `file:../../agent-app` is a path on one
 * machine: it resolves for its author and for nobody else, and a sign-off gate
 * that installs into a clean export dies at install. NAME MATCHES, because a
 * path pointing at some other package's source is a mis-wire, not a
 * self-reference.
 */
export type LocalPathSource =
  /** In-repo directory whose package.json names this dependency. Legitimate. */
  | 'in-repo-source'
  /** Points outside the repository — reproducible on one machine only. */
  | 'outside-repo'
  /** Nothing there, or not a directory (a packed tarball lands here too). */
  | 'not-a-directory'
  /** An in-repo directory, but it is a different package. */
  | 'name-mismatch'

export function resolveLocalPathSource(args: {
  /** Directory of the manifest that made the declaration. */
  fromDir: string
  /** Root of the repository the declaration must stay inside. */
  repoDir: string
  /** The path part of the specifier, protocol already stripped. */
  path: string
  /** The dependency name the path is claimed to satisfy. */
  name: string
}): LocalPathSource {
  const root = resolve(args.repoDir)
  const target = isAbsolute(args.path) ? resolve(args.path) : resolve(args.fromDir, args.path)
  if (target !== root && !target.startsWith(root + sep)) return 'outside-repo'
  const manifest = join(target, 'package.json')
  if (!existsSync(manifest) || !statSync(target).isDirectory()) return 'not-a-directory'
  let declared: string | undefined
  try {
    declared = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name
  } catch {
    return 'not-a-directory'
  }
  return declared === args.name ? 'in-repo-source' : 'name-mismatch'
}

/** Which of the five scans produced a finding. Kept on the row because the fix
 *  differs: a declaration is edited, an installed tree is reinstalled. */
export type DependencySourceCheck =
  /** A `dependencies`-family field in some `package.json`. */
  | 'declared'
  /** `pnpm.overrides` / `resolutions` / `pnpm-workspace.yaml` — the lane that shipped. */
  | 'override'
  /** `pnpm-lock.yaml` — what actually resolved, whatever the manifests now say. */
  | 'lockfile'
  /** A packed tarball sitting in the source tree. */
  | 'vendored-tarball'
  /** The installed tree on disk. */
  | 'installed'

export interface DependencySourceFinding {
  readonly check: DependencySourceCheck
  /** Dependency name, or `null` for a stray tarball that names no dependency. */
  readonly name: string | null
  readonly specifier: string | null
  readonly protocol: DependencySourceProtocol | null
  /** Repo-relative location, with the key or line that carries it. */
  readonly where: string
  /** Why this is a finding, and what to do about it. */
  readonly detail: string
}

/**
 * What the on-disk integrity pass was able to examine — reported on EVERY run,
 * clean or not, because "checked nothing" and "checked everything and found
 * nothing" render identically otherwise. This module's own doctrine: an
 * unchecked contract is never a pass it did not earn.
 */
export interface InstalledIntegrityCoverage {
  /** The only basis implemented. See `checkInstalledIntegrity`'s limits. */
  readonly basis: 'store-cas'
  /** False for npm, yarn, a pruned CI cache, or a store on another machine.
   *  Nothing was verified, and the report says so rather than reading clean. */
  readonly storeLocated: boolean
  readonly packagesExamined: number
  readonly filesExamined: number
  /** Files settled by reading their bytes rather than by a shared inode. */
  readonly filesHashed: number
}

export interface DependencySourceReport {
  readonly repoDir: string
  readonly manifestsScanned: number
  readonly lockfileScanned: boolean
  readonly integrity: InstalledIntegrityCoverage
  readonly findings: readonly DependencySourceFinding[]
  readonly ok: boolean
}

export interface CheckDependencySourcesOptions {
  /** Repository root to audit. */
  repoDir: string
  /** Scope filter for the on-disk integrity pass. `''` examines every package. */
  scope?: string
  /** Directory name holding the installed tree. Overridable so a committed
   *  fixture can use `fixture_modules` — `node_modules` is gitignored
   *  everywhere, and a calibration proof that is not committed stops running. */
  modulesDir?: string
  /** Repo-relative path prefixes the source-tree walk skips. The escape hatch
   *  for a repo that genuinely carries a tarball as test data — and for this
   *  package's own calibration fixtures, whose purpose is to CONTAIN the
   *  violation. */
  exclude?: readonly string[]
}

/** Directories a source-tree walk must never descend into: build output and
 *  installed packages are not declarations, and walking them turns a
 *  sub-second scan into a minute. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.wrangler', '.react-router', '.next', '.turbo', '.cache', 'storybook-static',
])

function walkSourceTree(
  dir: string,
  repoDir: string,
  exclude: readonly string[],
  seen: { manifests: string[]; tarballs: string[] },
): void {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    const rel = relative(repoDir, full).split(sep).join('/')
    if (exclude.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) continue
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walkSourceTree(full, repoDir, exclude, seen)
    } else if (entry.isFile()) {
      if (entry.name === 'package.json') seen.manifests.push(full)
      else if (TARBALL.test(entry.name)) seen.tarballs.push(full)
    }
  }
}

/* ---------------------------------------------------------------------------
 * A line reader for the two YAML files that matter.
 *
 * Deliberately not a YAML dependency: this package ships zero runtime deps and
 * forcing one on every consumer to read four block mappings is the worse trade
 * — the same call `/peer-floors` made about `semver`. The shapes read here are
 * `pnpm-workspace.yaml`'s `overrides`/`catalog`/`catalogs` and
 * `pnpm-lock.yaml`'s `overrides`/`importers`/`packages`/`snapshots`, all of
 * which pnpm emits as plain two-space block mappings of scalars.
 * ------------------------------------------------------------------------ */

interface YamlLine {
  readonly indent: number
  readonly key: string
  readonly value: string
  /** Enclosing keys, outermost first, excluding this line's own key. */
  readonly path: readonly string[]
  readonly lineNumber: number
}

function unquote(text: string): string {
  const t = text.trim()
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1)
  }
  return t
}

function readYamlLines(text: string): YamlLine[] {
  const out: YamlLine[] = []
  // Innermost key seen at each indent level, so a `specifier:` line can name
  // the dependency it belongs to.
  const stack: string[] = []
  text.split('\n').forEach((raw, index) => {
    if (!raw.trim() || raw.trimStart().startsWith('#')) return
    const indent = raw.length - raw.trimStart().length
    const match = /^\s*(?:'((?:[^']|'')*)'|"([^"]*)"|([^\s:#][^:]*?))\s*:(?:\s+(.*))?$/.exec(raw)
    if (!match) return
    const key = (match[1] ?? match[2] ?? match[3] ?? '').replace(/''/g, "'")
    // A trailing ` # comment` is a comment only outside quotes; every value pnpm
    // writes here is unquoted or fully quoted, so splitting on ` #` is exact.
    const rawValue = (match[4] ?? '').split(' #')[0] ?? ''
    const depth = Math.floor(indent / 2)
    stack.length = depth
    const path = [...stack]
    stack[depth] = key
    out.push({ indent, key, value: unquote(rawValue), path, lineNumber: index + 1 })
  })
  return out
}

/** The top-level section a nested line sits under. */
function sectionOf(line: YamlLine): string | undefined {
  return line.indent === 0 ? line.key : line.path[0]
}

/* ------------------------------------------------------------------------ */

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

/**
 * Judge one declaration and produce a finding, or `null` when it is fine.
 *
 * One function so the manifest lane, the override lane and the lockfile lane
 * cannot drift into three different opinions about the same specifier.
 */
function judge(args: {
  check: DependencySourceCheck
  name: string
  specifier: string
  where: string
  fromDir: string
  repoDir: string
}): DependencySourceFinding | null {
  const protocol = classifyDependencySpecifier(args.specifier)
  if (isReproducible(protocol)) return null

  const base = { check: args.check, name: args.name, specifier: args.specifier, protocol, where: args.where }

  if (protocol === 'tarball') {
    return {
      ...base,
      detail: 'resolves a PACKED TARBALL, not a published release. A .tgz is opaque bytes that no '
        + 'diff shows and no registry can reproduce: the version inside it can collide with a real '
        + 'release and ship a different API. Publish the change and pin the published range.',
    }
  }
  if (protocol === 'git' || protocol === 'remote') {
    return {
      ...base,
      detail: `resolves from ${protocol === 'git' ? 'a git ref' : 'a remote URL'} rather than the `
        + 'registry, so what installs depends on what that ref points at today. Publish the change '
        + 'and pin the published range.',
    }
  }

  const path = args.specifier.slice(args.specifier.indexOf(':') + 1)
  const source = resolveLocalPathSource({ fromDir: args.fromDir, repoDir: args.repoDir, path, name: args.name })
  if (source === 'in-repo-source') return null
  const why: Record<Exclude<LocalPathSource, 'in-repo-source'>, string> = {
    'outside-repo': 'points OUTSIDE this repository, so it resolves on one machine and nowhere else — '
      + 'a clean checkout, a CI runner and a sign-off gate that installs into an exported tree all '
      + 'get a different answer or fail at install.',
    'not-a-directory': 'does not resolve to a package directory in this repository. A local specifier '
      + 'is only legitimate when it points at in-repo SOURCE a reviewer sees in the diff.',
    'name-mismatch': `resolves to an in-repo directory that declares a DIFFERENT package name, so the `
      + `dependency ${args.name} is being satisfied by something else entirely.`,
  }
  return { ...base, detail: `${why[source]} (${source})` }
}

function scanManifest(file: string, repoDir: string): DependencySourceFinding[] {
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return []
  }
  const fromDir = dirname(file)
  const where = relative(repoDir, file).split(sep).join('/') || 'package.json'
  const findings: DependencySourceFinding[] = []

  for (const field of DEP_FIELDS) {
    const block = manifest[field]
    if (!block || typeof block !== 'object') continue
    for (const [name, specifier] of Object.entries(block as Record<string, unknown>)) {
      if (typeof specifier !== 'string') continue
      const finding = judge({ check: 'declared', name, specifier, where: `${where} → ${field}`, fromDir, repoDir })
      if (finding) findings.push(finding)
    }
  }

  // The lane insurance's defect actually used. `resolutions` is yarn/npm's
  // spelling of the same authority; both silently outrank every range above.
  const overrideBlocks: Array<[string, unknown]> = [
    ['pnpm.overrides', (manifest.pnpm as { overrides?: unknown } | undefined)?.overrides],
    ['resolutions', manifest.resolutions],
  ]
  for (const [label, block] of overrideBlocks) {
    if (!block || typeof block !== 'object') continue
    for (const [name, specifier] of Object.entries(block as Record<string, unknown>)) {
      if (typeof specifier !== 'string') continue
      const finding = judge({
        check: 'override',
        // An override key can carry a range suffix (`foo@1 > bar`); the package
        // name is the leading segment.
        name: overrideKeyName(name),
        specifier,
        where: `${where} → ${label}['${name}']`,
        fromDir,
        repoDir,
      })
      if (finding) findings.push(finding)
    }
  }
  return findings
}

/** `@scope/pkg@^1 > dep` and `pkg@1` both name `pkg` / `@scope/pkg`. */
function overrideKeyName(key: string): string {
  const head = (key.split('>').pop() ?? key).trim()
  const at = head.lastIndexOf('@')
  return at > 0 ? head.slice(0, at) : head
}

function scanWorkspaceYaml(file: string, repoDir: string): DependencySourceFinding[] {
  const findings: DependencySourceFinding[] = []
  const where = relative(repoDir, file).split(sep).join('/')
  for (const line of readYamlLines(readFileSync(file, 'utf8'))) {
    const section = sectionOf(line)
    if (section !== 'overrides' && section !== 'catalog' && section !== 'catalogs') continue
    if (line.indent === 0 || !line.value) continue
    const finding = judge({
      check: 'override',
      name: overrideKeyName(line.key),
      specifier: line.value,
      where: `${where}:${line.lineNumber} → ${[...line.path, line.key].join('.')}`,
      fromDir: dirname(file),
      repoDir,
    })
    if (finding) findings.push(finding)
  }
  return findings
}

/**
 * The lockfile is the only file that reports what ACTUALLY resolved. A manifest
 * can be cleaned up while `pnpm-lock.yaml` still resolves a tarball, and the
 * install follows the lockfile.
 *
 * Three shapes carry it, all present in the real insurance-agent lockfile:
 *   overrides:  '@tangle-network/agent-app': file:./vendor/…-0.45.33.tgz
 *   importers:    specifier: file:vendor/…-0.45.33.tgz
 *   packages:   '@tangle-network/agent-app@file:vendor/…-0.45.33.tgz':
 */
function scanLockfile(file: string, repoDir: string): DependencySourceFinding[] {
  const findings: DependencySourceFinding[] = []
  const where = relative(repoDir, file).split(sep).join('/')
  const fromDir = dirname(file)
  const seen = new Set<string>()
  const push = (finding: DependencySourceFinding | null): void => {
    if (!finding) return
    const key = `${finding.name}|${finding.specifier}`
    if (seen.has(key)) return
    seen.add(key)
    findings.push(finding)
  }

  for (const line of readYamlLines(readFileSync(file, 'utf8'))) {
    const section = sectionOf(line)
    if (section === 'overrides' && line.indent > 0 && line.value) {
      push(judge({
        check: 'lockfile',
        name: overrideKeyName(line.key),
        specifier: line.value,
        where: `${where}:${line.lineNumber} → overrides`,
        fromDir,
        repoDir,
      }))
      continue
    }
    if (section === 'importers' && line.key === 'specifier' && line.value) {
      push(judge({
        check: 'lockfile',
        name: line.path[line.path.length - 1] ?? '(unknown)',
        specifier: line.value,
        where: `${where}:${line.lineNumber} → importers`,
        fromDir,
        repoDir,
      }))
      continue
    }
    if ((section === 'packages' || section === 'snapshots') && line.indent === 2 && !line.value) {
      const parsed = parsePackageKey(line.key)
      if (!parsed) continue
      push(judge({
        check: 'lockfile',
        name: parsed.name,
        specifier: parsed.reference,
        where: `${where}:${line.lineNumber} → ${section}`,
        fromDir,
        repoDir,
      }))
    }
  }
  return findings
}

/**
 * `'@scope/name@file:vendor/x.tgz'` → name + reference.
 *
 * The peer-suffix is stripped FIRST: a snapshot key looks like
 * `@radix-ui/react-dialog@1.1.23(@types/react@19.2.17)`, and the last `@` in
 * that string sits inside the suffix, not at the version boundary.
 */
function parsePackageKey(key: string): { name: string; reference: string } | null {
  const withoutPeers = key.replace(/\(.*\)$/, '')
  const at = withoutPeers.lastIndexOf('@')
  if (at <= 0) return null
  return { name: withoutPeers.slice(0, at), reference: withoutPeers.slice(at + 1) }
}

/**
 * pnpm's virtual store encodes a dependency's SOURCE in the directory name:
 * a registry package is `@tangle-network+agent-app@0.45.33`, while the
 * vendored one installed as
 * `file+vendor+agent-app+tangle-network-agent-app-0.45.33.tgz`.
 *
 * This is install evidence that survives a tidied manifest and a regenerated
 * lockfile, which is why it is scanned separately rather than trusted to follow
 * from them.
 */
function scanVirtualStore(
  repoDir: string,
  modulesDir: string,
): DependencySourceFinding[] {
  const store = join(repoDir, modulesDir, '.pnpm')
  if (!existsSync(store)) return []
  const findings: DependencySourceFinding[] = []
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === modulesDir) continue
    const protocolMatch = /^(file|link|portal|git|https?)\+/.exec(entry.name)
    if (!protocolMatch) continue
    const protocol = protocolMatch[1] as string
    // pnpm encodes `/` as `+` for the whole remainder of a path-protocol key.
    const encoded = entry.name.slice(protocol.length + 1)
    const name = installedPackageName(join(store, entry.name), modulesDir)
    const where = `${modulesDir}/.pnpm/${entry.name}`

    if (protocol === 'file' || protocol === 'link' || protocol === 'portal') {
      const path = encoded.split('+').join('/')
      const specifier = `${protocol}:${path}`
      const finding = judge({
        check: 'installed',
        name: name ?? path,
        specifier,
        where,
        // A virtual-store path is written relative to the install root.
        fromDir: repoDir,
        repoDir,
      })
      if (finding) findings.push(finding)
      continue
    }
    findings.push({
      check: 'installed',
      name,
      specifier: encoded.split('+++').join('://').split('+').join('/'),
      protocol: protocol === 'git' ? 'git' : 'remote',
      where,
      detail: 'is INSTALLED from a git ref or remote URL rather than the registry. The manifests may '
        + 'read clean — this is what the tree on disk actually holds. Reinstall from a published range.',
    })
  }
  return findings
}

/**
 * The package a virtual-store entry belongs to: the one REAL directory under
 * its nested module dir (its dependencies are all symlinks).
 *
 * The nested level takes `modulesDir` too, not a hardcoded `node_modules`.
 * In a real install both levels ARE `node_modules`, so nothing changes there —
 * but a COMMITTED fixture cannot carry a `node_modules` path segment at any
 * depth, because every repo gitignores that name. Hardcoding it here made this
 * module's own calibration tree un-committable, which is the failure the
 * `fixture_modules` convention exists to prevent, reintroduced one level down.
 */
function installedPackageName(entryDir: string, modulesDir: string): string | null {
  const nested = join(entryDir, modulesDir)
  if (!existsSync(nested)) return null
  for (const child of readdirSync(nested, { withFileTypes: true })) {
    if (child.name === '.bin' || child.isSymbolicLink()) continue
    if (!child.isDirectory()) continue
    if (child.name.startsWith('@')) {
      const scopeDir = join(nested, child.name)
      for (const scoped of readdirSync(scopeDir, { withFileTypes: true })) {
        if (scoped.isSymbolicLink() || !scoped.isDirectory()) continue
        if (existsSync(join(scopeDir, scoped.name, 'package.json'))) return `${child.name}/${scoped.name}`
      }
      continue
    }
    if (existsSync(join(nested, child.name, 'package.json'))) return child.name
  }
  return null
}

/* ---------------------------------------------------------------------------
 * On-disk integrity — and an honest account of its ceiling.
 *
 * WHAT WAS CONSIDERED AND REJECTED. Full verification means comparing the
 * installed bytes against the PUBLISHED tarball. `pnpm-lock.yaml` records that
 * tarball's `integrity` (`sha512-…`) and nothing about its contents, and the
 * tarball is not on disk: pnpm unpacks into a content-addressed store and keeps
 * the per-file digests in an INDEX whose location and format change between
 * pnpm majors — pnpm 10 writes JSON under `store/v10/index/`, pnpm 11 writes one
 * SQLite database (measured: `~/.local/share/pnpm/store/v11/index.db`, 57 MB).
 * Reading it means a SQLite dependency plus a coupling to store internals, in a
 * package that ships zero runtime dependencies; re-fetching the tarball means
 * network access inside a gate that must run offline in seconds. So full
 * verification is NOT affordable and is not attempted.
 *
 * WHAT IS AFFORDABLE. The store is CONTENT-ADDRESSED: a file's bytes live at
 * `<store>/files/<first 2 hex>/<rest>` of their own sha512, a layout that has
 * survived v3 → v10 → v11 while the index format changed twice. So a file's
 * bytes can be asked one question with no dependency and no network — "has this
 * store ever held these bytes?" Bytes that came out of a package pnpm installed
 * are in there by construction. Bytes typed in afterwards are not.
 *
 * Two steps, because hashing 30,000 files per run would not be cheap:
 *   1. `nlink > 1` — the file shares an inode, so it IS a store blob. No hash.
 *      This settles ~99% of files at the cost of one `lstat`.
 *   2. Everything else is hashed and looked up in the store CAS.
 *
 * THE HARD-LINK COUNT ALONE IS NOT THE SIGNAL, and believing it was is the
 * mistake this design corrects. An earlier cut reported any package holding
 * both linked and unlinked files as tampered. Measured across five real fleet
 * repos it fired once — on legal-agent's `@tangle-network/agent-interface@0.32.0`,
 * whose `dist/environment-provider.js` is `nlink == 1` — and that finding was
 * FALSE: `npm pack @tangle-network/agent-interface@0.32.0` yields the identical
 * 11-byte `export {};`. pnpm simply wrote that copy instead of linking it. A
 * 1-in-5-repos false alarm is a gate people switch off, and the CAS lookup is
 * what tells the two apart: those bytes ARE in the store.
 *
 * MEASURED after adding the lookup: 5 fleet repos, 0 findings, 0 false alarms.
 *
 * WHAT IT CANNOT CATCH, precisely — do not read a clean integrity line as more:
 *   1. A patch whose content came from ANOTHER package or version ALREADY in
 *      this store. CAS membership proves "this store has held these bytes", not
 *      "these bytes belong to this package at this version". The measured
 *      defect — a `dist/spend/index.d.ts` overwritten with a NEWER version's
 *      copy — is caught only when that newer version was never installed on the
 *      machine. This is the real ceiling; closing it needs the per-file index.
 *   2. An edit that PRESERVES the inode (`> file`, `cp onto`). The link
 *      survives and the STORE copy is corrupted with it, so both agree.
 *   3. A tampered store: everything resolves, everything agrees, all wrong.
 *   4. Anything at all when the store cannot be located — npm, yarn, a store on
 *      another machine, a pruned CI cache. That is reported as NOT VERIFIED
 *      rather than as a pass, and it is never a finding, because failing every
 *      non-pnpm consumer forever is how a gate gets deleted.
 * ------------------------------------------------------------------------ */

/**
 * Every content-addressed `files/` directory this install could have linked
 * from, read out of `node_modules/.modules.yaml` — pure `fs`, no `pnpm store
 * path` subprocess.
 *
 * More than one, because a long-lived machine has several store majors side by
 * side and an existing tree can be linked from an older one: measured on
 * legal-agent, `dist/index.js` resolves in `store/v10/files` while
 * `dist/environment-provider.js` resolves in `store/v10/v11/files`. Checking
 * only the configured one reports a linked file as unknown.
 */
function locateStoreCas(repoDir: string, modulesDir: string): string[] {
  const modulesState = join(repoDir, modulesDir, '.modules.yaml')
  if (!existsSync(modulesState)) return []
  let configured: string | undefined
  try {
    const text = readFileSync(modulesState, 'utf8')
    // pnpm 11 writes JSON under the .yaml name; older versions write YAML.
    configured = (/"storeDir"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1]
      ?? /^storeDir:\s*(.+)$/m.exec(text)?.[1])?.trim()
  } catch {
    return []
  }
  if (!configured) return []
  const root = unquote(configured.replace(/\\\\/g, '\\'))
  const candidates = new Set<string>([root, dirname(root)])
  for (const base of [root, dirname(root)]) {
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && /^v\d+$/.test(entry.name)) candidates.add(join(base, entry.name))
      }
    } catch { /* an unreadable store is simply not a candidate */ }
  }
  return [...candidates].map((dir) => join(dir, 'files')).filter((dir) => existsSync(dir))
}

function collectFiles(dir: string, modulesDir: string, out: string[] = []): string[] {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    // A package's own nested `node_modules` holds pnpm-GENERATED `.bin` shims
    // and symlinks, never store content. Including it made 3 of this repo's 8
    // installed @tangle-network packages look partially replaced.
    if (entry.name === modulesDir) continue
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) collectFiles(full, modulesDir, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/** Does any reachable store hold these exact bytes? `-exec` is pnpm's suffix
 *  for the executable-mode copy of the same content. */
function storeHolds(casDirs: readonly string[], bytes: Buffer): boolean {
  const hex = createHash('sha512').update(bytes).digest('hex')
  const tail = join(hex.slice(0, 2), hex.slice(2))
  return casDirs.some((dir) => existsSync(join(dir, tail)) || existsSync(join(dir, `${tail}-exec`)))
}

/**
 * Check each installed package under `scope` against the content-addressed
 * store it was installed from. Returns coverage alongside findings, because a
 * pass that verified nothing must not render like a pass that verified
 * everything.
 */
export function checkInstalledIntegrity(args: {
  repoDir: string
  modulesDir: string
  scope: string
}): { coverage: InstalledIntegrityCoverage; findings: DependencySourceFinding[] } {
  const virtualStore = join(args.repoDir, args.modulesDir, '.pnpm')
  const casDirs = locateStoreCas(args.repoDir, args.modulesDir)
  const findings: DependencySourceFinding[] = []
  let packagesExamined = 0
  let filesExamined = 0
  let filesHashed = 0

  if (casDirs.length > 0 && existsSync(virtualStore)) {
    for (const entry of readdirSync(virtualStore, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === args.modulesDir) continue
      const entryDir = join(virtualStore, entry.name)
      const name = installedPackageName(entryDir, args.modulesDir)
      if (!name || !name.startsWith(args.scope)) continue
      const packageDir = join(entryDir, args.modulesDir, name)
      if (!existsSync(packageDir)) continue

      const files = collectFiles(packageDir, args.modulesDir)
      if (files.length === 0) continue
      packagesExamined += 1
      filesExamined += files.length

      const foreign: string[] = []
      for (const file of files) {
        try {
          // A shared inode IS a store blob — settled without reading the file.
          if (lstatSync(file).nlink > 1) continue
          filesHashed += 1
          if (storeHolds(casDirs, readFileSync(file))) continue
          foreign.push(relative(packageDir, file).split(sep).join('/'))
        } catch { /* a file that vanished mid-walk is not evidence */ }
      }
      if (foreign.length === 0) continue

      const shown = foreign.slice(0, 5)
      findings.push({
        check: 'installed',
        name,
        specifier: null,
        protocol: null,
        where: `${args.modulesDir}/.pnpm/${entry.name} → ${shown.join(', ')}`
          + `${foreign.length > shown.length ? ` (+${foreign.length - shown.length} more)` : ''}`,
        detail: `holds ${foreign.length} file(s) whose bytes this pnpm store has never contained — the `
          + 'shape of a package HAND-PATCHED after install. The version on disk, the manifest and the '
          + 'lockfile all still agree; only the bytes do not, which is how a product typechecks green '
          + 'against an API its declared dependency does not ship. Delete the tree and reinstall '
          + `(\`rm -rf ${args.modulesDir} && pnpm install --frozen-lockfile\`), then publish whatever `
          + 'change made the patch look necessary.',
      })
    }
  }

  return {
    coverage: {
      basis: 'store-cas',
      storeLocated: casDirs.length > 0,
      packagesExamined,
      filesExamined,
      filesHashed,
    },
    findings,
  }
}

/** Audit one repository for dependencies whose source is not the registry. */
export function checkDependencySources(options: CheckDependencySourcesOptions): DependencySourceReport {
  const repoDir = resolve(options.repoDir)
  const { scope = '@tangle-network/', modulesDir = 'node_modules', exclude = [] } = options

  const seen = { manifests: [] as string[], tarballs: [] as string[] }
  walkSourceTree(repoDir, repoDir, exclude, seen)

  const findings: DependencySourceFinding[] = []
  for (const manifest of seen.manifests) findings.push(...scanManifest(manifest, repoDir))

  const workspaceYaml = join(repoDir, 'pnpm-workspace.yaml')
  if (existsSync(workspaceYaml)) findings.push(...scanWorkspaceYaml(workspaceYaml, repoDir))

  const lockfile = join(repoDir, 'pnpm-lock.yaml')
  const lockfileScanned = existsSync(lockfile)
  if (lockfileScanned) findings.push(...scanLockfile(lockfile, repoDir))

  for (const tarball of seen.tarballs) {
    findings.push({
      check: 'vendored-tarball',
      name: null,
      specifier: null,
      protocol: 'tarball',
      where: relative(repoDir, tarball).split(sep).join('/'),
      detail: 'is a PACKED TARBALL committed into the source tree. Even when nothing points at it today, '
        + 'it is a build nobody can reproduce from the registry sitting one `file:` line away from '
        + `shipping. Delete it; if ${basename(tarball)} is genuinely test data, move it under a path `
        + 'passed to `--exclude`.',
    })
  }

  findings.push(...scanVirtualStore(repoDir, modulesDir))
  const integrity = checkInstalledIntegrity({ repoDir, modulesDir, scope })
  findings.push(...integrity.findings)

  return {
    repoDir,
    manifestsScanned: seen.manifests.length,
    lockfileScanned,
    integrity: integrity.coverage,
    findings,
    ok: findings.length === 0,
  }
}

const CHECK_LABEL: Record<DependencySourceCheck, string> = {
  declared: 'DECLARED',
  override: 'OVERRIDE',
  lockfile: 'LOCKFILE',
  'vendored-tarball': 'TARBALL',
  installed: 'INSTALLED',
}

/** One finding rendered as the failure a reader has to act on. */
export function describeDependencySourceFinding(finding: DependencySourceFinding): string {
  const subject = finding.name
    ? `${finding.name}${finding.specifier ? ` (${finding.specifier})` : ''}`
    : finding.where
  return `DEPENDENCY SOURCE: ${subject} ${finding.detail}\n    at ${finding.where}`
}

export function formatDependencySourceReport(report: DependencySourceReport): string {
  const { integrity } = report
  // Printed on EVERY report, clean or not: "verified nothing" and "verified
  // everything and found nothing" are otherwise the same green line, which is
  // this gate's own failure class turned on itself.
  const integrityLine = integrity.storeLocated
    ? `  integrity (${integrity.basis}): ${integrity.packagesExamined} package(s), `
      + `${integrity.filesExamined} file(s), ${integrity.filesHashed} hashed against the store`
    : `  integrity (${integrity.basis}): NOT VERIFIED — no pnpm content-addressed store is reachable `
      + 'from this tree, so no installed bytes were checked against anything'
  const lines = [
    'dependency sources',
    '',
    `  scanned ${report.manifestsScanned} manifest(s), `
    + `${report.lockfileScanned ? 'pnpm-lock.yaml' : 'no lockfile'}`,
    integrityLine,
    '',
  ]
  if (report.ok) {
    lines.push(
      integrity.storeLocated && integrity.packagesExamined > 0
        ? '  ok  every declared source is the registry, and every installed byte came from the store'
        : '  ok  every declared source is the registry — installed bytes UNVERIFIED (see above)',
    )
  } else {
    for (const finding of report.findings) {
      lines.push(`  FAIL [${CHECK_LABEL[finding.check]}] ${describeDependencySourceFinding(finding)}`, '')
    }
  }
  return lines.join('\n')
}
