/**
 * Refuse to sign off on a runtime the product does not ship.
 *
 * CI pins its Node version (`actions/setup-node` with `node-version: 22` in all
 * three fleet workflows). A developer's shell does not — this host runs 24. A
 * local gate that inherits whatever is on `PATH` therefore verifies a runtime
 * nobody deploys, and reports it as the runtime that ships. That is the same
 * failure shape as a number measured in a narrower context than it is
 * presented in, and it is not acceptable in the thing that replaces the merge
 * gate.
 *
 * So the pin is read from the repo and enforced, or it is absent and the report
 * says so. Three sources, in order:
 *
 *  - `signoff.config.mjs`'s `nodeVersion` — the explicit declaration.
 *  - `.nvmrc` — the pin a repo already keeps for humans.
 *  - the `pull_request` workflows' `node-version` (`./workflow-pin`) — the pin
 *    CI itself runs on.
 *
 * **The third source was added because the first two were empty on the entire
 * fleet, and that produced a false PASS.** legal-agent `4c0d688` failed CI on
 * `Cannot bundle Node.js built-in "node:sqlite"` and this gate signed it off.
 * Reproduced in one installed tree, same bytes: Node 22 fails both files, Node
 * 24 passes both, every time. No `.nvmrc` exists in tax-agent, legal-agent or
 * agent-app; all three pin `node-version: 22` in the workflow being replaced.
 * A gate that replaces a workflow has to read the runtime that workflow pins.
 *
 * A `.nvmrc` and a workflow that disagree is not resolved by preference — it is
 * a refusal, because it means the local gate and CI verify different runtimes,
 * which is the exact defect this module exists to prevent.
 *
 * **`engines.node` is deliberately NOT read.** It is a floor (`">=18"`), not a
 * pin, so treating it as one manufactures refusals on every version above the
 * floor — and an unsatisfiable gate does not stop bad work, it gets waived.
 */
export interface NodeVersionRequirement {
    /** The declared major, e.g. `22`. */
    readonly major: number;
    readonly declared: string;
    /** Where it came from, for the proof. */
    readonly source: string;
}
export declare function resolveNodeRequirement(repoRoot: string, configured?: string): NodeVersionRequirement | null;
/**
 * Throw when the running Node cannot stand in for the declared one.
 *
 * Major-only: a patch difference is not a different runtime, and demanding an
 * exact patch would refuse every host that has not just re-installed.
 */
export declare function assertNodeVersion(requirement: NodeVersionRequirement | null, running?: string): void;
/** Refuse Node declaration files for a different runtime major. */
export declare function assertNodeTypesVersion(repoRoot: string, requirement: NodeVersionRequirement | null): void;
