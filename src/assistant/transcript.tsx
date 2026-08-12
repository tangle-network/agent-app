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

import { Check } from "lucide-react";
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
export function adaptTranscript(view: AssistantTranscriptView): AdaptedTranscript {
  const blocks: TranscriptBlock[] = [];
  const confirmedResults = new Map<string, ConfirmedResult>();
  // The run under construction — flushed into `blocks` when a status line
  // breaks it (and once more at the end, after the proposal host / metrics are
  // hung, so a synthesized host lands in the same run as its turn).
  let run: ChatUiMessage[] = [];
  const flushRun = () => {
    if (run.length > 0) blocks.push({ kind: "run", messages: run });
    run = [];
  };
  let turn: TurnMessage | null = null;
  // The assistant message of the CURRENT turn — the one opened since the most
  // recent user message — or null when the live turn has produced no assistant
  // segment yet. Reset on each user message so the live turn's reasoning, model
  // label, and pending proposal can never attach to a previous turn's bubble.
  let currentTurnAssistant: TurnMessage | null = null;

  const openTurn = (id: string): TurnMessage => {
    const message: TurnMessage = { id, role: "assistant", content: "", segments: [] };
    run.push(message);
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
      run.push({ id: msg.id, role: "user", content: msg.text });
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
      // `status` — an informational note that ends the assistant turn. It does
      // NOT join the run: rendered as a quiet status line of its own, so a
      // confirmed action no longer paints as a full assistant-labeled turn.
      flushRun();
      blocks.push({ kind: "status", id: msg.id, text: msg.text });
      // A confirmed mutating tool that returned a renderable result attaches it
      // to its status line; carry it out keyed by that line's id so the host
      // card renders inline right under the line.
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

  flushRun();

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

  const kept: TranscriptBlock[] = [];
  const messages: ChatUiMessage[] = [];
  for (const block of blocks) {
    if (block.kind === "status") {
      kept.push(block);
      continue;
    }
    const visible = block.messages.filter((m) => !isEmptyShell(m));
    if (visible.length > 0) {
      kept.push({ kind: "run", messages: visible });
      messages.push(...visible);
    }
  }

  return {
    blocks: kept,
    messages,
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

/** A settled action's note as a quiet centered line — a check glyph and muted
 *  small text, no assistant label, no bubble. The confirmed result card (e.g.
 *  the one-time API-key reveal) hangs directly under its line. */
function StatusRow({
  text,
  result,
  renderConfirmedResult,
}: {
  text: string;
  result?: ConfirmedResult;
  renderConfirmedResult?: (result: ConfirmedResult) => ReactNode;
}) {
  // Only when the host supplied a renderer AND it returns a node for this
  // result — a renderer that returns null (a tool it doesn't handle) must add
  // no wrapper, or every other confirmed tool would get an empty `mt-3` spacer
  // under its status line.
  const confirmed = result && renderConfirmedResult ? renderConfirmedResult(result) : null;
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-1">
      <p className="flex items-center justify-center gap-1.5 text-center text-muted-foreground text-xs">
        <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        {text}
      </p>
      {confirmed ? <div className="mt-3">{confirmed}</div> : null}
    </div>
  );
}

/**
 * Render the assistant conversation: message runs through web-react's
 * `ChatMessages` (quiet chrome — the label/meta row becomes a hover-revealed
 * lane, which keeps the narrow dock panel uncluttered), status lines through
 * {@link StatusRow}. Pending proposals render via the panel's bound
 * `view.renderProposal`, placed inline after the proposing turn through
 * `renderExtras`; the settled turn cost renders once under its assistant bubble.
 */
export function AssistantTranscript({
  view,
  renderMarkdown,
  toolRenderers,
  renderConfirmedResult,
  emptyState,
}: AssistantTranscriptProps) {
  const { blocks, proposalHostId, metricsHostId, confirmedResults } = useMemo(
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

  if (blocks.length === 0 && !view.isStreaming) {
    return <>{emptyState}</>;
  }

  // renderExtras places the pending proposal cards after their proposing turn
  // and the settled turn's at-cost figure under its bubble. (A confirmed
  // tool's host card renders with its status line — see StatusRow.)
  const extras = (message: ChatUiMessage): ReactNode => {
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
    // The settled turn's at-cost figure, shown once under its assistant
    // bubble. Hidden while streaming and for a replayed (uncharged) turn.
    const cost =
      message.id === metricsHostId &&
      !view.isStreaming &&
      view.usage?.costUsd != null &&
      !view.usage.replayed ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {formatTurnCost(view.usage.costUsd)} this turn
        </p>
      ) : null;
    if (!proposals && !cost) return null;
    return (
      <>
        {proposals}
        {cost}
      </>
    );
  };

  return (
    <>
      {blocks.map((block, i) =>
        block.kind === "status" ? (
          <StatusRow
            key={block.id}
            text={block.text}
            result={confirmedResults.get(block.id)}
            renderConfirmedResult={renderConfirmedResult}
          />
        ) : (
          <ChatMessages
            // Only the trailing run can hold the live turn, so only it streams
            // (earlier runs are settled history).
            key={i}
            messages={block.messages}
            // ChatMessages derives the streaming message internally, so only
            // `isStreaming` is needed; `view.isThinking` is a subset of it.
            loading={view.isStreaming && i === blocks.length - 1}
            agentLabel="Assistant"
            chrome="quiet"
            renderMarkdown={markdown}
            toolRenderers={toolRenderers}
            renderExtras={extras}
          />
        ),
      )}
    </>
  );
}
