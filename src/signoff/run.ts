import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { availableParallelism, homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { loadSignoffConfig } from './config'
import { activeStoreKeys, openSignoffCacheSession, pruneSignoffCache, withCacheLock,
  type SignoffCacheSession } from './cache'
import {
  assertNodeTypesVersion,
  assertNodeVersion,
  resolveNodeRequirement,
  type NodeVersionRequirement,
} from './node-version'
import { runCommand, type CommandResult } from './exec'
import { runGraph, validateGraph, type TaskOutcome } from './schedule'
import { assertShuffleArgsReachTheRunner, newSeedBase, planAttempts } from './seeds'
import { manifestCacheKey, manifestFiles, resolveStore } from './store'
import { APP_DEFAULTS_STEP, checkAppDefaults, formatAppDefaults } from './app-defaults'
import { checkWorkerDefaults, formatWorkerDefaults, WORKER_DEFAULTS_STEP } from './worker-defaults'
import { materializeCleanTree, removeCleanTree, repoRootOf, type CleanTree } from './workspace'
import type {
  SignoffAttempt,
  SignoffConfig,
  SignoffEvent,
  SignoffHostFacts,
  SignoffInstallResult,
  SignoffReport,
  SignoffPhase,
  SignoffSelection,
  SignoffSource,
  SignoffStepResult,
  SignoffStepSpec,
} from './types'

export interface RunSignoffOptions {
  /** Any directory inside the repo. Defaults to the process cwd. */
  readonly repoDir?: string
  readonly configPath?: string
  /** Default `working-tree` — verify what you are about to commit. */
  readonly source?: SignoffSource
  /** Default all. Partial phases run declared steps and their prerequisites. */
  readonly phase?: SignoffPhase
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
  const source = options.source ?? 'working-tree'
  // The config must come from the same selected bytes as the steps. The cache
  // option can be declared in that config, so bootstrap under the explicit
  // option or the default, then move the tree if the selected config says so.
  let cacheDir = resolve(options.cacheDir ?? DEFAULT_CACHE_DIR)
  // The tree lives under the same root as the stores on purpose: pnpm hardlinks
  // from the store into `node_modules`, and a store on another filesystem
  // silently degrades to a full copy.
  const treeName = `${basename(repoRoot)}-${process.pid}-${randomUUID()}`
  const treePath = (): string => join(cacheDir, 'trees', treeName)

  let tree: CleanTree | null = null
  const sessions: SignoffCacheSession[] = []
  let session = await openSignoffCacheSession(cacheDir, treePath())
  sessions.push(session)
  cacheDir = session.cacheDir
  const prune = async (root: string, keepPaths: readonly string[] = []): Promise<void> => {
    const result = await pruneSignoffCache(root, { keepPaths })
    if (result.removed.length || result.orphaned.length || result.overBudgetBytes) {
      options.onEvent?.({ kind: 'cache-prune', ...result })
    }
  }
  let report: SignoffReport | undefined
  let primaryError: unknown
  let primaryFailed = false
  let workspaceRetained = options.keepWorkspace ?? false
  const cleanupErrors: string[] = []
  const cleanup = async (operation: string, action: () => unknown | Promise<unknown>): Promise<boolean> => {
    try { await action(); return true }
    catch (error) { cleanupErrors.push(`${operation}: ${error instanceof Error ? error.message : String(error)}`); return false }
  }
  try {
    await prune(cacheDir)
    tree = materializeCleanTree({ repoDir: repoRoot, dest: treePath(), source })
    let loaded = await loadSignoffConfig({ repoRoot: tree.path, configPath: options.configPath, phase: options.phase })

    cacheDir = resolve(options.cacheDir ?? loaded.config.cacheDir ?? DEFAULT_CACHE_DIR)
    if (tree.path !== treePath() || (loaded.config.carryFiles?.length ?? 0) > 0) {
      if (session.cacheDir !== cacheDir) {
        session = await openSignoffCacheSession(cacheDir, treePath())
        sessions.push(session)
        cacheDir = session.cacheDir
        await prune(cacheDir)
      }
      removeCleanTree(tree)
      tree = materializeCleanTree({ repoDir: repoRoot, dest: treePath(), source, carryFiles: loaded.config.carryFiles })
      // The second load gives the report an origin inside the final selected
      // tree, and keeps config-derived values tied to that same path.
      loaded = await loadSignoffConfig({ repoRoot: tree.path, configPath: options.configPath, phase: options.phase })
    }

    const { config, origin, selection } = loaded
    const checkDefaults = options.phase !== 'suites'
    // Validate after loading from the selected tree, before paying for install.
    validateGraph(config.steps.map((step) => ({ name: step.name, needs: step.needs })))
    assertShuffleArgsReachTheRunner(config.steps)
    const nodeRequirement = resolveNodeRequirement(tree.path, config.nodeVersion)
    assertNodeVersion(nodeRequirement)

    options.onEvent?.({ kind: 'tree', path: tree.path, head: tree.head, dirty: tree.dirty })

    // Publish the selected key before creating/pruning stores. A concurrent
    // signoff can then prune under the same lock without deleting this install.
    await session.protectStore(manifestCacheKey(tree.path, manifestFiles(tree.path)))
    const store = await withCacheLock(cacheDir, () => resolveStore({ treePath: tree!.path, cacheDir,
      generations: config.storeGenerations, protectedStoreKeys: activeStoreKeys(cacheDir) }))
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
      // A step that reads history (agent-app-rollout-check's base) finds the
      // original source checkout here; the detached worktree shares its history.
      { SIGNOFF_SOURCE_REPO: repoRoot, SIGNOFF_TREE: tree.path },
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
      report = finish({
        ok: false,
        startedAt,
        wallStart,
        tree,
        origin,
        selection,
        host,
        install,
        steps: [...config.steps.map((step) => step.name), ...(checkDefaults ? [WORKER_DEFAULTS_STEP, APP_DEFAULTS_STEP] : [])].map(
          (name): SignoffStepResult => ({
            name,
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
    } else {
      assertNodeTypesVersion(tree.path, nodeRequirement)

      const workerDefaults = checkDefaults ? [runWorkerDefaults(tree.path, config.workerConfigs, options)] : []

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

      // After the graph, so the build the app's steps made is there to measure the Worker upload from.
      const appDefaults = checkDefaults ? [runAppDefaults(tree.path, config, options)] : []
      const steps = [...outcomes.map(toStepResult), ...workerDefaults, ...appDefaults]
      report = finish({
        ok: steps.every((step) => step.status === 'passed'),
        startedAt,
        wallStart,
        tree,
        origin,
        selection,
        host,
        install,
        steps,
        seedBase,
        keepGoing: options.keepGoing ?? false,
        workspaceRetained: options.keepWorkspace ?? false,
        source,
        options,
      })
    }
  } catch (error) {
    primaryFailed = true
    primaryError = error
  } finally {
    if (tree && !options.keepWorkspace && existsSync(tree.path)) {
      workspaceRetained = !await cleanup('remove workspace', () => removeCleanTree(tree!))
    }
    for (const active of sessions) {
      if (await cleanup(`close cache session ${active.cacheDir}`, () => active.close())) {
        await cleanup(`prune cache ${active.cacheDir}`, () => prune(active.cacheDir, workspaceRetained && tree ? [tree.path] : []))
      }
    }
  }
  if (primaryFailed) {
    if (cleanupErrors.length) throw new AggregateError([primaryError, ...cleanupErrors.map(message => new Error(message))],
      `${primaryError instanceof Error ? primaryError.message : String(primaryError)}; cleanup failed: ${cleanupErrors.join('; ')}`, { cause: primaryError })
    throw primaryError
  }
  return { ...report!, ok: report!.ok && cleanupErrors.length === 0, workspaceRetained,
    wallClockMs: Date.now() - wallStart, ...(cleanupErrors.length ? { cleanupErrors } : {}) }
}

/**
 * Built in rather than declared: every repo that deploys an agent-app Worker
 * must ship the shared Cloudflare defaults, and a step a repo can leave out of
 * its config would let exactly the drift it exists to catch through. It runs
 * after install because it reads each config through the repo's own Wrangler.
 */
function runWorkerDefaults(
  treeRoot: string,
  workerConfigs: readonly string[] | undefined,
  options: RunSignoffOptions,
): SignoffStepResult {
  const command = `agent-app-signoff ${WORKER_DEFAULTS_STEP}`
  options.onEvent?.({ kind: 'step-start', name: WORKER_DEFAULTS_STEP, command, seed: null })
  const started = Date.now()
  let output: string
  let ok: boolean
  try {
    const result = checkWorkerDefaults(treeRoot, workerConfigs)
    output = formatWorkerDefaults(result)
    ok = result.findings.length === 0
  } catch (error) {
    output = `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
    ok = false
  }
  const durationMs = Date.now() - started
  const attempts: SignoffAttempt[] = [
    { command, seed: null, exitCode: ok ? 0 : 1, signal: null, durationMs, timedOut: false, output, outputTruncated: false },
  ]
  emitStepEnd(options, WORKER_DEFAULTS_STEP, ok ? 'passed' : 'failed', attempts)
  // It runs before the graph's clock starts, so it has no position on the
  // graph timeline; giving it one would count it as overlapping the roots.
  return { name: WORKER_DEFAULTS_STEP, status: ok ? 'passed' : 'failed', attempts, durationMs, startedAtMs: null, finishedAtMs: null }
}

/**
 * Built in beside `worker defaults`: a report of which agent-app defaults the app has (app-defaults.ts). It fails only
 * on an opt-out that gives no reason, so it can run in every app's gate without blocking one over a gap it can see.
 */
function runAppDefaults(treeRoot: string, config: SignoffConfig, options: RunSignoffOptions): SignoffStepResult {
  const command = `agent-app-signoff ${APP_DEFAULTS_STEP}`
  options.onEvent?.({ kind: 'step-start', name: APP_DEFAULTS_STEP, command, seed: null })
  const started = Date.now()
  let output: string
  let ok: boolean
  try {
    const result = checkAppDefaults(treeRoot, { exemptions: config.agentApp?.exemptions })
    output = formatAppDefaults(result)
    ok = result.findings.length === 0
  } catch (error) {
    output = `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
    ok = false
  }
  const durationMs = Date.now() - started
  const attempts: SignoffAttempt[] = [
    { command, seed: null, exitCode: ok ? 0 : 1, signal: null, durationMs, timedOut: false, output, outputTruncated: false },
  ]
  emitStepEnd(options, APP_DEFAULTS_STEP, ok ? 'passed' : 'failed', attempts)
  return { name: APP_DEFAULTS_STEP, status: ok ? 'passed' : 'failed', attempts, durationMs, startedAtMs: null, finishedAtMs: null }
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
  readonly selection?: SignoffSelection
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
    ...(input.options.phase && input.options.phase !== 'all' ? [`--phase ${input.options.phase}`] : []),
    ...(input.options.configPath ? [`--config '${input.options.configPath.replace(/'/g, "'\\''")}'`] : []),
    `--seed ${input.seedBase}`,
    ...(input.keepGoing ? ['--keep-going'] : []),
  ]
  return {
    phase: input.options.phase ?? 'all',
    ...(input.selection ? { selection: input.selection } : {}),
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
