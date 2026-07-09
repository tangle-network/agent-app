/**
 * The assistant's default transcript renderer, built on web-react's
 * `ChatMessages`. The reducer streams a FLAT, per-segment transcript (user /
 * assistant / `tool` chip / `status` messages, plus turn-level reasoning and
 * pending proposals); `adaptTranscript` collapses each turn into one assistant
 * message whose ordered `segments` carry that turn's text runs and tool chips in
 * emission order, so `ChatMessages` renders them interleaved (text → tool →
 * text) rather than as one text blob followed by a tool group.
 *
 * A host can swap this whole renderer via `AssistantPanelProps.renderTranscript`;
 * the markdown renderer and per-tool detail renderers are injected so this
 * subpath stays free of any product-specific markdown/tool dependency.
 */

import { useCallback, useMemo, type ReactNode } from "react";
import {
  ChatMessages,
  type ChatMessageSegment,
  type ChatUiMessage,
  type ToolDetailRenderers,
} from "../web-react";
import type { AssistantState } from "./reducer";
import type {
  AssistantTranscriptView,
  ConfirmedResult,
  PendingProposal,
  ToolOutcome,
} from "./types";

/**
 * True while a turn is streaming but the model hasn't emitted its first answer
 * token yet — drives the "thinking" affordance so a reasoning gap reads as
 * working, not a frozen panel.
 */
export function assistantIsThinking(state: AssistantState): boolean {
  if (state.status !== "streaming") return false;
  const streaming = state.streamingId
    ? state.messages.find((m) => m.id === state.streamingId)
    : undefined;
  // Thinking until the open assistant bubble receives text (a tool_call closes
  // the bubble, so a running tool also reads as no-open-bubble = still working).
  return !streaming || streaming.text === "";
}

type ToolStatus = Extract<ChatMessageSegment, { kind: "tool" }>["call"]["status"];

const TOOL_STATUS: Record<string, ToolStatus> = {
  running: "running",
  ok: "done",
  failed: "error",
};

export interface AdaptedTranscript {
  messages: ChatUiMessage[];
  /** The assistant message under which pending proposals should render, or null
   *  when there are none. */
  proposalHostId: string | null;
  /** The current/most-recent turn's assistant message — where the turn cost line
   *  renders (it carries the turn's metrics), or null when there is none. */
  metricsHostId: string | null;
  /** Confirmed-tool results to render under their (system) message, keyed by that
   *  message's id — carried from a `status` message's retained `result` so a host
   *  card (e.g. a one-time API-key reveal) renders inline right after the action. */
  confirmedResults: Map<string, ConfirmedResult>;
}

/**
 * Reshape a `ToolOutcome` into what web-react's tool-detail card reads. A success
 * (`{ ok: true, result }`) already matches. A failure keeps its error under
 * `outcome.error`, but web-react reads a top-level `outcome.message`/`code` — so
 * flatten it, else an expanded failed tool card shows a generic "Tool failed"
 * instead of the real server error.
 */
function adaptToolResult(outcome: ToolOutcome): unknown {
  if (outcome.ok) return { ok: true, result: outcome.result };
  return { ok: false, message: outcome.error?.message, code: outcome.error?.code };
}

/** An assistant turn message with `segments` guaranteed present, so the fold can
 *  push to it directly. Every turn message is created by `openTurn`. */
type TurnMessage = ChatUiMessage & { segments: ChatMessageSegment[] };

/**
 * Fold the transcript view into web-react `ChatUiMessage[]`: each user message is
 * 1:1; the assistant/`tool`/`status` messages between two user turns collapse
 * into one assistant message whose ordered `segments` carry the turn's text runs
 * and tool chips IN EMISSION ORDER (with each finished tool's outcome as the chip
 * `result`). The joined text is also kept on `content` — web-react reads it as the
 * "answer has started" signal that gates the reasoning box. The live turn's
 * reasoning preview and model label hang on the last assistant message, and
 * `proposalHostId` names the message the pending proposals render under.
 */
