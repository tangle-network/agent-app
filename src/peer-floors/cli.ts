#!/usr/bin/env node
/**
 * `agent-app-peer-check` — fail a consumer's CI when its dependencies are wrong
 * in either of the two ways a version number cannot show.
 *
 * Runs in the CONSUMER's repo, over the consumer's own tree, because both
 * questions only mean anything against a real install. Add it next to
 * typecheck:
 *
 *     "scripts": { "peer-check": "agent-app-peer-check" }
 *
 * Two gates, one report, one exit code:
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
 *
 * The source gate runs FIRST and independently: it needs no installed shell, so
 * a repo whose install is broken still gets the answer that explains why.
 *
 * Usage: agent-app-peer-check [repoDir] [--exclude <path>]...
 * `--exclude` takes a repo-relative path prefix the source-tree walk skips —
 * the escape hatch for a repo that genuinely carries a tarball as test data.
 * Exits 1 on any violation, 0 otherwise.
 */
import { checkAllPeerFloors, formatPeerFloorReport } from './check'
import { checkDependencySources, formatDependencySourceReport } from './dependency-source'
import { invokedAsScript } from '../signoff/invoked-as-script'

interface CliArgs {
  readonly appDir: string
  readonly exclude: readonly string[]
}

export function parsePeerCheckArgs(argv: readonly string[]): CliArgs {
  const exclude: string[] = []
  let appDir: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string
    if (arg === '--exclude') {
      const value = argv[i + 1]
      if (value) exclude.push(value)
      i += 1
    } else if (arg.startsWith('--exclude=')) {
      exclude.push(arg.slice('--exclude='.length))
    } else if (!arg.startsWith('-') && appDir === undefined) {
      appDir = arg
    }
  }
  return { appDir: appDir ?? process.cwd(), exclude }
}

function main(): void {
  const { appDir, exclude } = parsePeerCheckArgs(process.argv.slice(2))
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

  process.exit(failed ? 1 : 0)
}

/* c8 ignore start — process wiring, exercised by the bin itself */
if (invokedAsScript(import.meta.url, process.argv[1])) main()
/* c8 ignore stop */
