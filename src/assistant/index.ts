/**
 * `@tangle-network/agent-app/assistant` — the in-app assistant/copilot surface,
 * portable across hosts. A host supplies a transport via {@link createAssistantClient}
 * and {@link AssistantClientProvider}; the dock, panel, hooks, and proposal card
 * consume it. The conversation renders on the main chat's primitives
 * (`@tangle-network/ui` `AgentTimeline` and `InlineToolItem`) and the composer
 * on web-react's `ChatComposer` and `ModelPicker`. Per-tool detail renderers and
 * the workflow-graph renderer are injected so this subpath carries no
 * product-specific dependency.
 */

export * from "./types";
export * from "./client";
export * from "./client-context";
export {
  useAssistantChat,
  type AssistantChat,
  type AssistantSendOptions,
  type UseAssistantChatOptions,
} from "./useAssistantChat";
export { useAssistantModels } from "./useAssistantModels";
export { useAssistantThreads, type AssistantThreads } from "./useAssistantThreads";

export { AssistantDock, type AssistantDockProps } from "./AssistantDock";
export { AssistantPanel, type AssistantPanelProps } from "./AssistantPanel";
export {
  AssistantTranscript,
  type AssistantTranscriptProps,
  type AssistantTimelineOptions,
  buildAssistantTimeline,
  assistantIsThinking,
} from "./transcript";
export { ProposalCard, type ProposalCardProps } from "./ProposalCard";
export {
  AssistantLauncherProvider,
  useAssistantLauncher,
  useAssistantPageLabel,
  type AssistantLauncher,
  type AssistantPanelLayout,
} from "./launcher";
export { MIN_PAGE_WIDTH, MIN_PANEL_WIDTH } from "./usePanelPrefs";
export {
  useDocumentPageContext,
  pageLabelFromTitle,
  type DocumentPageContextOptions,
} from "./page-context";
export {
  AssistantPanelToggle,
  type AssistantPanelToggleProps,
  ASSISTANT_PANEL_ID,
  assistantShortcutLabel,
} from "./panel-toggle";