export function adaptTranscript(view: AssistantTranscriptView): AdaptedTranscript {
  const messages: ChatUiMessage[] = [];
  const confirmedResults = new Map<string, ConfirmedResult>();
  let turn: TurnMessage | null = null;
  // The assistant message of the CURRENT turn — the one opened since the most
  // recent user message — or null when the live turn has produced no assistant
  // segment yet. Reset on each user message so the live turn's reasoning, model
  // label, and pending proposal can never attach to a previous turn's bubble.
  let currentTurnAssistant: TurnMessage | null = null;

  const openTurn = (id: string): TurnMessage => {
    const message: TurnMessage = { id, role: "assistant", content: "", segments: [] };
    messages.push(message);
    turn = message;
    currentTurnAssistant = message;
    return message;
  };

  // Append a text run to both the ordered segments (the rendered, interleaved
  // body) and the joined `content` (which gates the reasoning box). Kept in
  // lockstep so the two never disagree.
  const appendText = (message: TurnMessage, text: string) => {
    if (!text.trim()) return;
    message.segments.push({ kind: "text", content: text });
    message.content = message.content ? `${message.content}\n\n${text}` : text;
  };

  for (const msg of view.messages) {
    if (msg.role === "user") {
      messages.push({ id: msg.id, role: "user", content: msg.text });
      turn = null;
      currentTurnAssistant = null;
    } else if (msg.role === "assistant") {
      const active = turn ?? openTurn(msg.id);
      appendText(active, msg.text);
      currentTurnAssistant = active;
    } else if (msg.role === "tool") {
      // A tool row exists only to carry its activity chip; with no tool metadata
      // there is nothing to render, so skip it rather than open a phantom bubble.
      if (!msg.tool) continue;
      // When the tool opens the turn (no preamble text), the synthesized
      // assistant bubble needs an id distinct from the tool chip's (which reuses
      // `msg.id`), or the two would collide.
      const active = turn ?? openTurn(`turn-${msg.id}`);
      currentTurnAssistant = active;
      active.segments.push({
        kind: "tool",
        call: {
          id: msg.id,
          name: msg.tool.name,
          // An unmapped status resolves to "error", not "running": a stuck
          // spinner would hide a finished or failed tool.
          status: TOOL_STATUS[msg.tool.status] ?? "error",
          ...(msg.tool.args ? { args: msg.tool.args } : {}),
          ...(msg.tool.outcome ? { result: adaptToolResult(msg.tool.outcome) } : {}),
        },
      });
    } else {
      // `status` — an informational system note that ends the assistant turn.
      messages.push({ id: msg.id, role: "system", content: msg.text });
      // A confirmed mutating tool that returned a renderable result attaches it
      // to its status message; carry it out keyed by this system message's id so
      // the host card renders inline right under the status line.
      if (msg.result) confirmedResults.set(msg.id, msg.result);
      turn = null;
    }
  }

  let proposalHostId: string | null = null;
  if (view.pendingProposals.length > 0) {
    // A propose-only turn may carry no assistant segment yet — synthesize a host
    // in the current turn so the proposal card still has somewhere to render.
    if (!currentTurnAssistant) {
      currentTurnAssistant = openTurn(
        `proposal-host-${view.pendingProposals[0]!.callId}`,
      );
    }
    proposalHostId = currentTurnAssistant.id;
  }

  // Live reasoning + model label + settled metrics belong to the current turn's
  // assistant bubble (including a host synthesized just above for a propose-only
  // turn, so a turn that only reasons then proposes still shows its thinking).
  if (currentTurnAssistant) {
    if (view.reasoning) currentTurnAssistant.reasoning = view.reasoning;
    if (view.model) currentTurnAssistant.modelUsed = view.model;
    if (view.usage) {
      if (view.usage.completionTokens != null)
        currentTurnAssistant.completionTokens = view.usage.completionTokens;
      if (view.usage.promptTokens != null)
        currentTurnAssistant.promptTokens = view.usage.promptTokens;
      if (view.usage.durationMs != null)
        currentTurnAssistant.durationMs = view.usage.durationMs;
    }
  }

  // A turn that produced no body and had nothing turn-level hung on it renders as
  // a bare "Assistant" header. That state is the at-send frame before the first
  // delta; drop it so an empty turn never flashes a blank bubble. The proposal
  // host is exempt: it intentionally carries the pending proposal card.
  const isEmptyShell = (m: ChatUiMessage): boolean =>
    m.role === "assistant" &&
    m.content === "" &&
    (m.segments?.length ?? 0) === 0 &&
    m.reasoning == null &&
    m.modelUsed == null &&
    m.completionTokens == null &&
    m.promptTokens == null &&
    m.durationMs == null &&
    m.id !== proposalHostId;

  return {
    messages: messages.filter((m) => !isEmptyShell(m)),
    proposalHostId,
    metricsHostId:
      currentTurnAssistant && !isEmptyShell(currentTurnAssistant)
        ? currentTurnAssistant.id
        : null,
    confirmedResults,
  };
}

