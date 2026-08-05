import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { availableParallelism, homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { loadSignoffConfig } from './config'
import { assertNodeVersion, resolveNodeRequirement, type NodeVersionRequirement } from './node-version'
import { runCommand, type CommandResult } from './exec'
import { runGraph, validateGraph, type TaskOutcome } from './schedule'
import { assertShuffleArgsReachTheRunner, newSeedBase, planAttempts } from './seeds'
import { resolveStore } from './store'
import { materializeCleanTree, removeCleanTree, repoRootOf, type CleanTree } from './workspace'
import type {
  SignoffAttempt,
  SignoffEvent,
  SignoffHostFacts,
  SignoffInstallResult,
  SignoffReport,
  SignoffSource,
  SignoffStepResult,
  SignoffStepSpec,
} from './types'

/**
 * The sign-off run: reproduce a clean CI environment, then go further.
 *
 * Order matters and each stage exists for a failure this fleet actually paid
 * for:
 *  1. a pristine checkout (`workspace.ts`) — no warm `node_modules`, no Vite
 *     cache, because that is the entire mechanical difference between "green
 *     locally" and "red in CI";
 *  2. `--frozen-lockfile` into a store keyed on the lockfile (`store.ts`) — the
 *     clean install CI does, without paying the download twice;
 *  3. the repo's declared steps (`config.ts`), run as a graph rather than a line
 *     (`schedule.ts`), with the suite re-run under randomized file order and
 *     recorded seeds (`seeds.ts`) — the part CI does not do at all.
 *
 * Nothing about a failure is inferred. Every step reports its command, exit
 * code, duration, seed and captured output.
 */

export interface RunSignoffOptions {
  /** Any directory inside the repo. Defaults to the process cwd. */
  readonly repoDir?: string
  readonly configPath?: string
  /** Default `working-tree` — verify what you are about to commit. */
  readonly source?: SignoffSource
  /** Run every step even after one fails. Default false. */
  readonly keepGoing?: boolean
  /** Base seed. Pass a previous run's to reproduce it exactly. */
  readonly seed?: number
  readonly maxParallel?: number
  readonly cacheDir?: string
  /** Override every shuffled step's run count. */
  readonly shuffleRuns?: number
  /** Keep the clean tree for inspection instead of removing it. */
  readonly keepWorkspace?: boolean
  readonly onEvent?: (event: SignoffEvent) => void
}

const DEFAULT_CACHE_DIR = join(homedir(), '.cache', 'agent-app-signoff')

function hostFacts(treePath: string, requirement: NodeVersionRequirement | null): SignoffHostFacts {
  const pm = spawnSync('pnpm', ['--version'], { cwd: treePath, encoding: 'utf8' })
  return {
    node: process.version,
    nodePinned: requirement?.declared ?? null,
    nodePinSource: requirement?.source ?? null,
    packageManager: pm.status === 0 ? `pnpm ${pm.stdout.trim()}` : 'pnpm (not resolvable)',
    platform: process.platform,
    arch: process.arch,
    cpus: availableParallelism(),
  }
}

/** Successful steps keep only a tail; a passing 3,000-test run is not evidence. */
const SUCCESS_OUTPUT_TAIL = 4_000

function toAttempt(result: CommandResult, seed: number | null, ok: boolean): SignoffAttempt {
  return {
    command: result.command,
    seed,
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    output: ok ? result.output.slice(-SUCCESS_OUTPUT_TAIL) : result.output,
    outputTruncated: result.truncated || (ok && result.output.length > SUCCESS_OUTPUT_TAIL),
  }
}

function buildEnv(
  base: Readonly<Record<string, string | undefined>>,
  layers: readonly (Readonly<Record<string, string>> | undefined)[],
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base }
  for (const layer of layers) {
    if (layer) Object.assign(env, layer)
  }
  return env
}

/** Where the store flag goes: after the subcommand, so `pnpm install X --store-dir Y` stays valid. */
function withStoreDir(command: string, flag: string | null | undefined, storeDir: string): string {
  if (flag === null) return command
  return `${command} ${flag ?? '--store-dir'} ${JSON.stringify(storeDir)}`
}

