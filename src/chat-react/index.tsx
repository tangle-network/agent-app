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
 * WHY THIS EXISTS. sandbox-ui already owns the composer and the picker cluster;
 * this subpath owns the app-shell ASSEMBLY over them — which controls an entry
 * surface gets, the model-id boundary, the harness-snap suppression, the submit
 * gate. Three products each re-derived that assembly and each dropped a
 * different control, so the same "shared" components produced three different
 * capability sets. One assembly, three products, domain by parameter.
 *
 * NOT canonical, and deliberately not re-exported here: `/web-react`'s own
 * `AgentSessionControls`. It predates sandbox-ui's, no product in the fleet
 * imports it, and sandbox-ui's is the richer one (backend logos, harness↔model
 * compatibility, the locked/fork trigger, three layouts). It stays exported from
 * `/web-react` because removing a published symbol is a major, but new code
 * should reach for {@link ComposerAgentControls}.
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
