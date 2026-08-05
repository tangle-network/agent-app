/**
 * The vocabulary of a local sign-off run: what a repo declares, and what the
 * run produces as proof.
 *
 * A sign-off gate replaces CI as the merge gate, so it has to reproduce what CI
 * does structurally (a pristine dependency tree) and then do more than CI does
 * (randomized suite order, recorded seeds, a dependency graph run in parallel).
 * Both halves are declared here rather than hardcoded, because the three
 * workflows this must express — agent-app, legal-agent, tax-agent — differ in
 * install filter, step list, language (one has a Python step) and repo-specific
 * gates.
 */

/** Which bytes get verified. */
export type SignoffSource =
  /** Exactly the commit that would merge. Uncommitted work is NOT included. */
  | 'head'
  /** HEAD plus the working tree: tracked modifications applied as a patch and
   *  untracked, non-ignored files copied in. What you are about to commit. */
  | 'working-tree'

/**
 * How a step is re-run under different suite orders.
 *
 * CI runs one arbitrary order. The `node:sqlite` bundling failure that started
 * this was scheduling-dependent: it reproduced in CI's clean install under CI's
 * worker sharding and not in a warm local run, so a single fixed order can miss
 * it in either direction. Every seed used is recorded in the report, which is
 * what makes a shuffled failure reproducible rather than folklore.
 */
export interface SignoffShuffleSpec {
  /** How many times to run the step, each with its own seed. Default 2. */
  readonly runs?: number
  /** Exact seeds to use. Wins over `runs`; use it to replay a known failure. */
  readonly seeds?: readonly number[]
  /** Arguments appended to the command, with `{seed}` substituted. Defaults to
   *  vitest's file-order shuffle; override for another runner. */
  readonly args?: readonly string[]
}

/** One verification step — a CI step, declared by the repo. */
export interface SignoffStepSpec {
  /** Unique within the config. Names the failure in the report. */
  readonly name: string
  /** Shell command, run from `cwd` inside the clean tree. */
  readonly run: string
  /** Relative to the clean tree root. Defaults to the root. */
  readonly cwd?: string
  /** Extra environment for this step only. */
  readonly env?: Readonly<Record<string, string>>
  /** Step names that must pass first. Anything not named here may run in
   *  parallel with this step — that is the whole speed lever, so an omitted
   *  dependency is a correctness bug, not a tuning knob. */
  readonly needs?: readonly string[]
  /** Kill the step after this long. No default — an unbounded step is the
   *  repo's choice to make. */
  readonly timeoutMs?: number
  /** `true` for the default shuffle spec, or an explicit one. */
  readonly shuffle?: boolean | SignoffShuffleSpec
}

/** The hermetic install that precedes every step. */
export interface SignoffInstallSpec {
  /** Default `pnpm install --frozen-lockfile`. tax-agent needs
   *  `--filter web...` because `server/` depends on a sibling repo by `file:`. */
  readonly run?: string
  /** Flag used to point the package manager at the pristine store. Default
   *  `--store-dir`. `null` passes no flag (the env var still applies). */
  readonly storeDirFlag?: string | null
  /** Env var used for the same. Default `NPM_CONFIG_STORE_DIR`, which is what
   *  the tax-agent and legal-agent workflows set. `null` sets none. */
  readonly storeEnv?: string | null
  /** Relative to the clean tree root. Defaults to the root. */
  readonly cwd?: string
  readonly timeoutMs?: number
  /** Extra environment for the install only. */
  readonly env?: Readonly<Record<string, string>>
}

/** What a repo declares in `signoff.config.mjs` or a package.json `signoff` key. */
export interface SignoffConfig {
  readonly install?: SignoffInstallSpec
  readonly steps: readonly SignoffStepSpec[]
  /** Cap on concurrently running steps. Defaults to the host's parallelism. */
  readonly maxParallel?: number
  /** Environment applied to every step and the install. */
  readonly env?: Readonly<Record<string, string>>
  /** Node version the product ships on, e.g. `'22'`. Falls back to `.nvmrc`.
   *  A mismatch REFUSES the run — see `node-version.ts`. */
  readonly nodeVersion?: string
  /** Gitignored files the run genuinely needs (a private-registry `.npmrc`).
   *  Explicit and fail-loud: a missing one aborts rather than installing from
   *  a different registry than the developer thinks. */
  readonly carryFiles?: readonly string[]
  /** Root for the clean tree and the pristine stores. Default
   *  `~/.cache/agent-app-signoff`. Both live under it so they share a
   *  filesystem — pnpm hardlinks from the store into `node_modules`, and a
   *  cross-device store silently degrades to copying. */
  readonly cacheDir?: string
  /** Pristine store generations to keep. Default 4, so flipping between a
   *  branch and main stays warm on both. */
  readonly storeGenerations?: number
}

