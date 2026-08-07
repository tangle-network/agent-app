/**
 * `@tangle-network/agent-app/chat-react` — the chat-composer surfaces that need
 * `@tangle-network/sandbox-ui`.
 *
 * Isolated behind its own entry for the OPTIONAL-PEER rule: sandbox-ui is an
 * optional peer of this package, so a subpath that imports it must never be
 * reachable from one that does not. `/web-react` stays sandbox-ui-free; anything
 * that renders sandbox-ui's `AgentComposer` lives here. (Same rule, same shape
 * as `/work-product-react`.)
 *
 * WHY THIS EXISTS. sandbox-ui owns the composer chrome; this subpath owns the
 * app-shell ASSEMBLY over it — which controls an entry surface gets, the
 * submit gate. Three products each re-derived that assembly and each dropped a
 * different control, so the same "shared" components produced three different
 * capability sets. One assembly, three products, domain by parameter.
 *
 * PICKER CANON. The agent-identity controls an `EntryComposer` renders are the
 * canonical ones: its `agent` prop is `AgentSessionControlsProps` and the row
 * is `/web-react`'s `AgentSessionControls`, whose model menu IS the canonical
 * `ModelPicker` — see "UI chrome ownership (picker canon)" in AGENTS.md and
 * `docs/ui-picker-canon.md`. The legacy `ComposerAgentControls` adapter over
 * sandbox-ui's strip was REMOVED (it was deprecated-first); products still on
 * it migrate per the props mapping in that doc.
 */

export { EntryComposer, type EntryComposerProps } from './entry-composer'
export {
  ComposerModeControls,
  type ComposerModeControlsProps,
} from './composer-mode-controls'

export type { ComposerPlanModeSelection } from './types'
