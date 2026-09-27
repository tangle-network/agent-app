import type { SignoffEvent, SignoffReport, SignoffSource } from './types';
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
    readonly repoDir?: string;
    readonly configPath?: string;
    /** Default `working-tree` — verify what you are about to commit. */
    readonly source?: SignoffSource;
    /** Run every step even after one fails. Default false. */
    readonly keepGoing?: boolean;
    /** Base seed. Pass a previous run's to reproduce it exactly. */
    readonly seed?: number;
    readonly maxParallel?: number;
    readonly cacheDir?: string;
    /** Override every shuffled step's run count. */
    readonly shuffleRuns?: number;
    /** Keep the clean tree for inspection instead of removing it. */
    readonly keepWorkspace?: boolean;
    readonly onEvent?: (event: SignoffEvent) => void;
}
export declare function runSignoff(options?: RunSignoffOptions): Promise<SignoffReport>;
