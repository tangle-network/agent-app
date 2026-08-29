import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The second half of this gate lives in `./dependency-source` and ships on the
 * SAME subpath and the SAME `agent-app-peer-check` bin, because it answers the
 * question underneath this one: a floor comparison reads a version, and a
 * version is not an identity — a vendored `pnpm pack` of an unmerged branch
 * carries the same `0.45.33` a real release does.
 */
export * from './dependency-source'

/**
 * Audit a consumer's installed tree against the peer floors this package
 * declares.
 *
 * A peer floor is not documentation — it encodes a WIRE CONTRACT, and breaking
 * one is invisible to every other gate. `pnpm` only WARNS on an unmet peer when
 * the package is also a direct dependency, and says nothing at all for an unmet
 * OPTIONAL peer, which is how most of the substrate is declared here. So a
 * product can sit below a floor with a clean install, a clean typecheck, a green
 * suite and a successful deploy, and fail only on a live wire call:
 *
 *   `@tangle-network/sandbox` 0.15.0 → 0.15.1 changed the sidecar spawn body
 *   from `{ command }` to `{ executable, args }`. Below the floor, every
 *   `box.exec()` on a live sandbox returns 400 `Unrecognized key: "command"`.
 *
 *   `@tangle-network/agent-interface` 0.38.0 changed MCP config values from
 *   plain strings to tagged public/secret-ref objects. Below the floor, this
 *   package fails at MODULE LOAD with "does not provide an export named
 *   defineAgentProfilePublicConfig" — while `tsc` reports zero errors, because
 *   the types resolve and only the runtime export is missing.
 *
 * That second shape is why this exists as its own gate: typecheck cannot see it,
 * and a suite only sees it as dozens of unrelated-looking import failures.
 */

/** Installed, and inside the declared range. */
export type PeerFloorVerdict =
  | 'satisfied'
  /** Installed and BELOW the floor — the silent case this module exists for. */
  | 'below-floor'
  /** Not installed and never asked for. A legitimate answer for an optional peer. */
  | 'absent-unused'
  /** Declared by the app, yet no version could be read, so the floor went
   *  UNCHECKED. Reported as a failure rather than a pass this did not earn. */
  | 'absent-but-declared'

export interface PeerFloorRow {
  readonly name: string
  readonly range: string
  readonly installed: string | null
  readonly verdict: PeerFloorVerdict
}

export interface PeerFloorReport {
  readonly shell: string
  readonly shellVersion: string
  readonly rows: readonly PeerFloorRow[]
  readonly violations: readonly PeerFloorRow[]
  readonly ok: boolean
}

export interface CheckPeerFloorsOptions {
  /** Directory of the app under audit — the one whose `package.json` and
   *  installed tree are read. */
  appDir: string
  /** Package whose peer floors are the contract. Defaults to this shell. */
  shell?: string
  /** Only audit peers under this scope. Third-party peers (react, drizzle) are
   *  the app's own business, not part of the Tangle wire contract. Pass `''` to
   *  audit every peer. */
  scope?: string
  /** Floors to audit against, when the shell is not resolvable from `appDir` —
   *  the package auditing ITSELF, which has no copy of itself in its own
   *  `node_modules`. Without this a package cannot check that the contract it
   *  publishes is one its own dev install satisfies. */
  shellManifest?: { version?: string; peerDependencies?: Record<string, string> }
  /** Directory name to walk for installed packages. Overridable so a test can
   *  point at a committed fixture tree — `node_modules` is gitignored
   *  everywhere, so a fixture using that name could not be committed, and a
   *  calibration proof that is not committed is a proof that stops running. */
  modulesDir?: string
}

export type CheckAllPeerFloorsOptions = Pick<
  CheckPeerFloorsOptions,
  'appDir' | 'modulesDir' | 'scope'
>

function installedPackageNames(
  appDir: string,
  modulesDir: string,
  scope: string,
): readonly string[] {
  const modulesRoot = join(appDir, modulesDir)
  if (!existsSync(modulesRoot)) return []
  if (scope !== '') {
    const scopeDir = join(modulesRoot, scope.slice(0, -1))
    return existsSync(scopeDir)
      ? readdirSync(scopeDir).sort().map((name) => `${scope}${name}`)
      : []
  }

  return readdirSync(modulesRoot)
    .filter((name) => !name.startsWith('.'))
    .flatMap((name) => name.startsWith('@')
      ? readdirSync(join(modulesRoot, name)).map((child) => `${name}/${child}`)
      : [name])
    .sort()
}

