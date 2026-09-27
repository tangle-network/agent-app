/**
 * Read the Node pin out of the workflows that gate a merge.
 *
 * This exists because of a measured false PASS. legal-agent `4c0d688` was red
 * in CI on two test files — `Cannot bundle Node.js built-in "node:sqlite"` —
 * and the sign-off gate signed it off. Same bytes, same lockfile, same
 * hermetic tree: on Node 22 both files fail, on Node 24 both pass, 100% of the
 * time. The runtime was the whole difference, and the gate never saw it because
 * it looked for a pin in exactly two places the fleet does not keep one.
 *
 * At measurement time, none of tax-agent, legal-agent, or agent-app had an
 * `.nvmrc`.
 * All three pinned Node 22 in the merge workflow.
 * Agent App now pins Node 24.18.0 in `.nvmrc`.
 *
 * The workflow fallback reads only `pull_request` checks because those checks
 * can block a merge.
 * Agent App uses `.nvmrc` instead of this fallback.
 * Its publish workflow uses Node 24.18.0 for source checks and npm, with a
 * separate clean-runner Node 22 compatibility job.
 *
 * Nothing here guesses. An expression (`${{ matrix.node }}`) is not a version,
 * a `node-version-file` that does not exist is not a pin, and two merge-gate
 * workflows on different majors is a question this module cannot answer.
 * Each one refuses and names the config key that settles it.
 */
export interface WorkflowNodePin {
    /** Repo-relative workflow path, for the proof. */
    readonly file: string;
    /** The version as written: `22`, `24.18.0`, `v20`. */
    readonly value: string;
    /** `node-version`, or the `node-version-file` path it was read through. */
    readonly via: string;
}
/**
 * Does this workflow run on `pull_request`?
 *
 * Both spellings the fleet uses are handled: the block form every workflow here
 * writes, and the inline form (`on: [push, pull_request]`). `on` is quoted in
 * some repos because YAML 1.1 reads a bare `on` as the boolean true, so the
 * quoted keys are matched too.
 */
export declare function triggersOnPullRequest(source: string): boolean;
/** Node pins declared by every workflow that gates a merge, in filename order. */
export declare function scanMergeGateNodePins(repoRoot: string): WorkflowNodePin[];
export interface ResolvedWorkflowPin {
    readonly major: number;
    readonly declared: string;
    readonly source: string;
}
/**
 * One Node major for the whole merge gate, or a refusal that names why not.
 *
 * `majorOf` is injected rather than imported to keep the direction of the
 * dependency one-way: `node-version.ts` owns what a version string means, this
 * module owns where the string lives.
 */
export declare function resolveWorkflowNodePin(repoRoot: string, majorOf: (raw: string) => number | null): ResolvedWorkflowPin | null;
