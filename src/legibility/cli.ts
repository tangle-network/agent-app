#!/usr/bin/env node
/**
 * `agent-app-legibility-check` — fail a product's CI when a screen leaves its
 * reader guessing.
 *
 * Runs in the PRODUCT's repo, over the product's own source, next to typecheck:
 *
 *     "scripts": {
 *       "legibility": "agent-app-legibility-check --src src --routes src/routes.ts --nav src/components/workspace-sidebar.tsx"
 *     }
 *
 * Flags (repeatable where a list makes sense):
 *   --src <dir>          source directory to scan (required unless the config supplies it)
 *   --routes <file>      react-router route config, for the unreachable-capability check
 *   --nav <file>         a file whose path literals are navigation entries
 *   --ignore <substr>    skip paths containing this substring
 *   --skip <check>       turn one check off wholesale (prefer a per-line suppression)
 *   --config <file>      a legibility.config.mjs default-exporting the config
 *                        (default: ./legibility.config.mjs when present)
 *   --json               print the report as JSON instead of text
 *   --list-suppressions  print every honoured suppression with its reason
 *
 * Exit 0 with no findings, 1 with findings, 2 on a usage or config error — the
 * same contract as `agent-app-preflight` and `agent-app-peer-check`.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { DEFAULT_CONFIG_FILE, LegibilityUsageError, mergeConfig, parseArgs, USAGE } from './cli-args'
import { checkLegibility } from './index'
import { formatLegibilityReport, legibilityReportToJson } from './report'
import type { LegibilityConfig } from './types'

async function loadConfigFile(path: string | undefined): Promise<Partial<LegibilityConfig>> {
  const explicit = path !== undefined
  const resolved = resolve(process.cwd(), path ?? DEFAULT_CONFIG_FILE)
  if (!existsSync(resolved)) {
    if (explicit) throw new LegibilityUsageError(`no config at ${resolved}`)
    return {}
  }
  const module: unknown = await import(pathToFileURL(resolved).href)
  const exported = (module as { default?: unknown; config?: unknown }).default ?? (module as { config?: unknown }).config
  const value = typeof exported === 'function' ? await (exported as () => Promise<unknown>)() : exported
  if (value === null || typeof value !== 'object') {
    throw new LegibilityUsageError(`${resolved} must default-export a legibility config object`)
  }
  return value as Partial<LegibilityConfig>
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  const config = mergeConfig(await loadConfigFile(args.config), args)
  if (config.srcDirs.length === 0) {
    throw new LegibilityUsageError('at least one --src <dir> is required (or srcDirs in the config file)')
  }

  const report = checkLegibility(config)
  const text = args.json
    ? legibilityReportToJson(report)
    : formatLegibilityReport(report, { listSuppressions: args.listSuppressions })

  if (report.ok) process.stdout.write(`${text}\n`)
  else process.stderr.write(`${text}\n`)
  return report.ok ? 0 : 1
}

try {
  process.exit(await main())
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`agent-app-legibility-check: ${message}\n`)
  if (error instanceof LegibilityUsageError) process.stderr.write(`${USAGE}\n`)
  process.exit(2)
}