/** Where a config came from. Printed in the proof — a run against a derived
 *  default is a weaker claim than one against a declared step list. */
export type SignoffConfigOrigin =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'package-json'; readonly path: string }
  | { readonly kind: 'derived'; readonly path: string; readonly scripts: readonly string[] }

export interface LoadedSignoffConfig {
  readonly config: SignoffConfig
  readonly origin: SignoffConfigOrigin
}

/** One execution of a step's command. A shuffled step has several. */
export interface SignoffAttempt {
  readonly command: string
  /** The suite-order seed, or `null` for an unshuffled step. */
  readonly seed: number | null
  readonly exitCode: number
  readonly signal: string | null
  readonly durationMs: number
  readonly timedOut: boolean
  /** Captured stdout+stderr, interleaved. Retained on failure; on success only
   *  the tail is kept, so a passing 3,000-test run does not bloat the proof. */
  readonly output: string
  readonly outputTruncated: boolean
}

export type SignoffStepStatus =
  | 'passed'
  | 'failed'
  /** Never started — an earlier failure stopped the schedule. */
  | 'skipped'
  /** Started, then killed when another step failed under fail-fast. */
  | 'cancelled'
  /** A dependency failed, so this step could not be judged. */
  | 'blocked'

export interface SignoffStepResult {
  readonly name: string
  readonly status: SignoffStepStatus
  readonly attempts: readonly SignoffAttempt[]
  readonly durationMs: number
  /** Milliseconds from schedule start, so the report can show the real overlap
   *  rather than asserting a speedup it did not measure. */
  readonly startedAtMs: number | null
  readonly finishedAtMs: number | null
}

export interface SignoffInstallResult {
  readonly command: string
  readonly storeDir: string
  readonly cacheKey: string
  readonly cacheHit: boolean
  /** The files whose bytes produced `cacheKey`. Named so a surprise cold
   *  install is explainable rather than mysterious. */
  readonly keyedOn: readonly string[]
  readonly exitCode: number
  readonly durationMs: number
  readonly output: string
  readonly outputTruncated: boolean
}

export interface SignoffRepoFacts {
  readonly root: string
  readonly head: string
  readonly branch: string
  readonly source: SignoffSource
  readonly dirty: boolean
  /** sha256 of the applied working-tree patch, `null` when nothing was applied.
   *  This is what makes the proof specific to the bytes that were verified. */
  readonly diffSha256: string | null
  readonly untrackedFiles: readonly string[]
  readonly carriedFiles: readonly string[]
}

export interface SignoffHostFacts {
  readonly node: string
  /** The pin the repo declares, and where it came from. `null` when the repo
   *  pins nothing — stated in the proof, because an unpinned runtime is a
   *  weaker claim than a pinned one. */
  readonly nodePinned: string | null
  readonly nodePinSource: string | null
  readonly packageManager: string
  readonly platform: string
  readonly arch: string
  readonly cpus: number
}

export interface SignoffReport {
  readonly ok: boolean
  readonly startedAt: string
  readonly repo: SignoffRepoFacts
  readonly configOrigin: SignoffConfigOrigin
  readonly workspace: string
  readonly workspaceRetained: boolean
  readonly host: SignoffHostFacts
  readonly install: SignoffInstallResult
  readonly steps: readonly SignoffStepResult[]
  /** Base seed. Passing it back via `--seed` reproduces every step's seeds. */
  readonly seedBase: number
  readonly wallClockMs: number
  /** Install + the sum of step durations: what the same work costs in series. */
  readonly serialMs: number
  readonly keepGoing: boolean
  /** The exact command that reproduces this run. */
  readonly reproduce: string
}

/** Progress, for a CLI that prints as it goes rather than at the end. */
export type SignoffEvent =
  | { readonly kind: 'tree'; readonly path: string; readonly head: string; readonly dirty: boolean }
  | { readonly kind: 'store'; readonly storeDir: string; readonly cacheHit: boolean; readonly cacheKey: string }
  | { readonly kind: 'install-start'; readonly command: string }
  | { readonly kind: 'install-end'; readonly exitCode: number; readonly durationMs: number }
  | { readonly kind: 'step-start'; readonly name: string; readonly command: string; readonly seed: number | null }
  | { readonly kind: 'step-end'; readonly name: string; readonly status: SignoffStepStatus; readonly durationMs: number }
