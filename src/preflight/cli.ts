#!/usr/bin/env node
/**
 * `agent-app-preflight` — the deploy-time probe runner.
 *
 * Loads a product's `preflight.config.mjs` (default export: `PreflightProbe[]`),
 * runs every probe, prints the operator table, and exits non-zero when a
 * critical probe fails so a deploy step can gate on it.
 *
 * Run it where the REAL secrets are — after `wrangler secret put …`, not in CI.
 * CI has no secrets, so a probe there proves nothing.
 *
 *   agent-app-preflight                    # ./preflight.config.mjs
 *   agent-app-preflight ops/probes.mjs     # explicit path
 *
 * This bin existed only as a promise in the module docs until 0.44.0; at least
 * one product had hand-rolled a byte-identical `scripts/preflight.mjs` around
 * `runPreflight` + `formatPreflightReport` to fill the gap.
 */
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { formatPreflightReport, runPreflight, type PreflightProbe } from './index'
import { invokedAsScript } from '../signoff/invoked-as-script'

const DEFAULT_CONFIG = 'preflight.config.mjs'

/**
 * Load the probe list from a config module. Fail loud on every miss — a
 * preflight that silently probes nothing and exits 0 is worse than no
 * preflight, because it reports the deploy as verified.
 */
export async function loadProbes(configPath: string): Promise<PreflightProbe[]> {
  const abs = resolve(process.cwd(), configPath)
  if (!existsSync(abs)) {
    throw new Error(
      `agent-app-preflight: no config at "${abs}". Create one that default-exports a PreflightProbe[], or pass a path.`,
    )
  }
  const mod: unknown = await import(pathToFileURL(abs).href)
  const probes = (mod as { default?: unknown }).default
  if (!Array.isArray(probes)) {
    throw new Error(
      `agent-app-preflight: "${abs}" must default-export an array of probes; got ${typeof probes}.`,
    )
  }
  if (probes.length === 0) {
    throw new Error(`agent-app-preflight: "${abs}" exported an empty probe list — nothing would be verified.`)
  }
  return probes as PreflightProbe[]
}

/** Run the probes named by `argv` and resolve with the process exit code. */
export async function runPreflightCli(argv: readonly string[]): Promise<number> {
  const probes = await loadProbes(argv[0] ?? DEFAULT_CONFIG)
  const report = await runPreflight(probes)
  console.log(formatPreflightReport(report))
  return report.ok ? 0 : 1
}

/* c8 ignore start — process wiring, exercised by the bin itself */
if (invokedAsScript(import.meta.url, process.argv[1])) {
  runPreflightCli(process.argv.slice(2))
    .then((code) => {
      process.exit(code)
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    })
}
/* c8 ignore stop */
