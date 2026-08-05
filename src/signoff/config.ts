import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { LoadedSignoffConfig, SignoffConfig, SignoffStepSpec } from './types'

/**
 * Where the step list comes from.
 *
 * It is declared by the repo, never hardcoded here, because the three workflows
 * this has to reproduce do not share a shape: tax-agent filters its install to
 * one workspace package and runs a Python toolkit suite; legal-agent runs a
 * react-router typegen and a Worker startup check; agent-app runs a named
 * incident-class gate, a generated-project test and knip. A checker that
 * hardcodes any one of those is wrong for the other two.
 *
 * Three sources, in order:
 *  1. `signoff.config.mjs` (or `.js`) — the full surface, including per-step
 *     `env`, `needs` and shuffle specs.
 *  2. a `signoff` key in `package.json` — the same shape, JSON-only.
 *  3. derived from the repo's own `scripts`, so a repo gets a real gate before
 *     anyone writes a config. The derivation is documented below and its origin
 *     is stamped into the proof, because a derived run is a weaker claim than a
 *     declared one.
 */

export const SIGNOFF_CONFIG_FILES: readonly string[] = ['signoff.config.mjs', 'signoff.config.js']

const shuffleSchema = z.object({
  runs: z.number().int().positive().optional(),
  seeds: z.array(z.number().int()).optional(),
  args: z.array(z.string()).optional(),
})

const stepSchema = z.object({
  name: z.string().min(1),
  run: z.string().min(1),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  needs: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  shuffle: z.union([z.boolean(), shuffleSchema]).optional(),
})

const configSchema = z.object({
  install: z
    .object({
      run: z.string().min(1).optional(),
      storeDirFlag: z.string().nullable().optional(),
      storeEnv: z.string().nullable().optional(),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().positive().optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  steps: z.array(stepSchema).min(1),
  maxParallel: z.number().int().positive().optional(),
  env: z.record(z.string(), z.string()).optional(),
  nodeVersion: z.string().min(1).optional(),
  carryFiles: z.array(z.string()).optional(),
  cacheDir: z.string().optional(),
  storeGenerations: z.number().int().positive().optional(),
})

function describeIssues(error: z.ZodError, where: string): string {
  const lines = error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
  return `signoff: ${where} is not a valid config:\n${lines.join('\n')}`
}

export function parseSignoffConfig(value: unknown, where: string): SignoffConfig {
  const result = configSchema.safeParse(value)
  if (!result.success) throw new Error(describeIssues(result.error, where))
  return result.data as SignoffConfig
}

/**
 * The script → step derivation, and the dependency edges it asserts.
 *
 * The edges are the speed lever, so each one is a claim about the repo:
 * typecheck, the suite, the build and knip are ASSUMED to read source and not
 * each other's output, so they run concurrently. Only `test:generated`
 * genuinely consumes a build artifact, so only it declares a dependency.
 *
 * **That assumption is a guess, and it is wrong for at least one real repo.**
 * agent-app's own suite copies `dist/` into a generated project while `tsup`
 * (`clean: true`) is deleting it, which fails loudly as "dist/ not built" and
 * quietly as a half-copied package. A repo whose suite reads build output MUST
 * declare `needs: ['build']` on it in a `signoff.config.mjs`; the derivation
 * cannot see that from a script name, which is one more reason a derived run is
 * a weaker claim than a declared one.
 *
 * `build:check` supersedes `build` when both exist (legal-agent's `build:check`
 * is `pnpm build && …`, so running both builds twice for one verdict).
 */
const DERIVED_STEPS: readonly {
  readonly script: string
  readonly name: string
  readonly shuffle?: boolean
  readonly supersedes?: string
  readonly needsBuild?: boolean
}[] = [
  { script: 'peer-check', name: 'peer floors' },
  { script: 'typecheck', name: 'typecheck' },
  { script: 'test:gates', name: 'incident-class gates' },
  { script: 'test', name: 'unit tests', shuffle: true },
  { script: 'build', name: 'build' },
  { script: 'build:check', name: 'build + worker checks', supersedes: 'build' },
  { script: 'test:generated', name: 'generated projects', needsBuild: true },
  { script: 'knip', name: 'dead-surface (knip)' },
]

export function deriveSignoffConfig(scripts: Readonly<Record<string, string>>): {
  readonly config: SignoffConfig
  readonly used: readonly string[]
} {
  const present = DERIVED_STEPS.filter((candidate) => scripts[candidate.script] !== undefined)
  const superseded = new Set(present.map((candidate) => candidate.supersedes).filter((name): name is string => !!name))
  const kept = present.filter((candidate) => !superseded.has(candidate.script))
  const buildStep = kept.find((candidate) => candidate.script === 'build' || candidate.script === 'build:check')

  const steps: SignoffStepSpec[] = kept.map((candidate) => ({
    name: candidate.name,
    run: `pnpm run ${candidate.script}`,
    ...(candidate.shuffle ? { shuffle: true as const } : {}),
    ...(candidate.needsBuild && buildStep ? { needs: [buildStep.name] } : {}),
  }))

  if (steps.length === 0) {
    throw new Error(
      'signoff: no config and no recognizable scripts. Add a `signoff.config.mjs` naming the steps ' +
        `this repo's CI runs, or a package.json "signoff" key. Recognized script names: ` +
        `${DERIVED_STEPS.map((candidate) => candidate.script).join(', ')}.`,
    )
  }
  return { config: { steps }, used: kept.map((candidate) => candidate.script) }
}

export interface LoadSignoffConfigOptions {
  readonly repoRoot: string
  /** Explicit config path. Missing file is an error, never a silent fallback. */
  readonly configPath?: string
}

export async function loadSignoffConfig(options: LoadSignoffConfigOptions): Promise<LoadedSignoffConfig> {
  const { repoRoot, configPath } = options

  if (configPath !== undefined) {
    const abs = resolve(repoRoot, configPath)
    if (!existsSync(abs)) throw new Error(`signoff: no config at ${abs}`)
    return { config: await importConfig(abs), origin: { kind: 'file', path: abs } }
  }

  for (const candidate of SIGNOFF_CONFIG_FILES) {
    const abs = join(repoRoot, candidate)
    if (existsSync(abs)) return { config: await importConfig(abs), origin: { kind: 'file', path: abs } }
  }

  const pkgPath = join(repoRoot, 'package.json')
  if (!existsSync(pkgPath)) {
    throw new Error(`signoff: ${repoRoot} has no package.json, no signoff.config.mjs, and nothing to derive from.`)
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    signoff?: unknown
    scripts?: Record<string, string>
  }
  if (pkg.signoff !== undefined) {
    return { config: parseSignoffConfig(pkg.signoff, `${pkgPath} "signoff"`), origin: { kind: 'package-json', path: pkgPath } }
  }

  const derived = deriveSignoffConfig(pkg.scripts ?? {})
  return { config: derived.config, origin: { kind: 'derived', path: pkgPath, scripts: derived.used } }
}

async function importConfig(abs: string): Promise<SignoffConfig> {
  const mod: unknown = await import(pathToFileURL(abs).href)
  const value = (mod as { default?: unknown }).default
  if (value === undefined) throw new Error(`signoff: ${abs} must have a default export`)
  return parseSignoffConfig(value, abs)
}
