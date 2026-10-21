/**
 * No-spend research plan: the product-benchmark manifest an app writes before
 * any paid cell runs (zero budget, the standard four arms), plus the small CLI
 * helpers its `eval/research-package.ts` wrapper shares.
 *
 * Server-side only (node:fs). The app owns the project and benchmark ids, the
 * profile path and the scenario list; agent-eval owns the manifest shape and
 * the repo identity.
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { productBenchmarkRepoIdentity, type ProductBenchmarkManifest } from '@tangle-network/agent-eval'

/** Value of `--name value` or `--name=value`, or undefined when absent. */
export function researchCliArg(argv: readonly string[], name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`)
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1]
  const flat = argv.find((entry) => entry.startsWith(`--${name}=`))
  return flat ? flat.split('=').slice(1).join('=') : undefined
}

/** The most recently modified directory under `root`; throws when there is none. */
export function latestRunDir(root: string): string {
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  const latest = entries[0]
  if (!latest) throw new Error(`no run directories under ${root}`)
  return latest
}

function packageVersion(name: string): string {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  return pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? 'unknown'
}

export interface ResearchPlanConfig {
  projectId: string
  benchmarkId: string
  /** Profile id the arms attach to. */
  profileId: string
  /** Repo-relative path of the product's agent profile source. */
  agentProfilePath: string
  scenarios: ProductBenchmarkManifest['scenarios']
}

/** Write `<outDir>/product-benchmark-manifest.json` with zero budget; returns its path. */
export function writeResearchPlan(outDir: string, config: ResearchPlanConfig): string {
  const plan: ProductBenchmarkManifest = {
    schemaVersion: 1,
    projectId: config.projectId,
    benchmarkId: config.benchmarkId,
    repo: productBenchmarkRepoIdentity(),
    substrate: {
      agentEval: packageVersion('@tangle-network/agent-eval'),
      agentRuntime: packageVersion('@tangle-network/agent-runtime'),
      agentInterface: packageVersion('@tangle-network/agent-interface'),
      sandbox: packageVersion('@tangle-network/sandbox'),
    },
    profiles: [{ id: config.profileId, profileHash: 'planned', agentProfilePath: config.agentProfilePath }],
    arms: ['baseline-generic', 'production-profile', 'policy-resource-long', 'policy-resource-short'].map((id) => ({
      id,
      profileId: config.profileId,
      mutableSurfaces: id.startsWith('policy-resource') ? ['resources.files'] : ['prompt'],
      policyAxes: { carrier: id.startsWith('policy-resource') ? 'resource-file' : 'profile' },
    })),
    scenarios: config.scenarios,
    budgets: { maxUsd: 0, maxCells: 0, maxWallMs: 0 },
    expectedArtifactDir: resolve(outDir),
  }
  mkdirSync(outDir, { recursive: true })
  const path = join(outDir, 'product-benchmark-manifest.json')
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`)
  return path
}