export async function runSignoff(options: RunSignoffOptions = {}): Promise<SignoffReport> {
  const startedAt = new Date()
  const wallStart = Date.now()
  const repoDir = resolve(options.repoDir ?? process.cwd())
  const repoRoot = repoRootOf(repoDir)
  const { config, origin } = await loadSignoffConfig({ repoRoot, configPath: options.configPath })

  // Fail before materializing anything: a bad graph is a config error, and
  // paying for an install to learn that is a waste of the speed this exists for.
  validateGraph(config.steps.map((step) => ({ name: step.name, needs: step.needs })))
  assertShuffleArgsReachTheRunner(config.steps)
  const nodeRequirement = resolveNodeRequirement(repoRoot, config.nodeVersion)
  assertNodeVersion(nodeRequirement)

  const source = options.source ?? 'working-tree'
  const cacheDir = resolve(options.cacheDir ?? config.cacheDir ?? DEFAULT_CACHE_DIR)
  // The tree lives under the same root as the stores on purpose: pnpm hardlinks
  // from the store into `node_modules`, and a store on another filesystem
  // silently degrades to a full copy.
  const treePath = join(cacheDir, 'trees', `${basename(repoRoot)}-${process.pid}`)

  let tree: CleanTree | null = null
  try {
    tree = materializeCleanTree({ repoDir: repoRoot, dest: treePath, source, carryFiles: config.carryFiles })
    options.onEvent?.({ kind: 'tree', path: tree.path, head: tree.head, dirty: tree.dirty })

    const store = resolveStore({ treePath: tree.path, cacheDir, generations: config.storeGenerations })
    options.onEvent?.({ kind: 'store', storeDir: store.storeDir, cacheHit: store.hit, cacheKey: store.cacheKey })

    const installSpec = config.install ?? {}
    const installCwd = join(tree.path, installSpec.cwd ?? '.')
    const installCommand = withStoreDir(
      installSpec.run ?? 'pnpm install --frozen-lockfile',
      installSpec.storeDirFlag,
      store.storeDir,
    )
    const storeEnvName = installSpec.storeEnv === null ? null : installSpec.storeEnv ?? 'NPM_CONFIG_STORE_DIR'
    const sharedEnv = buildEnv(process.env, [
      // Parity with CI: a runner that behaves differently under `CI` (vitest's
      // reporter, wrangler's prompts) must behave that way here too.
      { CI: 'true' },
      config.env,
      storeEnvName === null ? undefined : { [storeEnvName]: store.storeDir },
    ])

    options.onEvent?.({ kind: 'install-start', command: installCommand })
    const installResult = await runCommand({
      command: installCommand,
      cwd: installCwd,
      env: buildEnv(sharedEnv, [installSpec.env]),
      timeoutMs: installSpec.timeoutMs,
    })
    options.onEvent?.({ kind: 'install-end', exitCode: installResult.exitCode, durationMs: installResult.durationMs })

    const install: SignoffInstallResult = {
      command: installCommand,
      storeDir: store.storeDir,
      cacheKey: store.cacheKey,
      cacheHit: store.hit,
      keyedOn: store.keyedOn,
      exitCode: installResult.exitCode,
      durationMs: installResult.durationMs,
      output: installResult.exitCode === 0 ? installResult.output.slice(-SUCCESS_OUTPUT_TAIL) : installResult.output,
      outputTruncated: installResult.truncated,
    }

    const host = hostFacts(tree.path, nodeRequirement)
    const seedBase = options.seed ?? newSeedBase()

    if (installResult.exitCode !== 0) {
      // Every step is unrunnable, and saying so is the honest report. A gate
      // that reports "0 failures" because it never ran anything is the failure
      // mode this whole module exists to prevent.
      return finish({
        ok: false,
        startedAt,
        wallStart,
        tree,
        origin,
        host,
        install,
        steps: config.steps.map(
          (step): SignoffStepResult => ({
            name: step.name,
            status: 'skipped',
            attempts: [],
            durationMs: 0,
            startedAtMs: null,
            finishedAtMs: null,
          }),
        ),
        seedBase,
        keepGoing: options.keepGoing ?? false,
        workspaceRetained: options.keepWorkspace ?? false,
        source,
        options,
      })
    }

    const treeRoot = tree.path
    const outcomes = await runGraph<SignoffStepSpec, readonly SignoffAttempt[]>({
      nodes: config.steps,
      maxParallel: options.maxParallel ?? config.maxParallel ?? availableParallelism(),
      keepGoing: options.keepGoing ?? false,
      run: async (step, signal) => {
        const attempts: SignoffAttempt[] = []
        for (const plan of planAttempts(step, seedBase, options.shuffleRuns)) {
          options.onEvent?.({ kind: 'step-start', name: step.name, command: plan.command, seed: plan.seed })
          const result = await runCommand({
            command: plan.command,
            cwd: join(treeRoot, step.cwd ?? '.'),
            env: buildEnv(sharedEnv, [step.env]),
            timeoutMs: step.timeoutMs,
            signal,
          })
          const ok = result.exitCode === 0
          attempts.push(toAttempt(result, plan.seed, ok))
          // Stop at the first failing order: the remaining seeds would report
          // the same defect, and the seed that found it is already recorded.
          if (!ok) {
            emitStepEnd(options, step.name, 'failed', attempts)
            return { ok: false, value: attempts }
          }
        }
        emitStepEnd(options, step.name, 'passed', attempts)
        return { ok: true, value: attempts }
      },
    })

    const steps = outcomes.map(toStepResult)
    return finish({
      ok: steps.every((step) => step.status === 'passed'),
      startedAt,
      wallStart,
      tree,
      origin,
      host,
      install,
      steps,
      seedBase,
      keepGoing: options.keepGoing ?? false,
      workspaceRetained: options.keepWorkspace ?? false,
      source,
      options,
    })
  } finally {
    if (tree && !options.keepWorkspace && existsSync(tree.path)) removeCleanTree(tree)
  }
}

