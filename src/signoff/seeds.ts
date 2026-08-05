import { createHash, randomInt } from 'node:crypto'
import type { SignoffShuffleSpec, SignoffStepSpec } from './types'

/**
 * Suite-order randomization — the half of this gate that CI does not have.
 *
 * CI runs one arbitrary file order, so a scheduling-dependent failure is a coin
 * flip it happens to win or lose. The `node:sqlite` bundling failure that
 * started this was exactly that shape: it reproduced under CI's clean install
 * and worker sharding and not under a warm local run, and a single fixed order
 * could have missed it in either direction.
 *
 * Two rules make randomization useful rather than merely noisy:
 *
 * 1. **Every seed is recorded.** A shuffled failure that cannot be replayed is
 *    a rumour. The report carries the base seed and every derived seed, and the
 *    derivation is a pure function of `(base, step, index)` — so `--seed <base>`
 *    reproduces the whole run, and a single seed replays one step.
 * 2. **Files are shuffled; tests inside a file are not.** File order is what
 *    module-graph and worker-scheduling failures depend on. Shuffling the tests
 *    within a file mostly finds intentional ordering in a `describe` block,
 *    which is a false alarm, and a gate that cries wolf gets waived.
 */

/**
 * Vitest file-order shuffle. `{seed}` is substituted per attempt.
 *
 * **No `--` separator, and that is measured, not assumed.** The habit is to
 * write `pnpm run test -- --flag`, and it silently breaks this: pnpm forwards
 * script arguments verbatim without needing the separator, so the `--` reaches
 * vitest, whose CLI treats it as end-of-options and drops everything after it.
 * Measured on this repo, four test files, `--reporter=verbose`:
 *
 * | invocation | seed 1 order | seed 2 order |
 * |---|---|---|
 * | `vitest run -- --sequence.shuffle.files=true --sequence.seed=N` | schedule, store, seeds, config | schedule, store, seeds, config |
 * | `vitest run --sequence.shuffle.files=true --sequence.seed=N` | schedule, config, store, seeds | seeds, schedule, config, store |
 *
 * The first row is the failure this gate exists to prevent, applied to itself:
 * a run that reports "2 orders, seeds recorded" while running one fixed order
 * twice. If a runner ever does need a separator, its config declares its own
 * `shuffle.args`.
 */
const DEFAULT_SHUFFLE_ARGS: readonly string[] = [
  '--sequence.shuffle.files=true',
  '--sequence.seed={seed}',
]

export const DEFAULT_SHUFFLE_RUNS = 2

/** A fresh base seed. Random, then recorded — never a fixed constant, or the
 *  "randomized" order is one more fixed order. */
export function newSeedBase(): number {
  return randomInt(0, 2 ** 31 - 1)
}

/**
 * Derive a step's Nth seed from the base.
 *
 * A hash rather than `base + n`: adjacent seeds produce correlated orders in
 * some runners, and the point is independent samples of the order space.
 */
export function deriveSeed(base: number, stepName: string, index: number): number {
  const digest = createHash('sha256').update(`${base}:${stepName}:${index}`).digest()
  return digest.readUInt32BE(0) % 2 ** 31
}

/**
 * Refuse a shuffled step whose command cannot receive the appended flags.
 *
 * pnpm only forwards extra arguments to a script through `run`, `exec` or
 * `dlx`. The shorthand form puts pnpm's own option parser in front of them, and
 * what happens next is a version lottery. Measured on this host, appending
 * `--sequence.shuffle.files=true --sequence.seed=7` to a script that prints its
 * `process.argv`:
 *
 * | command | pnpm 9.15.9 | pnpm 10.22.0 |
 * |---|---|---|
 * | `pnpm run t <flags>` | forwarded, exit 0 | forwarded, exit 0 |
 * | `pnpm exec node probe.mjs <flags>` | forwarded, exit 0 | forwarded, exit 0 |
 * | `pnpm t <flags>` | `Unknown options`, exit 1 | exit 254, script never ran |
 * | `pnpm --filter web t <flags>` | `Unknown options`, exit 1 | **exit 0, script never ran** |
 *
 * That last cell is the reason this is a refusal and not a note. tax-agent's CI
 * runs `pnpm --filter web test`, and a config that copied the line verbatim
 * would, on pnpm 10, report a green "unit tests" step that executed zero tests.
 * A gate reporting safety it did not provide is the exact failure this module
 * exists to prevent, and the shorthand makes it silent.
 *
 * This is a static approximation — it checks the invocation SHAPE, not what the
 * runner received — so it is deliberately narrow: it fires only on commands
 * that invoke pnpm, and only on steps that get arguments appended.
 */
export function assertShuffleArgsReachTheRunner(steps: readonly SignoffStepSpec[]): void {
  for (const step of steps) {
    if (!normalizeShuffle(step.shuffle)) continue
    const tokens = step.run.split(/\s+/).filter((token) => token.length > 0)
    const pnpmAt = tokens.findIndex((token) => token === 'pnpm' || token.endsWith('/pnpm'))
    if (pnpmAt === -1) continue
    if (tokens.slice(pnpmAt + 1).some((token) => token === 'run' || token === 'exec' || token === 'dlx')) continue
    throw new Error(
      `signoff: step "${step.name}" runs \`${step.run}\` and is shuffled, but pnpm only forwards appended ` +
        'arguments to a script through `run`, `exec` or `dlx`. In the shorthand form pnpm 9 errors and pnpm 10 ' +
        'exits 0 having run nothing, which would report a passing suite that never executed. ' +
        `Write it as \`${step.run.replace(/\s(\S+)$/, ' run $1')}\`.`,
    )
  }
}

export interface StepAttemptPlan {
  readonly command: string
  readonly seed: number | null
}

function normalizeShuffle(shuffle: boolean | SignoffShuffleSpec | undefined): SignoffShuffleSpec | null {
  if (shuffle === undefined || shuffle === false) return null
  return shuffle === true ? {} : shuffle
}

/**
 * Expand one step into the commands that will actually run.
 *
 * An unshuffled step is one attempt with no seed. A shuffled step is one
 * attempt per seed, each with the seed substituted into the appended arguments.
 */
export function planAttempts(
  step: SignoffStepSpec,
  seedBase: number,
  overrideRuns?: number,
): StepAttemptPlan[] {
  const spec = normalizeShuffle(step.shuffle)
  if (!spec) return [{ command: step.run, seed: null }]

  const args = spec.args ?? DEFAULT_SHUFFLE_ARGS
  const seeds =
    spec.seeds && spec.seeds.length > 0
      ? [...spec.seeds]
      : Array.from({ length: overrideRuns ?? spec.runs ?? DEFAULT_SHUFFLE_RUNS }, (_unused, index) =>
          deriveSeed(seedBase, step.name, index),
        )

  return seeds.map((seed) => ({
    command: `${step.run} ${args.map((arg) => arg.replaceAll('{seed}', String(seed))).join(' ')}`,
    seed,
  }))
}
