/**
 * `@tangle-network/agent-app/chat-react` — the chat-composer surfaces that need
 * `@tangle-network/sandbox-ui`.
 *
 * Isolated behind its own entry for the OPTIONAL-PEER rule: sandbox-ui is an
 * optional peer of this package, so a subpath that imports it must never be
 * reachable from one that does not. `/web-react` stays sandbox-ui-free; anything
 * that renders sandbox-ui's `AgentComposer` / `AgentSessionControls` lives here.
 * (Same rule, same shape as `/work-product-react`.)
 *
 * WHY THIS EXISTS. sandbox-ui owns the composer chrome; this subpath owns the
 * app-shell ASSEMBLY over it — which controls an entry surface gets, the
 * model-id boundary, the harness-snap suppression, the submit gate. Three
 * products each re-derived that assembly and each dropped a different control,
 * so the same "shared" components produced three different capability sets. One
 * assembly, three products, domain by parameter.
 *
 * PICKER CANON. The pickers this subpath renders are NOT the canonical ones:
 * `ComposerAgentControls` adapts sandbox-ui's legacy `AgentSessionControls` and
 * is deprecated with it (removed at sandbox-ui's next major). The canonical
 * model/effort/harness cluster is `/web-react`'s `AgentSessionControls`, whose
 * model menu IS the canonical `ModelPicker` — see "UI chrome ownership (picker
 * canon)" in AGENTS.md and the migration note in `docs/ui-picker-canon.md`.
 * The exports below stay working; new code must not adopt them.
 */

export {
  ComposerAgentControls,
  type ComposerAgentControlsProps,
  type ComposerProfileSelection,
  type ComposerModelSelection,
  type ComposerHarnessSelection,
  type ComposerEffortSelection,
} from './composer-agent-controls'

export { EntryComposer, type EntryComposerProps } from './entry-composer'
export {
  ComposerModeControls,
  type ComposerModeControlsProps,
} from './composer-mode-controls'

export type {
  AgentProfileCapability,
  AgentProfileDraft,
  AgentProfileOption,
  ComposerPlanModeSelection,
  HarnessType,
  ModelInfo,
  ReasoningEffort,
  ReasoningLevel,
} from './types'
