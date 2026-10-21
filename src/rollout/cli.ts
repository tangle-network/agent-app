#!/usr/bin/env node
/**
 * `agent-app-rollout-check` — refuse a deploy that widens a staged rollout
 * before the stage it leaves met its kill lines.
 *
 * Runs in the app's repo, in the step that ships (ship.sh verify, or the PR
 * check). Add `rollout.config.mjs` at the root:
 *
 *     export default {
 *       plans: [{
 *         name: 'hospitality-routed-chat',
 *         variable: 'HOSPITALITY_ROUTED_BUSINESS_IDS',
 *         stages: [
 *           { name: 'qa', value: 'ws-a,ws-b', minSamples: 30,
 *             kill: { first_words_p50_ms: { max: 2500 }, failure_rate: { max: 0 } } },
 *           { name: 'all', value: '*', minSamples: 200,
 *             kill: { first_words_p50_ms: { max: 1500 }, failure_rate: { max: 0.01 } } },
 *         ],
 *       }],
 *       // The product's own instrument: production numbers for the stage being left.
 *       async measure({ plan, stage }) { return { stage: stage.name, samples, metrics: { … }, source } },
 *       // Optional: keep the decision somewhere durable as well as the JSONL ledger.
 *       async record(decision) {},
 *     }
 *
 * The new value is read from the `[vars]` of wrangler.toml; the current one
 * from the same file at `--base` (default `origin/main`), or given with
 * `--from`. `--to` overrides the new value.
 *
 * Usage: agent-app-rollout-check [appDir] [--config <file>] [--base <git ref>]
 *          [--from <value>] [--to <value>] [--plan <name>] [--record <jsonl>]
 * Exits 0 when allowed, 1 for a measured refusal, 3 for insufficient widening evidence, 2 on a usage error. Undecided holds exit 0.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { invokedAsScript } from '../signoff/invoked-as-script.js'
import { decideRollout, type RolloutDecision, type RolloutPlan, type RolloutStage, type StageMeasurement } from './index.js'

export interface RolloutConfig {
  plans: RolloutPlan[]
  measure(input: { plan: RolloutPlan; stage: RolloutStage; signal?: AbortSignal }): Promise<StageMeasurement | null>
  /** Shared observation deadline; see decideRollout. */
  measurementTimeoutMs?: number
  record?(decision: RolloutDecision): Promise<void> | void
  /** Default `wrangler.toml`. */
  wrangler?: string
}

interface CliArgs {
  appDir: string
  config?: string
  base: string
  from?: string
  to?: string
  plan?: string
  record: string
}

const CONFIG_NAMES = ['rollout.config.mjs', 'rollout.config.js']

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { appDir: process.cwd(), base: 'origin/main', record: '.rollout/decisions.jsonl' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    const value = () => {
      const next = argv[++index]
      if (next === undefined) throw new Error(`${arg} needs a value`)
      return next
    }
    if (arg === '--config') args.config = value()
    else if (arg === '--base') args.base = value()
    else if (arg === '--from') args.from = value()
    else if (arg === '--to') args.to = value()
    else if (arg === '--plan') args.plan = value()
    else if (arg === '--record') args.record = value()
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
    else args.appDir = resolve(arg)
  }
  return args
}

/** A top-level `[vars]` string value from wrangler.toml source; environments are not read. */
export function readWranglerVar(source: string, name: string): string | null {
  let inVars = false
  for (const line of source.split('\n')) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/)
    if (header) {
      inVars = header[1]!.trim() === 'vars'
      continue
    }
    if (!inVars) continue
    const entry = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"/)
    if (entry && entry[1] === name) return JSON.parse(`"${entry[2]}"`) as string
  }
  return null
}

async function loadConfig(appDir: string, explicit?: string): Promise<RolloutConfig> {
  const file = explicit ? resolve(appDir, explicit) : CONFIG_NAMES.map(name => join(appDir, name)).find(path => existsSync(path))
  if (!file || !existsSync(file)) throw new Error(`no ${CONFIG_NAMES[0]} in ${appDir}`)
  const config = ((await import(pathToFileURL(file).href)) as { default: RolloutConfig }).default
  if (!Array.isArray(config?.plans) || typeof config.measure !== 'function') {
    throw new Error(`${file} must export { plans, measure }`)
  }
  return config
}

