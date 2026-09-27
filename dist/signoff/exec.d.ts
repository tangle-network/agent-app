/**
 * The subprocess primitive every sign-off step runs through.
 *
 * Three properties the gate depends on, none of which `execSync` gives:
 *
 * 1. **Cancellable.** Under fail-fast, a build still running when typecheck
 *    fails is killed rather than waited out — otherwise the "faster than CI"
 *    claim is spent waiting for work whose verdict no longer matters.
 * 2. **Process-group kill.** Steps run through `sh -c`, so killing the shell
 *    leaves `vitest`'s forks and `tsup`'s dts worker orphaned and holding CPU.
 *    The child is spawned as a group leader and the whole group is signalled.
 * 3. **Bounded, non-silent capture.** Output is capped, and when the cap is hit
 *    the elision is stated in the captured text. A gate that quietly drops the
 *    middle of a failure log is a gate that hides the failure.
 */
export interface CommandResult {
    readonly command: string;
    readonly cwd: string;
    readonly exitCode: number;
    readonly signal: string | null;
    readonly durationMs: number;
    readonly output: string;
    readonly truncated: boolean;
    readonly timedOut: boolean;
}
export interface RunCommandOptions {
    readonly command: string;
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    /** Retained bytes before elision. Default 2 MiB. */
    readonly maxOutputBytes?: number;
    /** Grace between SIGTERM and SIGKILL. Default 5 s. */
    readonly killGraceMs?: number;
    readonly onData?: (chunk: string) => void;
}
/**
 * Run one shell command to completion and report what happened.
 *
 * Never throws on a non-zero exit — a failing step is data, not an exception.
 * It throws only when the process could not be started at all.
 */
export declare function runCommand(options: RunCommandOptions): Promise<CommandResult>;
