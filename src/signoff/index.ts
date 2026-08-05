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
 *
 * **Surface is deliberately narrow.** The steps this runs — dependency-graph
 * scheduling, seed planning, workflow-YAML pin scanning, the pnpm-store cache,
 * the hermetic `git worktree`, the command runner — are this gate's OWN
 * implementation, not things a consumer plausibly calls directly; the `agent-
 * app-signoff` bin imports them from the sibling files (`./run`, `./report`),
 * never through this barrel. What a consumer embeds is: run the gate, load its
 * config, print the result. Everything else stays module-internal, where
 * `knip` can see it unused rather than reading as committed public API with
 * zero callers.
 */

export { runSignoff, type RunSignoffOptions } from './run'
export { loadSignoffConfig, type LoadSignoffConfigOptions } from './config'
export { formatSignoffReport } from './report'
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
