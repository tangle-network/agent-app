import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveWorkflowNodePin } from './workflow-pin'

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
  readonly major: number
  readonly declared: string
  /** Where it came from, for the proof. */
  readonly source: string
}

/** Leading major from a pin like `22`, `v22.22.3`, `22.22`, `lts/iron` (none). */
function majorOf(raw: string): number | null {
  const match = /^v?(\d+)(?:\.|$)/.exec(raw.trim())
  return match?.[1] === undefined ? null : Number.parseInt(match[1], 10)
}

export function resolveNodeRequirement(
  repoRoot: string,
  configured?: string,
): NodeVersionRequirement | null {
  if (configured !== undefined) {
    const major = majorOf(configured)
    if (major === null) {
      throw new Error(
        `signoff: nodeVersion "${configured}" does not start with a major version. ` +
          'Declare a pin like "22" or "22.22.3".',
      )
    }
    return { major, declared: configured.trim(), source: 'signoff config `nodeVersion`' }
  }

  let fromNvmrc: NodeVersionRequirement | null = null
  const nvmrc = join(repoRoot, '.nvmrc')
  if (existsSync(nvmrc)) {
    const raw = readFileSync(nvmrc, 'utf8').trim()
    const major = majorOf(raw)
    // An alias (`lts/iron`) is a pin this module cannot resolve without a
    // network call, so it is reported as no requirement rather than guessed.
    if (major !== null) fromNvmrc = { major, declared: raw, source: '.nvmrc' }
  }

  const fromWorkflow = resolveWorkflowNodePin(repoRoot, majorOf)
  if (fromNvmrc && fromWorkflow && fromNvmrc.major !== fromWorkflow.major) {
    throw new Error(
      `signoff: .nvmrc pins Node ${fromNvmrc.declared} and ${fromWorkflow.source} pins ` +
        `${fromWorkflow.declared}. A sign-off that replaces CI cannot verify two runtimes, and picking ` +
        'one silently would sign off a runtime the other half of the repo says is wrong. Make them agree, ' +
        'or declare `nodeVersion` in the signoff config.',
    )
  }
  if (fromNvmrc) return fromNvmrc
  if (fromWorkflow) return { ...fromWorkflow, source: fromWorkflow.source }
  return null
}

/**
 * Throw when the running Node cannot stand in for the declared one.
 *
 * Major-only: a patch difference is not a different runtime, and demanding an
 * exact patch would refuse every host that has not just re-installed.
 */
export function assertNodeVersion(requirement: NodeVersionRequirement | null, running = process.version): void {
  if (!requirement) return
  const runningMajor = majorOf(running)
  if (runningMajor === requirement.major) return
  throw new Error(
    `signoff: this repo pins Node ${requirement.declared} (${requirement.source}) and you are running ${running}. ` +
      'A sign-off that replaces CI has to verify the runtime the product ships, so this refuses rather than ' +
      `reporting a pass it did not earn. Switch with \`nvm use ${requirement.major}\`, or change the pin if the ` +
      'product really has moved.',
  )
}
