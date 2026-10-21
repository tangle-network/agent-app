#!/usr/bin/env node
/**
 * `agent-app-peer-check` — fail a consumer's CI when its dependencies are wrong
 * through installed compatibility, source, and declared-version checks.
 *
 * Runs in the CONSUMER's repo, over the consumer's own tree, because both
 * installed checks only mean anything against a real install. Add it next to
 * typecheck:
 *
 *     "scripts": { "peer-check": "agent-app-peer-check" }
 *
 * Four gates, one report, one exit code:
 *
 *   PEER FLOORS      — is the installed version inside the range the shell
 *                      declares. `pnpm` only WARNS on an unmet peer that is
 *                      also a direct dependency and says nothing at all for an
 *                      unmet optional one.
 *   DEPENDENCY SOURCE — is the installed package the one the registry
 *                      publishes at all. A `file:` tarball, a `link:` out of
 *                      the repo, or a hand-patched `node_modules` all report
 *                      the same version as the real release and ship different
 *                      bytes.
 *   DECLARED PINS   — do installed exact Tangle versions match the consumer's
 *                     dependency and development dependency declarations.
 *   DURABILITY OWNERS — does product source write the shared turn tables,
 *                     open its own session-event replay, or mint follow-up
 *                     execution ids that Agent App already owns.
 *
 * The source gate runs FIRST and independently: it needs no installed shell, so
 * a repo whose install is broken still gets the answer that explains why.
 *
 * Usage: agent-app-peer-check [repoDir] [--exclude <path>]... [--sync-floors]
 * `--exclude` takes a repo-relative path prefix the source-tree walk skips —
 * the escape hatch for a repo that genuinely carries a tarball as test data.
 * Exits 1 on any violation, 0 otherwise.
 *
 * `--sync-floors` runs none of the gates. It recomputes the repo's OWN Tangle
 * peer floors after an adoption moved their exact `devDependencies` pins, and is
 * what `pnpm run adopt:sync` calls after agent-eval's adopt-stack pins a cohort.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkAllPeerFloors, checkPeerFloors, formatPeerFloorReport, satisfiesRange } from './check'
import { checkDependencySources, formatDependencySourceReport } from './dependency-source'
import { checkDurabilityOwners, formatDurabilityOwnerReport } from './durability-owners'
import { invokedAsScript } from '../signoff/invoked-as-script'

interface CliArgs {
  readonly appDir: string
  readonly exclude: readonly string[]
  readonly syncFloors: boolean
}

interface OwnManifest {
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/

/**
 * Recompute the Tangle peer floors in `appDir/package.json` for every package
 * whose exact `devDependencies` pin differs from the committed one (the git
 * index), and return one line per floor changed.
 *
 * A floor admits only versions this package was tested on. A committed floor
 * that already admits the new pin is kept as committed. Otherwise the floor
 * gains one window for the pin's own line, `>=pin <0.(m+1).0` on 0.x and
 * `^pin` past 1.0, and nothing between. That undoes agent-eval's `widenRange`,
 * which stretches the last window's upper bound and so admits every
 * intermediate minor, e.g. Materialize `>=0.25.2 <0.26.0` became
 * `>=0.25.2 <0.28.0`, claiming the never-tested 0.26.
 *
 * Floors of packages whose pin did not move are left as written, so a
 * hand-edited floor survives. Rerunning on the result changes nothing.
 */
function syncOwnPeerFloors(appDir: string): string[] {
  const path = join(appDir, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as OwnManifest
  // The index holds the manifest before the adoption: adopt-stack writes the
  // pins into a clean checkout and commits only after this runs.
  const index = spawnSync('git', ['show', ':./package.json'], { cwd: appDir, encoding: 'utf8' })
  if (index.status !== 0) throw new Error(`--sync-floors reads the committed package.json from the git index: ${index.stderr.trim() || index.error?.message}`)
  const committed = JSON.parse(index.stdout) as OwnManifest

  const changes: string[] = []
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    const pin = manifest.devDependencies?.[name]
    const floor = committed.peerDependencies?.[name]
    const release = RELEASE.exec(pin ?? '')
    if (!name.startsWith('@tangle-network/') || !pin || !release || !floor || pin === committed.devDependencies?.[name]) continue
    const [, major, minor] = release
    const window = major === '0' ? `>=${pin} <0.${Number(minor) + 1}.0` : `^${pin}`
    const next = satisfiesRange(pin, floor) ? floor : `${floor} || ${window}`
    if (next === range) continue
    manifest.peerDependencies![name] = next
    changes.push(`package.json peerDependencies ${name}: ${range} -> ${next}`)
  }
  if (changes.length) writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  return changes
}

