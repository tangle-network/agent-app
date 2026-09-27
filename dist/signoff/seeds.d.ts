import type { SignoffStepSpec } from './types';
export declare const DEFAULT_SHUFFLE_RUNS = 2;
/** A fresh base seed. Random, then recorded — never a fixed constant, or the
 *  "randomized" order is one more fixed order. */
export declare function newSeedBase(): number;
/**
 * Derive a step's Nth seed from the base.
 *
 * A hash rather than `base + n`: adjacent seeds produce correlated orders in
 * some runners, and the point is independent samples of the order space.
 */
export declare function deriveSeed(base: number, stepName: string, index: number): number;
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
export declare function assertShuffleArgsReachTheRunner(steps: readonly SignoffStepSpec[]): void;
export interface StepAttemptPlan {
    readonly command: string;
    readonly seed: number | null;
}
/**
 * Expand one step into the commands that will actually run.
 *
 * An unshuffled step is one attempt with no seed. A shuffled step is one
 * attempt per seed, each with the seed substituted into the appended arguments.
 */
export declare function planAttempts(step: SignoffStepSpec, seedBase: number, overrideRuns?: number): StepAttemptPlan[];
