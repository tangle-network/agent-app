/**
 * `@tangle-network/agent-app/signoff` — the local sign-off gate.
 *
 * A node-only checker a PRODUCT runs against ITSELF, the shape `/peer-floors`
 * and `/theme-contract` already established here. The difference is scope:
 * those check one property, this runs the repo's whole verification in
 * conditions that reproduce a clean CI environment, and then does what CI does
 * not.
 *
 * **Why this exists.** CI is slow enough to stop being a merge gate, and two
 * failures credited to CI in one day needed nothing CI has:
 *
 *  - Two legal-agent test files failed only in CI with "Cannot bundle Node.js
 *    built-in node:sqlite". Local passed three separate ways — cleared Vite
 *    cache, its own `node_modules`, even `--maxWorkers=1`. CI was not smarter;
 *    it was a clean install with different file scheduling.
 *  - legal-agent `main` went red because a sibling PR called a function an
 *    older agent-app did not export — invisible to a clean install, a clean
 *    typecheck and a green suite, and caught only by `/peer-floors` at the
 *    wire call.
 *
 * Neither is a reason to keep CI as the gate. Both are reasons the local run
 * must be hermetic. That is what this is:
 *
 * | | CI | this gate |
 * |---|---|---|
 * | dependency tree | clean, isolated store | clean `git worktree`, store keyed on the lockfile |
 * | suite order | one arbitrary order | randomized file order, ≥2 seeds, every seed recorded |
 * | step order | serial, as written in YAML | dependency graph, run as wide as the DECLARED edges allow |
 * | failure output | one red line in a long log | named step, exit code, seed, captured output |
 * | reproducibility | re-run the job and hope | one command, printed with the verdict |
 *
 * ```ts
 * import { runSignoff, formatSignoffReport } from '@tangle-network/agent-app/signoff'
 *
 * const report = await runSignoff({ repoDir: process.cwd() })
 * console.log(formatSignoffReport(report))
 * process.exit(report.ok ? 0 : 1)
 * ```
 *
 * The CLI form is the `agent-app-signoff` bin.
 */

export { runSignoff, type RunSignoffOptions } from './run'
export {
  SIGNOFF_CONFIG_FILES,
  deriveSignoffConfig,
  loadSignoffConfig,
  parseSignoffConfig,
  type LoadSignoffConfigOptions,
} from './config'
export { formatSignoffLine, formatSignoffReport, peakConcurrency } from './report'
export { assertNodeVersion, resolveNodeRequirement, type NodeVersionRequirement } from './node-version'
export { runGraph, validateGraph, type GraphNode, type RunGraphOptions, type TaskOutcome, type TaskStatus } from './schedule'
export {
  assertShuffleArgsReachTheRunner,
  DEFAULT_SHUFFLE_ARGS,
  DEFAULT_SHUFFLE_RUNS,
  deriveSeed,
  newSeedBase,
  planAttempts,
  type StepAttemptPlan,
} from './seeds'
export {
  resolveWorkflowNodePin,
  scanMergeGateNodePins,
  triggersOnPullRequest,
  type ResolvedWorkflowPin,
  type WorkflowNodePin,
} from './workflow-pin'
export {
  MANIFEST_FILES,
  manifestCacheKey,
  manifestFiles,
  resolveStore,
  type ResolveStoreOptions,
  type StoreResolution,
} from './store'
export {
  materializeCleanTree,
  removeCleanTree,
  repoRootOf,
  type CleanTree,
  type MaterializeOptions,
} from './workspace'
export { runCommand, type CommandResult, type RunCommandOptions } from './exec'
export type {
  LoadedSignoffConfig,
  SignoffAttempt,
  SignoffConfig,
  SignoffConfigOrigin,
  SignoffEvent,
  SignoffHostFacts,
  SignoffInstallResult,
  SignoffInstallSpec,
  SignoffRepoFacts,
  SignoffReport,
  SignoffShuffleSpec,
  SignoffSource,
  SignoffStepResult,
  SignoffStepSpec,
  SignoffStepStatus,
} from './types'