/** Exact consumer pins choose an artifact; engine peer ranges choose compatibility. */
function checkDeclaredPins(appDir: string): boolean {
  const manifest = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const pins = Object.fromEntries(
    Object.entries({ ...manifest.devDependencies, ...manifest.dependencies })
      .filter(([name, version]) => name.startsWith('@tangle-network/')
        && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)),
  )
  const report = checkPeerFloors({ appDir, shellManifest: { peerDependencies: pins } })
  const installed = report.rows.filter((row) => row.installed !== null)
  const mismatches = installed.filter((row) => row.installed !== row.range)
  for (const row of mismatches) {
    process.stderr.write(`DECLARED PIN VIOLATED: ${row.name} declares ${row.range}, but ${row.installed} is installed. Reinstall from the current frozen lockfile.\n`)
  }
  if (mismatches.length === 0) {
    process.stdout.write(`declared pins: ${installed.length} installed exact Tangle versions matched\n`)
  }
  return mismatches.length === 0
}

export function parsePeerCheckArgs(argv: readonly string[]): CliArgs {
  const exclude: string[] = []
  let appDir: string | undefined
  let syncFloors = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string
    if (arg === '--sync-floors') {
      syncFloors = true
    } else if (arg === '--exclude') {
      const value = argv[i + 1]
      if (value) exclude.push(value)
      i += 1
    } else if (arg.startsWith('--exclude=')) {
      exclude.push(arg.slice('--exclude='.length))
    } else if (!arg.startsWith('-') && appDir === undefined) {
      appDir = arg
    }
  }
  return { appDir: appDir ?? process.cwd(), exclude, syncFloors }
}

function main(): void {
  const { appDir, exclude, syncFloors } = parsePeerCheckArgs(process.argv.slice(2))
  if (syncFloors) {
    try {
      for (const change of syncOwnPeerFloors(appDir)) process.stdout.write(`${change}\n`)
      process.exit(0)
    } catch (err) {
      process.stderr.write(`agent-app-peer-check --sync-floors failed: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    }
  }
  let failed = false

  try {
    const sources = checkDependencySources({ repoDir: appDir, exclude })
    process.stdout.write(`${formatDependencySourceReport(sources)}\n\n`)
    if (!sources.ok) failed = true
  } catch (err) {
    process.stderr.write(`agent-app-peer-check (dependency sources) failed: ${err instanceof Error ? err.message : String(err)}\n`)
    failed = true
  }

  try {
    const reports = checkAllPeerFloors({ appDir })
    process.stdout.write(`${reports.map((report) => formatPeerFloorReport(report)).join('\n\n')}\n`)
    if (reports.some((report) => !report.ok)) failed = true
  } catch (err) {
    process.stderr.write(`agent-app-peer-check (peer floors) failed: ${err instanceof Error ? err.message : String(err)}\n`)
    failed = true
  }

  try {
    if (!checkDeclaredPins(appDir)) failed = true
  } catch (err) {
    process.stderr.write(`agent-app-peer-check (declared pins) failed: ${err instanceof Error ? err.message : String(err)}\n`)
    failed = true
  }

  try {
    const durability = checkDurabilityOwners({ repoDir: appDir, exclude })
    const report = formatDurabilityOwnerReport(durability)
    if (durability.ok) process.stdout.write(`${report}\n`)
    else {
      process.stderr.write(`${report}\n`)
      failed = true
    }
  } catch (err) {
    process.stderr.write(`agent-app-peer-check (durability owners) failed: ${err instanceof Error ? err.message : String(err)}\n`)
    failed = true
  }

  process.exit(failed ? 1 : 0)
}

/* c8 ignore start — process wiring, exercised by the bin itself */
if (invokedAsScript(import.meta.url, process.argv[1])) main()
/* c8 ignore stop */