function gitShow(cwd: string, spec: string): string | null {
  try {
    return execFileSync('git', ['show', spec], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return null
  }
}

/**
 * The file at `ref`. Under agent-app-signoff the app runs in a clean copy with
 * no `.git`; signoff names the source checkout and the copy's root, so the
 * base is read from the source at the same repo-relative path.
 */
function wranglerAt(appDir: string, file: string, ref: string, env: NodeJS.ProcessEnv = process.env): string {
  const local = gitShow(appDir, `${ref}:./${file}`)
  if (local !== null) return local
  const source = env.SIGNOFF_SOURCE_REPO
  const tree = env.SIGNOFF_TREE
  if (source && tree) {
    const path = relative(resolve(tree), resolve(appDir, file))
    if (!path.startsWith('..') && !isAbsolute(path)) {
      const fromSource = gitShow(source, `${ref}:${path.split(sep).join('/')}`)
      if (fromSource !== null) return fromSource
    }
  }
  throw new Error(`cannot read ${file} at ${ref}; fetch it or pass --from`)
}

export async function runRolloutCheck(args: CliArgs): Promise<RolloutDecision[]> {
  const config = await loadConfig(args.appDir, args.config)
  const file = config.wrangler ?? 'wrangler.toml'
  const plans = args.plan ? config.plans.filter(plan => plan.name === args.plan) : config.plans
  if (!plans.length) throw new Error(args.plan ? `no plan named ${args.plan}` : 'the config declares no plans')
  if (plans.length > 1 && (args.from !== undefined || args.to !== undefined)) throw new Error('--from and --to need --plan')
  const head = readFileSync(join(args.appDir, file), 'utf8')
  const base = args.from === undefined ? wranglerAt(args.appDir, file, args.base) : null
  const decisions: RolloutDecision[] = []
  for (const plan of plans) {
    const fromValue = args.from ?? readWranglerVar(base!, plan.variable) ?? ''
    const toValue = args.to ?? readWranglerVar(head, plan.variable) ?? ''
    const decision = await decideRollout({
      plan, fromValue, toValue,
      measure: (stage, signal) => config.measure({ plan, stage, signal }),
      measurementTimeoutMs: config.measurementTimeoutMs,
    })
    decisions.push(decision)
    const ledger = resolve(args.appDir, args.record)
    mkdirSync(dirname(ledger), { recursive: true })
    appendFileSync(ledger, `${JSON.stringify(decision)}\n`)
    await config.record?.(decision)
  }
  return decisions
}

function describe(decision: RolloutDecision): string {
  const move = `${decision.from.stage ?? decision.from.value ?? '(empty)'} -> ${decision.to.stage ?? decision.to.value}`
  if (decision.decision === 'allowed') {
    return `rollout ${decision.rollout}: allowed ${move}${decision.widens ? '' : ' (not a widening)'}`
  }
  return `rollout ${decision.rollout}: ${decision.decision.toUpperCase()} ${move} (${decision.recommendation})\n${decision.reasons.map(reason => `  - ${reason}`).join('\n')}`
}

async function main(): Promise<number> {
  let args: CliArgs
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }
  try {
    const decisions = await runRolloutCheck(args)
    for (const decision of decisions) console.log(describe(decision))
    return decisions.some(decision => decision.decision === 'refused') ? 1 : decisions.some(decision => decision.decision === 'undecided' && decision.widens) ? 3 : 0
  } catch (error) {
    console.error(`agent-app-rollout-check: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}

if (invokedAsScript(import.meta.url, process.argv[1])) {
  // A timed-out product instrument can leave an uncooperative socket open.
  // All durable records are awaited by main; flush the receipt before ending the CLI.
  main().then(code => {
    process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))
  })
}
