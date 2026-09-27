/**
 * `@tangle-network/agent-app/web-react` — the shared chat-shell components
 * every agent app's web UI hand-rolls: a model picker over the runtime's
 * model catalogue, a reasoning-effort selector, and a message thread with
 * User/Agent identity, per-message model + cost + tokens/sec metrics,
 * canonical tool rows, and a collapsible thinking section.
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
import { type ReactNode } from 'react';
import type { ToolPart } from '@tangle-network/ui/types';
import { type DurableChatCardsProps } from './durable-chat-cards';
import { type ChatAttachmentPart } from './chat-attachments';
import type { WorkProductPersistedPart } from '../work-product/types';
export * from './chat-stream';
export * from './chat-interactions';
export * from './chat-composer';
export * from './composer-file-accept';
export * from './interaction-card-support';
export * from './interaction-question-card';
export * from './interaction-plan-card';
export * from './durable-plan-flow';
export * from './durable-plan-card';
export * from './durable-chat-cards';
export * from './durable-interaction-submit';
export * from './use-chat-interactions';
export * from './use-file-mentions';
export * from './chat-mentions';
export * from './mention-pill';
export * from './entry-composer';
export * from './composer-mode-controls';
export * from './chat-attachments';
export * from './message-attachments';
export * from './use-composer-attachments';
export * from './provider-logo';
export * from './harness-glyphs';
export * from './smooth-text';
export * from './mission-activity';
export * from './work-product';
export * from './provenance';
export * from './sandbox-terminal';
export * from './seat-paywall';
export * from './session-history';
export * from './record-grid';
export * from './command-palette';
export * from './sparkline';
export * from './insight-card';
export * from './use-dictation';
export { usePopover, usePending, PopoverSurface, POPOVER_SURFACE_ATTR, ModelPicker, EffortPicker, EffortMeter, effortMeterFill, effortLevelLabel, effortLevelsFromIds, reconcileEffortLevels, DEFAULT_EFFORT_LEVELS, EFFORT_METER_SEGMENTS, OVERLAY_SHADOW, type ModelPickerProps, type EffortPickerProps, type EffortLevel, type PickerVariant, type PopoverSurfaceProps, } from './controls';
export { AgentSessionControls, type AgentSessionControlsProps, } from './agent-session-controls';
import type { CatalogModel } from '../runtime/model-catalog';
export type { CatalogModel } from '../runtime/model-catalog';
/** Describe metrics related to a chat message including model, token counts, and duration */
export interface ChatMessageMetrics {
    modelUsed?: string;
    promptTokens?: number;
    completionTokens?: number;
    durationMs?: number;
}
/** "$0.0042" from token counts × catalogue per-token pricing; null when unknown. */
export declare function formatModelCost(msg: ChatMessageMetrics, models: CatalogModel[]): string | null;
/** "38 tok/s" from completion tokens over first-token→end duration; null when unknown. */
export declare function formatTokensPerSecond(msg: ChatMessageMetrics): string | null;
/** One step of a retained tool run (e.g. a sandbox command + its output). */
export interface ToolRunStep {
    at: string;
    label: string;
    detail?: string;
    status?: 'ok' | 'error';
}
/** A retained tool run keyed by the parent message's toolCallId. The product
 *  persists these server-side (fail-closed: only ids its own loop created)
 *  and serves them to the drill-in panel. */
export interface ToolRunRecord {
    toolCallId: string;
    toolName: string;
    title: string;
    status: 'running' | 'complete' | 'error';
    steps: ToolRunStep[];
}
/** Define properties required to run a drill and handle its closure event */
export interface RunDrillInProps {
    run: ToolRunRecord;
    onClose: () => void;
}
/**
 * Readonly side panel showing a retained tool run's transcript — the
 * "drill into what the sandbox actually did" view. Follow-ups happen in the
 * main chat, never here.
 */
export declare function RunDrillIn({ run, onClose }: RunDrillInProps): import("react").JSX.Element;
/** Describe the structure and state of a tool call within a chat interaction */
export interface ChatToolCallInfo {
    id: string;
    name: string;
    status: 'running' | 'done' | 'error';
    /** The call arguments, captured from the tool_call event — shown in the
     *  expanded card so users see exactly what the agent invoked. */
    args?: Record<string, unknown>;
    /** The tool outcome (`{ok, result}` shape). When `result.status` is
     *  'queued_for_approval' the card renders the approval state. */
    result?: unknown;
}
/** Extract `{proposalId, status}` from a tool outcome when it is a proposal
 *  awaiting human approval; null otherwise. */
