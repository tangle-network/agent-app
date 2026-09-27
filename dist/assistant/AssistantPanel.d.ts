/**
 * The assistant chat panel, built on web-react's chat components. The reducer
 * state is rendered by `AssistantTranscript` (web-react `ChatMessages`: transcript,
 * tool chips, reasoning preview, cost, proposal cards) and the composer is a
 * `ChatComposer` carrying the `ModelPicker` in its controls slot. The header's
 * history toggle swaps the conversation area for a full-panel, searchable history
 * view. App-shell concerns — the signed-in user, navigation, the credit balance,
 * money formatting, the markdown + tool-detail renderers, and the workflow-graph
 * renderer — are injected so the panel is portable across hosts. Chat state is
 * owned by the dock and passed in, so the conversation survives the drawer closing.
 */
import { type ReactNode } from "react";
import type { CatalogModel } from "../runtime/model-catalog";
import { type ComposerFile, type ToolDetailRenderers } from "../web-react";
import type { AssistantModels } from "./client";
import type { AssistantTranscriptView, ConfirmedResult } from "./types";
import type { AssistantChat } from "./useAssistantChat";
export interface AssistantPanelProps {
    chat: AssistantChat;
    userId: string | null;
    onClose: () => void;
    /** Host navigation for error CTAs and connect targets. */
    navigate?: (path: string) => void;
    /** The user's credit balance, for the header tile + low-balance nudge. */
    balanceUsd?: number | null;
    /** Format a USD amount; defaults to Intl currency formatting. */
    formatMoney?: (usd: number | null) => string;
    /** Render workflow YAML as a node graph in a proposal card (the `./workflows`
     *  WorkflowGraph). When absent, proposals show YAML as text. */
    renderGraph?: (yaml: string) => ReactNode;
    /** Render the brand icon for a proposal requirement's integration provider.
     *  When absent, the card falls back to its built-in provider mark. */
    renderProviderIcon?: (provider: string) => ReactNode;
    /** Markdown renderer for assistant message content. When absent, content
     *  renders as plain pre-wrapped text. */
    renderMarkdown?: (content: string) => ReactNode;
    /** Per-tool custom detail renderers for expanded tool cards in the transcript. */
    toolRenderers?: ToolDetailRenderers;
    /** Render a prominent card for a CONFIRMED tool's result (e.g. a one-time
     *  API-key reveal for `create_api_key`), shown inline after the action's status
     *  line. Ignored when a host swaps the whole transcript via `renderTranscript`. */
    renderConfirmedResult?: (result: ConfirmedResult) => ReactNode;
    /** Swap ONLY the conversation rendering for a host-supplied renderer (e.g. a
     *  different chat-message component), while the panel keeps owning the header,
     *  composer, model picker, history, transport, and proposal orchestration.
     *  Receives the transcript slice plus a bound proposal card to place. When
     *  absent, the built-in transcript (web-react `ChatMessages`) renders the
     *  conversation. */
    renderTranscript?: (view: AssistantTranscriptView) => ReactNode;
    /** One-shot composer prefill from the host's launcher (e.g. a page's "Create
     *  with assistant" button passing `openAssistant(seed)`). The panel adopts it
     *  as the composer draft and calls `onComposerSeedApplied` once, so the host
     *  clears its seed state (consume-once). */
    composerSeed?: string | null;
    onComposerSeedApplied?: () => void;
    /** Opt-in attachment surface for the composer, mirroring `ChatComposer`'s
     *  attachment props: pass `onAttach` to show the attach button and accept
     *  drag-and-drop, and drive the staged-file chips with `pendingFiles` /
     *  `onRemoveFile` (web-react's `useComposerAttachments` owns that lifecycle).
     *  Omitted, the composer stays text-only. The assistant wire carries text
     *  only, so a host that stages files owns getting their content to the model
     *  (e.g. inlined on the next `chat.send`); `onComposerSend` is the signal to
     *  consume and clear the staged set. */
    composerAttachments?: {
        onAttach: (files: FileList) => void;
        onAttachFolder?: (files: FileList) => void;
        pendingFiles?: ComposerFile[];
        onRemoveFile?: (id: string) => void;
        accept?: string;
    };
    /** Fired when the composer sends (alongside `chat.send`) — the host's signal
     *  to consume and clear its staged attachments. */
    onComposerSend?: (message: string) => void;
}
export declare function toPickerModels(models: AssistantModels, selected: string | null): CatalogModel[];
/**
 * The chat-state value to store for a model id chosen in the picker. Picking the
 * server default clears the preference to `null` — preserving the native-select
 * contract where "default" means "omit the model and follow whatever the server
 * default is", rather than pinning the default's slug (which would freeze the
 * user to it even after the server default changes). Any other id is stored as-is.
 */
export declare function nextModelSelection(id: string, defaultSlug: string | null): string | null;
export declare function AssistantPanel({ chat, userId, onClose, navigate, balanceUsd, formatMoney, renderGraph, renderProviderIcon, renderMarkdown, toolRenderers, renderConfirmedResult, renderTranscript, composerSeed, onComposerSeedApplied, composerAttachments, onComposerSend, }: AssistantPanelProps): import("react").JSX.Element;
