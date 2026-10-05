/**
 * The assistant transcript, rendered with the main chat's primitives: the
 * shared `AgentTimeline` column from `@tangle-network/ui/chat` (user bubble,
 * 15px assistant prose with code blocks, thinking row, status cards) and its
 * `InlineToolItem` tool rows. Sandbox sessions and workflow run pages render
 * through the same components, so the assistant inherits their type scale,
 * spacing and states instead of keeping a second chat style.
 *
 * The reducer streams a flat, per-segment transcript (user / assistant text /
 * `tool` / `status` messages, plus turn-level reasoning and pending
 * proposals). {@link buildAssistantTimeline} maps it onto timeline items in
 * emission order, so text and tool rows interleave as they happened.
 */

import {
  AgentTimeline,
  type AgentTimelineItem,
} from "@tangle-network/ui/chat";
import { InlineThinkingItem, InlineToolItem } from "@tangle-network/ui/run";
import { type ReactNode, useMemo } from "react";
import {
  type ChatToolCallInfo,
  type ChatUiMessage,
  chatToolCallPart,
  type ToolDetailRenderers,
} from "../web-react";
import type { AssistantState } from "./reducer";
import type {
  AssistantTranscriptView,
  ChatMessage,
  ConfirmedResult,
  ToolOutcome,
} from "./types";

/**
 * True while a turn is streaming but the model hasn't emitted its first answer
 * token yet. Drives the timeline's thinking row, so a reasoning gap reads as
 * work in progress rather than a frozen panel.
 */
export function assistantIsThinking(state: AssistantState): boolean {
  if (state.status !== "streaming") return false;
  const streaming = state.streamingId
    ? state.messages.find((m) => m.id === state.streamingId)
    : undefined;
  // Thinking until the open assistant segment receives text (a tool_call closes
  // the segment, so a running tool also reads as still working).
  return !streaming || streaming.text === "";
}

const TOOL_STATUS: Record<string, ChatToolCallInfo["status"]> = {
  running: "running",
  ok: "done",
  failed: "error",
};

/** A failure keeps its error under `outcome.error`; the shared tool row reads
 *  a top-level `message`, so flatten it or the row shows a generic failure. */
function adaptToolResult(outcome: ToolOutcome): unknown {
  if (outcome.ok) return { ok: true, result: outcome.result };
  return { ok: false, message: outcome.error?.message, code: outcome.error?.code };
}

function toolCallOf(message: ChatMessage): ChatToolCallInfo | null {
  if (!message.tool) return null;
  return {
    id: message.id,
    name: message.tool.name,
    // An unmapped status resolves to "error", never "running": a stuck
    // spinner would hide a finished or failed tool.
    status: TOOL_STATUS[message.tool.status] ?? "error",
    ...(message.tool.args ? { args: message.tool.args } : {}),
    ...(message.tool.outcome
      ? { result: adaptToolResult(message.tool.outcome) }
      : {}),
  };
}

/** `list_workflow_runs` → "List workflow runs". */
function toolTitle(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

/** Sub-cent turn costs need more precision than dollars and cents. */
function formatTurnCost(costUsd: number): string {
  return costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`;
}

/**
 * Custom rows take the timeline's tool-row bleed. Cards and notes inside them
 * cancel it so their edges line up with the prose column.
 */
function ProseAligned({ children }: { children: ReactNode }) {
  return <div className="mx-3">{children}</div>;
}

export interface AssistantTimelineOptions {
  toolRenderers?: ToolDetailRenderers;
  renderConfirmedResult?: (result: ConfirmedResult) => ReactNode;
}

/**
 * Map the transcript view onto `AgentTimeline` items. Within the live turn
 * (everything after the latest user message) the reasoning row leads, pending
 * proposals follow the turn's last row, and the settled turn's cost closes it.
 */
export function buildAssistantTimeline(
  view: AssistantTranscriptView,
  options: AssistantTimelineOptions = {},
): AgentTimelineItem[] {
  const items: AgentTimelineItem[] = [];
  let lastUser = -1;
  view.messages.forEach((m, i) => {
    if (m.role === "user") lastUser = i;
  });

  view.messages.forEach((message, index) => {
    if (message.role === "user") {
      items.push({ id: message.id, kind: "message", role: "user", content: message.text });
      if (index === lastUser && view.reasoning) {
        items.push({
          id: `${message.id}-reasoning`,
          kind: "custom",
          content: (
            <InlineThinkingItem
              part={{ type: "reasoning", text: view.reasoning }}
              defaultOpen={view.isStreaming}
            />
          ),
        });
      }
      return;
    }
    if (message.role === "assistant") {
      // An empty segment is the at-send frame before the first delta; the
      // timeline's thinking row covers it.
      if (!message.text.trim()) return;
      items.push({
        id: message.id,
        kind: "message",
        role: "assistant",
        content: message.text,
        isStreaming: view.isStreaming && message.id === view.streamingId,
      });
      return;
    }
    if (message.role === "tool") {
      const call = toolCallOf(message);
      if (!call) return;
      const renderer = options.toolRenderers?.[call.name];
      const host: ChatUiMessage = { id: message.id, role: "assistant", content: "" };
      items.push({
        id: message.id,
        kind: "custom",
        content: (
          <InlineToolItem
            part={chatToolCallPart(call)}
            title={toolTitle(call.name)}
            // A host renderer returns null for shapes it does not handle; the
            // shared row then falls back to its own input/output detail.
            renderToolDetail={renderer ? () => renderer(call, host) : undefined}
          />
        ),
      });
      return;
    }
    // `status`: a settled action's note ("Created workflow …").
    items.push({ id: message.id, kind: "status", label: message.text, tone: "success" });
    const card =
      message.result && options.renderConfirmedResult
        ? options.renderConfirmedResult(message.result)
        : null;
    if (card) {
      items.push({
        id: `${message.id}-result`,
        kind: "custom",
        content: <ProseAligned>{card}</ProseAligned>,
      });
    }
  });

  for (const proposal of view.pendingProposals) {
    items.push({
      id: `proposal-${proposal.callId}`,
      kind: "custom",
      content: <ProseAligned>{view.renderProposal(proposal)}</ProseAligned>,
    });
  }

  if (
    lastUser >= 0 &&
    !view.isStreaming &&
    view.usage?.costUsd != null &&
    !view.usage.replayed
  ) {
    items.push({
      id: "turn-cost",
      kind: "custom",
      content: (
        <ProseAligned>
          <p className="text-muted-foreground text-xs tabular-nums">
            {formatTurnCost(view.usage.costUsd)} this turn
          </p>
        </ProseAligned>
      ),
    });
  }

  return items;
}

export interface AssistantTranscriptProps extends AssistantTimelineOptions {
  view: AssistantTranscriptView;
  /** Zero state for a fresh, idle thread. */
  emptyState?: ReactNode;
}

export function AssistantTranscript({
  view,
  toolRenderers,
  renderConfirmedResult,
  emptyState,
}: AssistantTranscriptProps) {
  const items = useMemo(
    () => buildAssistantTimeline(view, { toolRenderers, renderConfirmedResult }),
    [view, toolRenderers, renderConfirmedResult],
  );
  if (items.length === 0 && !view.isStreaming) return <>{emptyState}</>;
  // The panel is narrow, so the prose column is inset 24px: tool rows bleed
  // 12px past it and their expanded cards keep 12px from the panel edge, in
  // line with the composer card below.
  return (
    <AgentTimeline items={items} isThinking={view.isThinking} className="px-6" />
  );
}