export declare function pendingApprovalOf(call: ChatToolCallInfo): {
    proposalId: string;
} | null;
/** One ordered piece of an assistant turn: a run of answer text, or a tool
 *  call, in the sequence the agent emitted them. A message carrying `segments`
 *  is rendered in order — interleaving text and tool rows — so the agent's
 *  pre- and post-tool reasoning reads chronologically instead of as one text
 *  blob with the tool rows collected after it. */
export type ChatMessageSegment = {
    kind: 'text';
    content: string;
} | {
    kind: 'tool';
    call: ChatToolCallInfo;
};
/** Describe the structure and properties of a chat message with roles, content, and optional metadata */
export interface ChatUiMessage extends ChatMessageMetrics {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    reasoning?: string;
    toolCalls?: ChatToolCallInfo[];
    /** Ordered text/tool sequence for true chronological interleaving. When
     *  present and non-empty it is rendered in place of `content` + `toolCalls`;
     *  both remain the fallback for producers that don't segment a turn. */
    segments?: ChatMessageSegment[];
    /** Persisted assistant parts. When `ChatMessages.durableCards` is supplied,
     * shared plan/question cards render directly from these projections. */
    parts?: Array<Record<string, unknown>>;
}
/** Define properties for rendering chat messages with optional models, markdown, extras, and durable cards */
export interface ChatMessagesProps {
    messages: ChatUiMessage[];
    /** Shared reading scale for both user and assistant prose. Defaults to 16px
     *  at a 1.6 line height; `large` uses 17px at the same leading without
     *  enlarging labels, tool chrome, or metadata. */
    messageSize?: 'default' | 'large';
    /** Transcript chrome. `labeled` (default) keeps the always-on role label +
     *  model/tok-s/cost meta line and the primary-tinted user bubble. `quiet`
     *  drops the label row into a fixed-height meta lane at each row's bottom
     *  (copy + the demoted meta, revealed on hover/focus, always visible on
     *  touch) and renders user bubbles neutral with a symmetric radius.
     *  Everything else — tool rows, reasoning, streaming — is identical. */
    chrome?: 'labeled' | 'quiet';
    /** Catalogue models, for per-message cost from pricing. Pass [] to skip cost. */
    models?: CatalogModel[];
    /** Markdown renderer for assistant content; default renders pre-wrapped text. */
    renderMarkdown?: (content: string) => ReactNode;
    /** Extra per-message content (artifacts, custom panels) appended after the body. */
    renderExtras?: (message: ChatUiMessage) => ReactNode;
    /** Canonical durable plan/question card wiring. Apps inject only transport,
     * access, and optional visual callbacks; card selection/dedupe stays shared. */
    durableCards?: Omit<DurableChatCardsProps, 'parts' | 'renderMarkdown'>;
    userLabel?: string;
    agentLabel?: string;
    /** Render the trailing "agent is thinking" row. */
    loading?: boolean;
    /** Approve/Reject handlers for proposals awaiting approval. When omitted the
     *  card still shows "awaiting approval" but without action buttons. */
    approval?: ProposalApprovalHandlers;
    /** Open a full-transcript view (e.g. {@link RunDrillIn}) from a tool row's
     *  actions slot. */
    onToolCallClick?: (call: ChatToolCallInfo, message: ChatUiMessage) => void;
    /** Per-tool custom detail renderers for the expanded tool row body. */
    toolRenderers?: ToolDetailRenderers;
    /** Stream-error affordance: when the turn failed (a thrown transport error or
     *  a loop-level `onErrorEvent`), pass the message here to render an error row.
     *  A failed turn otherwise just stops with no UI signal. */
    error?: string | null;
    /** Retry control shown on the error row; omit to render the error without a
     *  retry button (e.g. when the product retries automatically). */
    onRetry?: () => void;
    /** Zero-state renderer, shown when there are no messages and the turn is
     *  neither loading nor errored. When omitted, a branded first-run state is
     *  shown ({@link ChatEmptyState}); pass `() => null` to render nothing. */
    renderEmpty?: () => ReactNode;
    /** First-run state config used when `renderEmpty` is not supplied. Lets a
     *  product set the headline and the "doors" (e.g. start from a template, ask
     *  the agent) without replacing the whole zero-state. */
    emptyState?: ChatEmptyStateProps;
    /** Optional branded header slot rendered above the thread. Off by default to
     *  preserve the current layout; pass `{ title }` (or your own node via
     *  `header`) to show the Tangle mark + product title in the chat shell. */
    header?: ReactNode;
    /** Resolve a raw-bytes download URL for one attachment part. When set, any
     *  message carrying attachment parts (`file`/`image` parts with a `path`,
     *  see `attachmentPartsFromMessageParts`) renders them as a `MessageAttachments`
     *  row next to the bubble — thumbnails for images, download chips for files.
     *  Absent → today's rendering, byte-identical (no attachment row). */
    resolveAttachmentUrl?: (part: ChatAttachmentPart) => string;
    /** Render persisted `type:'work_product'` anchor parts as `WorkProductCard`
     *  rows under the message body — the chat card that keeps chat the driver
     *  surface for review. `onOpen` opens the product's queue/detail surface.
     *  Absent → today's rendering, byte-identical (no card row). */
    workProductCards?: {
        onOpen?: (part: WorkProductPersistedPart) => void;
    };
}
/** One starting "door" in the chat first-run state — a concrete, labeled action
 *  (start from a template, do it by hand, ask the agent), not a placeholder. */
