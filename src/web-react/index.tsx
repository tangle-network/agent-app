/**
 * `@tangle-network/agent-app/web-react` — the shared chat-shell components
 * every agent app's web UI hand-rolls: a model picker over the runtime's
 * model catalogue, a reasoning-effort selector, and a message thread with
 * User/Agent identity, per-message model + cost + tokens/sec metrics,
 * canonical tool rows, and the shared reasoning row (`ReasoningRow`).
 *
 * Works for BOTH chat shapes: router-backed copilots (LoopEvents from
 * `runtime/openai-stream`) and sandbox-backed chats — the thread renders
 * `ChatUiMessage`s; how they're produced is the app's business.
 *
 * Styling contract: Tailwind classes against the shared design tokens
 * (`bg-card`, `border-border`, `text-muted-foreground`, `bg-primary`, …) that
 * Tangle app shells define. No icon library of its own — the few local glyphs
 * are inline SVGs. Markdown and provider logos are injected (`renderMarkdown`,
 * `renderProviderBadge`).
 *
 * Tool rows compose the canonical run-row grammar from `@tangle-network/ui`
 * (`InlineToolItem` over `RunRowShell`): `chatToolCallPart` adapts each
 * `ChatToolCallInfo` to ui's `ToolPart` (the same adapter pattern ui's own
 * `ToolCallStep` uses), so the chat surface and every other Tangle run view
 * share one row implementation instead of drifting. That makes
 * `@tangle-network/ui` a peer of this subpath.
 */

export * from './chat-stream'
export { TurnProgress, type TurnProgressProps } from './turn-progress'
export { ReasoningRow, type ReasoningRowProps } from './reasoning-row'
export { useChatScroll } from './chat-scroll'
export * from './chat-interactions'
export * from './chat-composer'
export * from './workspace-prewarm'
export { getChatFundingRecovery, type ChatFundingFailure, type ChatFundingRecovery } from './turn-funding-recovery'
export { RouteChunkBoundary, lazyRoute, preloadWhenIdle, type LazyRoute, type RouteChunkBoundaryProps } from './lazy-load-boundary'
export * from './agent-profile-editor'
export type { ResourceFileLimits } from './agent-profile-files'
export * from './agent-profile-registry'
export * from './agent-profile-viewer'
export * from './composer-file-accept'
export * from './interaction-card-support'
export * from './interaction-question-card'
export * from './interaction-plan-card'
export * from './durable-plan-flow'
export * from './durable-plan-card'
export * from './durable-chat-cards'
export * from './durable-interaction-submit'
export * from './use-chat-interactions'
export * from './use-file-mentions'
export * from './chat-mentions'
export * from './mention-pill'
export * from './entry-composer'
export * from './composer-mode-controls'
export * from './chat-attachments'
export * from './message-attachments'
export * from './use-composer-attachments'
export * from './provider-logo'
export * from './harness-glyphs'
export * from './smooth-text'
export * from './mission-activity'
export * from './work-product'
export * from './provenance'
export * from './sandbox-terminal'
export * from './seat-paywall'
export * from './session-history'
export * from './record-grid'
export * from './command-palette'
export * from './sparkline'
export * from './insight-card'
export { ReviewInbox, type ReviewInboxItem, type ReviewInboxFeedback, type ReviewInboxProps } from './review-inbox'
export { ReviewFeedbackForm, type ReviewFeedbackFormProps, type ReviewFeedbackFormHandle, type ReviewFeedbackDraft, type ReviewVerdict } from '../hub-approvals-react/feedback'
export * from './use-dictation'
export {
  usePopover,
  usePending,
  PopoverSurface,
  POPOVER_SURFACE_ATTR,
  ModelPicker,
  formatModelPrice,
  EffortPicker,
  EffortMeter,
  effortMeterFill,
  effortLevelLabel,
  effortLevelsFromIds,
  reconcileEffortLevels,
  DEFAULT_EFFORT_LEVELS,
  EFFORT_METER_SEGMENTS,
  OVERLAY_SHADOW,
  fieldPickerTriggerClass,
  type ModelPickerProps,
  type EffortPickerProps,
  type EffortLevel,
  type PickerVariant,
  type PopoverSurfaceProps,
} from './controls'
export {
  AgentSessionControls,
  HarnessPicker,
  type AgentSessionControlsProps,
  type HarnessPickerProps,
} from './agent-session-controls'
export type { CatalogModel } from '../runtime/model-catalog'
export * from './chat-message-types'
export * from './chat-message-metrics'
export * from './run-drill-in'
export * from './chat-empty-state'
export { pendingApprovalOf, chatToolCallPart } from './chat-tool-call'
export { ChatMessages, useThinkingSeconds } from './chat-messages'
export * from './api-access-panel'
export * from './agent-setup-block'

export * from './agent-settings-popover'
export * from './workspace-switcher'

export * from './agent-profile-choices'
export * from './composer-profile-pill'