/** Sub-cent turn costs need more precision than dollars-and-cents. */
function formatTurnCost(costUsd: number): string {
  return costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`;
}

/** A named component (rather than calling `render()` inline in a map) gives React
 *  a stable, keyed element per proposal so cards reconcile instead of remount. */
function ProposalSlot({
  proposal,
  render,
}: {
  proposal: PendingProposal;
  render: (proposal: PendingProposal) => ReactNode;
}) {
  return <>{render(proposal)}</>;
}

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
 * Render the assistant conversation with web-react's `ChatMessages`. Pending
 * proposals render via the panel's bound `view.renderProposal`, placed inline
 * after the proposing turn through `renderExtras`; the settled turn cost renders
 * once under its assistant bubble.
 */
export function AssistantTranscript({
  view,
  renderMarkdown,
  toolRenderers,
  renderConfirmedResult,
  emptyState,
}: AssistantTranscriptProps) {
  const { messages, proposalHostId, metricsHostId, confirmedResults } = useMemo(
    () => adaptTranscript(view),
    [view],
  );

  // Stable identity: web-react memoizes its per-message markdown parse on the
  // `renderMarkdown` reference, so a fresh closure each render (the `view` object
  // changes every stream tick) would re-parse every message on every token.
  const markdown = useCallback(
    (content: string) => (renderMarkdown ? renderMarkdown(content) : content),
    [renderMarkdown],
  );

  if (messages.length === 0 && !view.isStreaming) {
    return <>{emptyState}</>;
  }

  return (
    <ChatMessages
      messages={messages}
      // ChatMessages derives the streaming message internally, so only
      // `isStreaming` is needed; `view.isThinking` is a subset of it.
      loading={view.isStreaming}
      agentLabel="Assistant"
      renderMarkdown={markdown}
      toolRenderers={toolRenderers}
      renderEmpty={() => <>{emptyState}</>}
      renderExtras={(message) => {
        const proposals =
          message.id === proposalHostId && view.pendingProposals.length > 0 ? (
            <div className="mt-3 flex flex-col gap-3">
              {view.pendingProposals.map((proposal) => (
                <ProposalSlot
                  key={proposal.callId}
                  proposal={proposal}
                  render={view.renderProposal}
                />
              ))}
            </div>
          ) : null;
        // A confirmed tool's host card, rendered inline under its status line
        // (e.g. the one-time API-key reveal). Only when the host supplied a
        // renderer AND it returns something for this result.
        const confirmed = confirmedResults.get(message.id);
        const confirmedCard =
          confirmed && renderConfirmedResult ? (
            <div className="mt-3">{renderConfirmedResult(confirmed)}</div>
          ) : null;
        // The settled turn's at-cost figure, shown once under its assistant
        // bubble. Hidden while streaming and for a replayed (uncharged) turn.
        const cost =
          message.id === metricsHostId &&
          !view.isStreaming &&
          view.usage?.costUsd != null &&
          !view.usage.replayed ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {formatTurnCost(view.usage.costUsd)} this turn
            </p>
          ) : null;
        if (!proposals && !cost && !confirmedCard) return null;
        return (
          <>
            {confirmedCard}
            {proposals}
            {cost}
          </>
        );
      }}
    />
  );
}
