/**
 * `@tangle-network/agent-app/assistant` — the in-app assistant/copilot surface,
 * portable across hosts. A host supplies a transport via {@link createAssistantClient}
 * and {@link AssistantClientProvider}; the dock, panel, hooks, and proposal card
 * consume it and render on web-react's chat components (`ChatComposer`,
 * `ChatMessages`, `ModelPicker`). The markdown renderer, per-tool detail
 * renderers, and workflow-graph renderer are injected so this subpath carries no
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
  adaptTranscript,
  assistantIsThinking,
} from "./transcript";
export { ProposalCard, type ProposalCardProps } from "./ProposalCard";
export {
  AssistantLauncherProvider,
  useAssistantLauncher,
  type AssistantLauncher,
} from "./launcher";
