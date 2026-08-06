/**
 * The vocabulary the composer surfaces speak, re-exported from the packages that
 * OWN it rather than redefined here — a second spelling of `HarnessType` is how
 * two products end up disagreeing about what a backend is called.
 *
 * `HarnessType` is agent-interface's enum surfaced through sandbox-ui's picker;
 * `ReasoningLevel` is sandbox-ui's `auto | ReasoningEffort` union.
 *
 * LEGACY: these spellings serve the deprecated `ComposerAgentControls` adapter.
 * Canonical code speaks `/harness`'s `Harness` union and plain effort-id
 * strings (see `/web-react`'s `EffortPicker`); they are re-exported here only
 * so the legacy adapter's props keep resolving.
 */
export type { HarnessType } from '@tangle-network/sandbox-ui/dashboard'
export type { ModelInfo } from '@tangle-network/sandbox-ui/dashboard'
export type {
  AgentProfileCapability,
  AgentProfileDraft,
  AgentProfileOption,
  ReasoningLevel,
} from '@tangle-network/sandbox-ui/chat'
export type { ReasoningEffort } from '@tangle-network/agent-interface'

export interface ComposerPlanModeSelection {
  enabled: boolean
  setEnabled: (next: boolean) => void
  saving?: boolean
}