export interface ChatEmptyDoor {
    label: string;
    description?: string;
    onSelect: () => void;
    /** Optional glyph rendered left of the label. */
    icon?: ReactNode;
}
/** Define properties for rendering the chat empty state with customizable text and starting doors */
export interface ChatEmptyStateProps {
    /** Product name shown next to the Tangle mark. Default "Agent". */
    productName?: string;
    /** Headline. Default frames delegation, not messaging. */
    headline?: string;
    /** Subline under the headline. */
    subline?: string;
    /** Up to three concrete starting doors. Omit for a mark-and-prompt-only state. */
    doors?: ChatEmptyDoor[];
}
/**
 * Branded chat first-run state: the Tangle mark, a delegation-framed prompt, and
 * up to three concrete doors. Replaces the blank thread that read as "empty or
 * broken". Concrete + actionable — never a "coming soon" placeholder.
 */
export declare function ChatEmptyState({ productName, headline, subline, doors, }: ChatEmptyStateProps): import("react").JSX.Element;
/** Handle approval and rejection actions for proposals with asynchronous support */
export interface ProposalApprovalHandlers {
    onApprove: (proposalId: string, toolCallId: string) => void | Promise<void>;
    onReject: (proposalId: string, toolCallId: string) => void | Promise<void>;
}
/** Per-tool custom detail renderers for the expanded card body — keyed by
 *  tool name. Return null to fall back to the generic detail view. */
export type ToolDetailRenderers = Record<string, (call: ChatToolCallInfo, message: ChatUiMessage) => ReactNode>;
/**
 * Adapt a chat tool call to the canonical `@tangle-network/ui` `ToolPart`, so
 * the row renders through ui's `InlineToolItem` — one run-row grammar shared
 * with every other Tangle run view (the same adapter pattern ui's own
 * `ToolCallStep` uses for its flat props). `sandbox_run_command` maps to ui's
 * canonical `bash` name so the row takes the command category (terminal icon);
 * every other tool keeps its real name. agent-app carries no per-call timings,
 * so `state.time` stays unset and the row shows no duration.
 */
export declare function chatToolCallPart(call: ChatToolCallInfo): ToolPart;
/** Whole seconds elapsed while `active`, ticking once a second. Powers the live
 *  "thinking" timers (the pre-first-token row and the reasoning box) so a long
 *  thinking gap shows progress instead of a frozen label. Counts from when
 *  `active` first turns true; freezes when it clears. */
export declare function useThinkingSeconds(active: boolean): number;
/**
 * The message thread: one centered column; user messages are right-aligned
 * bubbles with a User label; agent messages carry an Agent meta line with
 * model id, tokens/sec, and cost, plus a collapsible thinking section and
 * tool rows. `chrome="quiet"` opts into the label-free variant: the
 * label/meta row becomes a hover-revealed meta lane under each row.
 */
export declare function ChatMessages({ messages, messageSize, chrome, models, renderMarkdown, renderExtras, durableCards, userLabel, agentLabel, loading, approval, onToolCallClick, toolRenderers, error, onRetry, renderEmpty, emptyState, header, resolveAttachmentUrl, workProductCards, }: ChatMessagesProps): import("react").JSX.Element;
export * from './api-access-panel';
