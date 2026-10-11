#!/usr/bin/env node
/**
 * `agent-app-invariants` — report which launch invariants an app holds, and
 * fail its CI when one does not.
 *
 * Runs in the app's repo. Add a `launch-invariants.config.mjs` at the root:
 *
 *     export default {
 *       product: 'gtm',
 *       test: 'pnpm exec vitest run tests/launch-invariants.test.ts',
 *     }
 *
 * and a script next to typecheck:
 *
 *     "scripts": { "invariants": "agent-app-invariants" }
 *
 * Usage: agent-app-invariants [appDir] [--config <file>] [--json <out>]
 * Exits 0 when every invariant holds, 1 when one does not, 2 on a usage error.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { invokedAsScript } from '../signoff/invoked-as-script.js'
import {
  buildConformanceReport,
  formatConformanceReport,
  readDeploymentFacts,
  readVerdicts,
  type ConformanceReport,
  type LaunchInvariantsConfig,
} from './conformance.js'
import { INVARIANT_RESULTS_ENV } from './testing.js'

const CONFIG_NAMES = ['launch-invariants.config.mjs', 'launch-invariants.config.js', 'launch-invariants.config.json']

interface CliArgs {
  appDir: string
  config?: string
  json?: string
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { appDir: process.cwd() }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--config') args.config = argv[++index]
    else if (arg === '--json') args.json = argv[++index]
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
    else args.appDir = resolve(arg)
  }
  return args
}

async function loadConfig(appDir: string, explicit?: string): Promise<LaunchInvariantsConfig> {
  const file = explicit ? resolve(appDir, explicit) : CONFIG_NAMES.map((name) => join(appDir, name)).find((path) => existsSync(path))
  if (!file || !existsSync(file)) throw new Error(`no ${CONFIG_NAMES[0]} in ${appDir}`)
  const config = file.endsWith('.json')
    ? JSON.parse(readFileSync(file, 'utf8')) as LaunchInvariantsConfig
    : ((await import(pathToFileURL(file).href)) as { default: LaunchInvariantsConfig }).default
  if (!config?.product || !config.test) throw new Error(`${file} must export { product, test }`)
  return config
}

/** Run the app's invariant tests and judge the result. */
export async function runConformance(args: CliArgs): Promise<ConformanceReport> {
  const config = await loadConfig(args.appDir, args.config)
  const facts = readDeploymentFacts(args.appDir, config.wrangler)
  const dir = mkdtempSync(join(tmpdir(), 'agent-app-invariants-'))
  const results = join(dir, 'verdicts.jsonl')
  writeFileSync(results, '')
  try {
    const run = spawnSync(config.test, {
      cwd: args.appDir,
      shell: true,
      stdio: 'inherit',
      env: { ...process.env, [INVARIANT_RESULTS_ENV]: results },
    })
    return buildConformanceReport({
      config,
      facts,
      verdicts: readVerdicts(readFileSync(results, 'utf8')),
      testExitCode: run.status,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function main(): Promise<number> {
  let args: CliArgs
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }
  let report: ConformanceReport
  try {
    report = await runConformance(args)
  } catch (error) {
    console.error(`agent-app-invariants: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  console.log(formatConformanceReport(report))
  if (args.json) writeFileSync(resolve(args.appDir, args.json), `${JSON.stringify(report, null, 2)}\n`)
  return report.pass ? 0 : 1
}

if (invokedAsScript(import.meta.url, process.argv[1])) {
  void main().then((code) => process.exit(code))
}
