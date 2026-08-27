/**
 * Sandbox-first chat composer, re-exported from `@tangle-network/sandbox-ui` so
 * agent-app apps can opt into the full profile/model/sandbox-runner/reasoning
 * control surface without wiring sandbox-ui directly. Router-only apps should
 * use `@tangle-network/agent-app/web-react`; importing this subpath requires the
 * otherwise optional `@tangle-network/sandbox-ui` peer.
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