/** Emitted from inside the step, so a watching CLI sees a completion when it
 *  happens rather than every completion at the end of the run. */
function emitStepEnd(
  options: RunSignoffOptions,
  name: string,
  status: SignoffStepResult['status'],
  attempts: readonly SignoffAttempt[],
): void {
  options.onEvent?.({
    kind: 'step-end',
    name,
    status,
    durationMs: attempts.reduce((total, attempt) => total + attempt.durationMs, 0),
  })
}

function toStepResult(outcome: TaskOutcome<readonly SignoffAttempt[]>): SignoffStepResult {
  const attempts = outcome.value ?? []
  const durationMs = attempts.reduce((total, attempt) => total + attempt.durationMs, 0)
  return {
    name: outcome.name,
    status: outcome.status,
    attempts,
    durationMs,
    startedAtMs: outcome.startedAtMs,
    finishedAtMs: outcome.finishedAtMs,
  }
}

interface FinishInput {
  readonly ok: boolean
  readonly startedAt: Date
  readonly wallStart: number
  readonly tree: CleanTree
  readonly origin: SignoffReport['configOrigin']
  readonly host: SignoffHostFacts
  readonly install: SignoffInstallResult
  readonly steps: readonly SignoffStepResult[]
  readonly seedBase: number
  readonly keepGoing: boolean
  readonly workspaceRetained: boolean
  readonly source: SignoffSource
  readonly options: RunSignoffOptions
}

function finish(input: FinishInput): SignoffReport {
  const serialMs = input.install.durationMs + input.steps.reduce((total, step) => total + step.durationMs, 0)
  const flags = [
    `--source ${input.source}`,
    `--seed ${input.seedBase}`,
    ...(input.keepGoing ? ['--keep-going'] : []),
  ]
  return {
    ok: input.ok,
    startedAt: input.startedAt.toISOString(),
    repo: {
      root: input.tree.root,
      head: input.tree.head,
      branch: input.tree.branch,
      source: input.source,
      dirty: input.tree.dirty,
      diffSha256: input.tree.diffSha256,
      untrackedFiles: input.tree.untrackedFiles,
      carriedFiles: input.tree.carriedFiles,
    },
    configOrigin: input.origin,
    workspace: input.tree.path,
    workspaceRetained: input.workspaceRetained,
    host: input.host,
    install: input.install,
    steps: input.steps,
    seedBase: input.seedBase,
    wallClockMs: Date.now() - input.wallStart,
    serialMs,
    keepGoing: input.keepGoing,
    reproduce: `agent-app-signoff ${input.tree.root} ${flags.join(' ')}`,
  }
}
