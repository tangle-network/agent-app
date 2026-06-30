/**
 * The canonical agent chat composer, re-exported from `@tangle-network/sandbox-ui`
 * so agent-app apps adopt the one shared input box — model · harness · effort ·
 * agent-profile, with harness↔model snapping — without each wiring sandbox-ui
 * directly. Opt-in subpath: importing it requires the (otherwise optional)
 * `@tangle-network/sandbox-ui` peer, so apps that don't use the composer pay
 * nothing. Prefer this over agent-app's legacy `web-react` composer for new UI.
 */
export {
  AgentComposer,
  type AgentComposerProps,
  AgentProfilePicker,
  type AgentProfilePickerProps,
  type AgentProfileOption,
  type AgentProfileCapability,
  type AgentProfileDraft,
  AgentSessionControls,
  type AgentSessionControlsProps,
  type AgentSessionHarnessControl,
  type AgentSessionModelControl,
  type AgentSessionProfileControl,
  type AgentSessionReasoningControl,
  ReasoningLevelPicker,
  type ReasoningLevel,
  type ReasoningLevelOption,
  DEFAULT_REASONING_LEVEL_OPTIONS,
  snapModelToHarness,
  snapHarnessToModel,
  isModelCompatibleWithHarness,
} from "@tangle-network/sandbox-ui/chat";

export {
  type ModelInfo,
  type HarnessType,
} from "@tangle-network/sandbox-ui/dashboard";
