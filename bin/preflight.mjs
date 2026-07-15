#!/usr/bin/env node
/**
 * `agent-app-preflight` — run a product's declared secret-liveness probes as a
 * DEPLOY step and fail the deploy if any critical secret is dead.
 *
 * Reads `preflight.config.mjs` from the current working directory (override
 * with `PREFLIGHT_CONFIG`). That file default-exports the probes, built from
 * `process.env` at load time — the deploy already has the real secrets in its
 * environment, which is the one place they can be probed for liveness (CI
 * cannot hold them). Exit 0 when every critical probe is live, 1 when one is
 * dead (deploy fails), 2 on a config/usage error.
 *
 * Wire it as a step BEFORE `wrangler deploy`:
 *   agent-app-preflight
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { formatPreflightReport, runPreflight } from '../dist/preflight/index.js'

const configFile = process.env.PREFLIGHT_CONFIG ?? 'preflight.config.mjs'

async function loadProbes() {
  const path = resolve(process.cwd(), configFile)
  if (!existsSync(path)) {
    console.error(`preflight: no config at ${path}`)
    console.error(
      `Create ${configFile} default-exporting probes built from process.env — see '@tangle-network/agent-app/preflight'.`,
    )
    process.exit(2)
  }
  const mod = await import(pathToFileURL(path).href)
  const exported = mod.default ?? mod.probes
  const resolved = typeof exported === 'function' ? await exported() : exported
  const probes = Array.isArray(resolved) ? resolved : resolved?.probes
  if (!Array.isArray(probes) || probes.length === 0) {
    console.error(`preflight: ${configFile} must default-export a non-empty array of probes (or { probes }).`)
    process.exit(2)
  }
  return probes
}

const probes = await loadProbes()
const report = await runPreflight(probes)
console.log(formatPreflightReport(report))
process.exit(report.ok ? 0 : 1)