/**
 * Read a package's manifest off disk, walking `modulesDir` up from `fromDir`.
 *
 * Deliberately NOT `require.resolve('<name>/package.json')`: most of these
 * packages omit `./package.json` from their `exports` map, so that throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED — and a try/catch around it reports an INSTALLED
 * package as absent, turning the whole audit into a silent no-op. Walking the
 * tree is exports-map-independent and mirrors Node's own resolution order, so
 * the version reported is the version that would actually load.
 *
 * The walk STOPS at the repository root — a directory containing `.git` — and
 * never climbs past it. Node itself would keep going, but a `node_modules`
 * above a checkout belongs to something else entirely, and letting it answer
 * silently changes the verdict: a stray `/tmp/node_modules` shadowing one
 * package produced a confident FAIL for a repo that was above every floor. A
 * check that reports the wrong tree is worse than no check.
 *
 * Returns null only when no directory for the package exists inside the repo,
 * which is the genuine not-installed case.
 */
function readInstalledManifest(
  name: string,
  fromDir: string,
  modulesDir: string,
): { version?: string; peerDependencies?: Record<string, string> } | null {
  let dir = fromDir
  for (;;) {
    const manifest = join(dir, modulesDir, name, 'package.json')
    if (existsSync(manifest)) {
      return JSON.parse(readFileSync(manifest, 'utf8')) as {
        version?: string
        peerDependencies?: Record<string, string>
      }
    }
    // Repo boundary: stop here rather than inheriting an unrelated tree.
    if (existsSync(join(dir, '.git'))) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Minimal range satisfaction for the ranges peer floors actually use:
 * `>=x <y`, `^x.y.z`, `~x.y.z`, `x.y.z`, and `*`/`x`.
 *
 * Hand-rolled rather than taking a `semver` dependency, because this package
 * ships zero runtime dependencies and a checker that forces one on every
 * consumer is a worse trade than 40 lines of comparison. Prerelease versions
 * compare by their release part — a floor is about the wire contract, and a
 * prerelease of a satisfying version speaks it.
 */
function parseVersion(version: string): [number, number, number] {
  const [core] = version.split(/[-+]/)
  const parts = (core ?? '').split('.').map((p) => Number.parseInt(p, 10))
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

function compare(a: string, b: string): number {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  for (let i = 0; i < 3; i += 1) {
    if (va[i]! !== vb[i]!) return va[i]! < vb[i]! ? -1 : 1
  }
  return 0
}

function satisfiesComparator(version: string, comparator: string): boolean {
  const trimmed = comparator.trim()
  if (!trimmed || trimmed === '*' || trimmed === 'x') return true
  const match = /^(>=|<=|>|<|=|\^|~)?\s*v?(.+)$/.exec(trimmed)
  if (!match) return false
  const [, op = '=', target = ''] = match
  const cmp = compare(version, target)
  switch (op) {
    case '>=': return cmp >= 0
    case '<=': return cmp <= 0
    case '>': return cmp > 0
    case '<': return cmp < 0
    case '=': return cmp === 0
    case '~': {
      // ~1.2.3 allows patch bumps; ~1.2 allows minor.
      const [major, minor] = parseVersion(target)
      const [vMajor, vMinor] = parseVersion(version)
      return cmp >= 0 && vMajor === major && vMinor === minor
    }
    case '^': {
      // A caret on a 0.x version is MINOR-locked: ^0.36.0 can never resolve to
      // 0.38.0. That is the single most common reason a floor cannot be met by
      // reinstalling, so it is modelled exactly rather than approximated.
      const [major, minor] = parseVersion(target)
      const [vMajor, vMinor] = parseVersion(version)
      if (cmp < 0) return false
      if (major > 0) return vMajor === major
      if (minor > 0) return vMajor === 0 && vMinor === minor
      return vMajor === 0 && vMinor === 0
    }
    default: return false
  }
}

export function satisfiesRange(version: string, range: string): boolean {
  // `||` is alternation; whitespace inside an alternative is conjunction.
  return range.split('||').some((alternative) =>
    alternative.trim().split(/\s+/).filter(Boolean).every((c) => satisfiesComparator(version, c)),
  )
}

/** Audit one app directory against the shell's declared peer floors. */
export function checkPeerFloors(options: CheckPeerFloorsOptions): PeerFloorReport {
  const {
    appDir,
    shell = '@tangle-network/agent-app',
    scope = '@tangle-network/',
    modulesDir = 'node_modules',
  } = options

  const shellManifest = options.shellManifest ?? readInstalledManifest(shell, appDir, modulesDir)
  if (!shellManifest) throw new Error(`${shell} is not installed under ${appDir}`)

  const appManifest = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
  }
  const declared = {
    ...appManifest.dependencies,
    ...appManifest.devDependencies,
    ...appManifest.optionalDependencies,
  }

  const floors = Object.entries(shellManifest.peerDependencies ?? {})
    .filter(([name]) => name.startsWith(scope))

  const rows = floors.map(([name, range]): PeerFloorRow => {
    const installed = readInstalledManifest(name, appDir, modulesDir)?.version ?? null
    if (installed === null) {
      return { name, range, installed, verdict: declared[name] ? 'absent-but-declared' : 'absent-unused' }
    }
    return {
      name,
      range,
      installed,
      verdict: satisfiesRange(installed, range) ? 'satisfied' : 'below-floor',
    }
  })

  const violations = rows.filter((row) => row.verdict === 'below-floor' || row.verdict === 'absent-but-declared')
  return {
    shell,
    shellVersion: shellManifest.version ?? 'unknown',
    rows,
    violations,
    ok: violations.length === 0,
  }
}

/** Audit every installed package in `scope` that constrains another package in
 * that scope. This is the complete stack check the CLI runs for consumers. */
export function checkAllPeerFloors(options: CheckAllPeerFloorsOptions): readonly PeerFloorReport[] {
  const {
    appDir,
    modulesDir = 'node_modules',
    scope = '@tangle-network/',
  } = options
  const normalizedScope = scope === '' ? '' : scope.endsWith('/') ? scope : `${scope}/`
  const shells = installedPackageNames(appDir, modulesDir, normalizedScope)
    .filter((name) => {
      const manifest = readInstalledManifest(name, appDir, modulesDir)
      return Object.keys(manifest?.peerDependencies ?? {})
        .some((peer) => peer.startsWith(normalizedScope))
    })

  if (shells.length === 0) {
    const label = normalizedScope || 'package'
    throw new Error(`no installed ${label} package declares a ${label} peer under ${appDir}`)
  }

  return shells.map((shell) => checkPeerFloors({
    appDir,
    modulesDir,
    scope: normalizedScope,
    shell,
  }))
}

/** The failure message for one violating row. Split out so a caller can raise
 *  it from a test and a CLI can print it identically. */
export function describePeerFloorViolation(row: PeerFloorRow, shellVersion: string, shell = '@tangle-network/agent-app'): string {
  if (row.verdict === 'below-floor') {
    return `PEER FLOOR VIOLATED: ${shell}@${shellVersion} requires ${row.name}@${row.range}, `
      + `but ${row.installed} is installed. A peer floor encodes a wire contract — bump the `
      + `dependency, do not widen the floor. A caret on a 0.x version is minor-locked `
      + `(^0.36.0 can never resolve to 0.38.0), so reinstalling alone will not fix this: `
      + `change the pin, in EVERY place it appears including pnpm.overrides.`
  }
  return `${row.name} is a declared dependency of this app, but no installed version could be `
    + `read, so its peer floor ${row.range} went UNCHECKED. Failing loudly rather than `
    + `reporting a pass this guard did not earn.`
}

export function formatPeerFloorReport(report: PeerFloorReport, shell = report.shell): string {
  const width = Math.max(...report.rows.map((r) => r.name.length), 4)
  const lines = [
    `${shell}@${report.shellVersion} — peer floors`,
    '',
    ...report.rows.map((row) =>
      `  ${row.verdict === 'satisfied' ? 'ok  ' : row.verdict.startsWith('absent') ? '--  ' : 'FAIL'} `
      + `${row.name.padEnd(width)}  installed ${(row.installed ?? '(none)').padEnd(10)} floor ${row.range}`),
    '',
    report.ok
      ? `all ${report.rows.length} floors satisfied`
      : report.violations.map((row) => describePeerFloorViolation(row, report.shellVersion, shell)).join('\n\n'),
  ]
  return lines.join('\n')
}
