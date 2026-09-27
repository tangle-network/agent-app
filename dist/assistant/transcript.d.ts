/**
 * The assistant's default transcript renderer, built on web-react's
 * `ChatMessages`. The reducer streams a FLAT, per-segment transcript (user /
 * assistant / `tool` chip / `status` messages, plus turn-level reasoning and
 * pending proposals); `adaptTranscript` collapses each turn into one assistant
 * message whose ordered `segments` carry that turn's text runs and tool chips in
 * emission order, so `ChatMessages` renders them interleaved (text → tool →
 * text) rather than as one text blob followed by a tool group. `status`
 * messages are NOT folded into a turn: each becomes a quiet centered status
 * line rendered by this component between `ChatMessages` runs — a settled
 * action's note ("Created workflow …"), not an assistant-labeled turn.
 *
 * A host can swap this whole renderer via `AssistantPanelProps.renderTranscript`;
 * the markdown renderer and per-tool detail renderers are injected so this
 * subpath stays free of any product-specific markdown/tool dependency.
 */
import { type ReactNode } from "react";
import { type ChatUiMessage, type ToolDetailRenderers } from "../web-react";
import type { AssistantState } from "./reducer";
import type { AssistantTranscriptView, ConfirmedResult } from "./types";
/**
 * True while a turn is streaming but the model hasn't emitted its first answer
 * token yet — drives the "thinking" affordance so a reasoning gap reads as
 * working, not a frozen panel.
 */
export declare function assistantIsThinking(state: AssistantState): boolean;
/** A run of chat messages between two status lines, rendered through one
 *  `ChatMessages`. */
interface MessageRun {
    kind: "run";
    messages: ChatUiMessage[];
}
/** A settled action's one-line note ("Created workflow …", "Action cancelled."),
 *  rendered as a quiet centered line — not routed into `ChatMessages`, where a
 *  `system` row would paint as a full assistant-labeled turn. */
interface StatusLine {
    kind: "status";
    /** The status message's own id — keys the row and any confirmed result. */
    id: string;
    text: string;
}
type TranscriptBlock = MessageRun | StatusLine;
interface AdaptedTranscript {
    /** Transcript-order blocks: message runs broken by status lines. */
    blocks: TranscriptBlock[];
    /** Every adapted chat message across all runs, flattened (status rows
     *  excluded — they are the blocks' status lines). */
    messages: ChatUiMessage[];
    /** The assistant message under which pending proposals should render, or null
     *  when there are none. */
    proposalHostId: string | null;
    /** The current/most-recent turn's assistant message — where the turn cost line
     *  renders (it carries the turn's metrics), or null when there is none. */
    metricsHostId: string | null;
    /** Confirmed-tool results to render under their status line, keyed by that
     *  line's id — carried from a `status` message's retained `result` so a host
     *  card (e.g. a one-time API-key reveal) renders inline right after the action. */
    confirmedResults: Map<string, ConfirmedResult>;
}
/**
 * Fold the transcript view into transcript-order blocks: message runs (web-react
 * `ChatUiMessage[]`) broken by quiet status lines. Within a run, each user
 * message is 1:1; the assistant/`tool` messages between two user turns collapse
 * into one assistant message whose ordered `segments` carry the turn's text runs
 * and tool chips IN EMISSION ORDER (with each finished tool's outcome as the chip
 * `result`). The joined text is also kept on `content` — web-react reads it as the
 * "answer has started" signal that gates the reasoning box. The live turn's
 * reasoning preview and model label hang on the last assistant message, and
 * `proposalHostId` names the message the pending proposals render under. A
 * `status` message ends the current run and becomes a {@link StatusLine} block.
 */
export declare function adaptTranscript(view: AssistantTranscriptView): AdaptedTranscript;
export interface AssistantTranscriptProps {
    view: AssistantTranscriptView;
    /** Markdown renderer for assistant content; defaults to plain pre-wrapped text. */
    renderMarkdown?: (content: string) => ReactNode;
    /** Per-tool custom detail renderers for expanded tool cards. */
    toolRenderers?: ToolDetailRenderers;
    /** Render a prominent card for a CONFIRMED tool's result, inline after its
     *  status line (e.g. a one-time API-key reveal for `create_api_key`). Return
     *  null to fall back to just the status line. Unlike `toolRenderers` (collapsed
     *  detail for a read-only tool chip), this is shown expanded, so a one-time
     *  secret is visible without a click. See {@link ConfirmedResult}. */
    renderConfirmedResult?: (result: ConfirmedResult) => ReactNode;
    /** Zero-state shown for a fresh, non-streaming thread. */
    emptyState?: ReactNode;
}
/**
 * Render the assistant conversation: message runs through web-react's
 * `ChatMessages` (quiet chrome — the label/meta row becomes a hover-revealed
 * lane, which keeps the narrow dock panel uncluttered), status lines through
 * {@link StatusRow}. Pending proposals render via the panel's bound
 * `view.renderProposal`, placed inline after the proposing turn through
 * `renderExtras`; the settled turn cost renders once under its assistant bubble.
 */
export declare function AssistantTranscript({ view, renderMarkdown, toolRenderers, renderConfirmedResult, emptyState, }: AssistantTranscriptProps): import("react").JSX.Element;
export {};
