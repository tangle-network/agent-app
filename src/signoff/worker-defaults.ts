import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'

/**
 * The Cloudflare defaults every agent-app Worker ships with, checked against
 * the Worker's own Wrangler config.
 *
 * Why these keys:
 *  - `observability` with logs and traces at a 1.0 sampling rate. Workers Logs
 *    and traces are what a production incident is read from; a 0.1 sample
 *    dropped nine of ten failing chat turns in exactly the apps whose traffic is
 *    small enough to afford 1.0. Traces are explicit because
 *    `observability.enabled` turns on logs only while tracing is in beta.
 *  - `upload_source_maps`, so exceptions in Workers Logs and on-demand CPU and
 *    memory profiles name source functions instead of minified bundle offsets.
 *  - `nodejs_compat` and a compatibility date no older than the one the
 *    templates ship, so a Worker does not run years-old runtime semantics.
 *
 * Smart placement is deliberately absent: these Workers stream long model turns
 * from a sandbox and serve assets next to the user, and the measured comparison
 * is in docs/worker-defaults.md.
 *
 * The values are read through the app's own installed `wrangler`, so the check
 * sees the config exactly as `wrangler deploy` resolves it, including the keys
 * each `[env.*]` inherits or overrides.
 */

/** Update together with the templates' `compatibility_date`. */
export const WORKER_COMPATIBILITY_DATE_FLOOR = '2026-09-23'

const WRANGLER_CONFIG_NAMES = new Set(['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'])

interface SamplingSettings {
  readonly enabled?: boolean
  readonly head_sampling_rate?: number
  readonly invocation_logs?: boolean
}

interface ResolvedWorkerConfig {
  readonly name?: string
  readonly compatibility_date?: string
  readonly compatibility_flags?: readonly string[]
  readonly upload_source_maps?: boolean
  readonly observability?: SamplingSettings & {
    readonly logs?: SamplingSettings
    readonly traces?: SamplingSettings
  }
}

interface WranglerConfigApi {
  unstable_readConfig(args: { config: string; env?: string }): ResolvedWorkerConfig
  experimental_readRawConfig(args: { config: string }): { rawConfig: { env?: Record<string, unknown> } }
}

export interface WorkerDefaultsFinding {
  /** Config path relative to the repo root. */
  readonly config: string
  /** `null` for the top-level Worker, otherwise the `[env.<name>]` it deploys. */
  readonly env: string | null
  readonly problem: string
}

export interface WorkerDefaultsResult {
  readonly checked: readonly { readonly config: string; readonly envs: readonly (string | null)[] }[]
  readonly findings: readonly WorkerDefaultsFinding[]
}

/**
 * Wrangler configs the repo tracks. Generated output (`.wrangler/`, build
 * directories) is gitignored, so `git ls-files` is the complete source list
 * without a hand-kept exclude list.
 */
export function trackedWorkerConfigs(repoRoot: string): string[] {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
  if (listed.status !== 0) throw new Error(`signoff: git ls-files failed in ${repoRoot}: ${listed.stderr}`)
  return listed.stdout
    .split('\0')
    .filter((path) => path !== '' && WRANGLER_CONFIG_NAMES.has(basename(path)))
    .sort()
}

function problemsFor(config: ResolvedWorkerConfig): string[] {
  const problems: string[] = []
  const observability = config.observability
  const isFullSample = (settings: SamplingSettings | undefined): boolean => (settings?.head_sampling_rate ?? 1) === 1

  if (observability?.enabled !== true) problems.push('observability.enabled must be true')
  if (!isFullSample(observability)) {
    problems.push(`observability.head_sampling_rate must be 1 (is ${observability?.head_sampling_rate})`)
  }
  if (observability?.logs?.enabled === false) problems.push('observability.logs.enabled must not be false')
  if (!isFullSample(observability?.logs)) {
    problems.push(`observability.logs.head_sampling_rate must be 1 (is ${observability?.logs?.head_sampling_rate})`)
  }
  if (observability?.logs?.invocation_logs === false) {
    problems.push('observability.logs.invocation_logs must not be false')
  }
  if (observability?.traces?.enabled !== true) problems.push('observability.traces.enabled must be true')
  if (!isFullSample(observability?.traces)) {
    problems.push(`observability.traces.head_sampling_rate must be 1 (is ${observability?.traces?.head_sampling_rate})`)
  }
  if (config.upload_source_maps !== true) problems.push('upload_source_maps must be true')
  if (!config.compatibility_flags?.includes('nodejs_compat')) {
    problems.push('compatibility_flags must include "nodejs_compat"')
  }
  const date = config.compatibility_date
  if (date === undefined || date < WORKER_COMPATIBILITY_DATE_FLOOR) {
    problems.push(`compatibility_date must be ${WORKER_COMPATIBILITY_DATE_FLOOR} or later (is ${date ?? 'unset'})`)
  }
  return problems
}

/**
 * Wrangler logs config warnings (unknown keys, missing secrets) to the console
 * while reading. They belong to the app's own `wrangler deploy`, not to this
 * verdict, so they are muted for the duration of the read.
 */
function quietly<T>(read: () => T): T {
  const previous = process.env.WRANGLER_LOG
  process.env.WRANGLER_LOG = 'error'
  try {
    return read()
  } finally {
    if (previous === undefined) delete process.env.WRANGLER_LOG
    else process.env.WRANGLER_LOG = previous
  }
}

function loadWrangler(configDir: string): WranglerConfigApi | null {
  try {
    return createRequire(join(configDir, 'package.json'))('wrangler') as WranglerConfigApi
  } catch {
    return null
  }
}

/**
 * Check each Worker config, and every environment it deploys, against the
 * defaults. `configs` are repo-relative paths; omit them to check every tracked
 * Wrangler config.
 */
export function checkWorkerDefaults(repoRoot: string, configs?: readonly string[]): WorkerDefaultsResult {
  const findings: WorkerDefaultsFinding[] = []
  const checked: { config: string; envs: (string | null)[] }[] = []

  for (const config of configs ?? trackedWorkerConfigs(repoRoot)) {
    const path = join(repoRoot, config)
    if (!existsSync(path)) {
      findings.push({ config, env: null, problem: 'declared Worker config does not exist' })
      continue
    }
    const wrangler = loadWrangler(dirname(path))
    if (!wrangler) {
      findings.push({ config, env: null, problem: 'wrangler is not installed where this config can resolve it' })
      continue
    }
    const envNames = Object.keys(quietly(() => wrangler.experimental_readRawConfig({ config: path })).rawConfig.env ?? {})
    const envs: (string | null)[] = [null, ...envNames]
    checked.push({ config, envs })
    for (const env of envs) {
      const resolved = quietly(() => wrangler.unstable_readConfig({ config: path, ...(env ? { env } : {}) }))
      for (const problem of problemsFor(resolved)) findings.push({ config, env, problem })
    }
  }
  return { checked, findings }
}

export function formatWorkerDefaults(result: WorkerDefaultsResult): string {
  if (result.checked.length === 0 && result.findings.length === 0) return 'no Wrangler config tracked; nothing to check\n'
  const lines = result.checked.map(
    ({ config, envs }) => `checked ${config} (${envs.map((env) => env ?? 'top level').join(', ')})`,
  )
  for (const finding of result.findings) {
    lines.push(`FAIL ${finding.config}${finding.env ? ` [env.${finding.env}]` : ''}: ${finding.problem}`)
  }
  if (result.findings.length > 0) lines.push('Required keys: https://github.com/tangle-network/agent-app/blob/main/docs/worker-defaults.md')
  return `${lines.join('\n')}\n`
}
