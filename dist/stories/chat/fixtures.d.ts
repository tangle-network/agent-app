/**
 * Chat-story fixtures: a long, realistic `ChatUiMessage` thread for spacing and
 * density evaluation, plus the individual edge-state messages (proposal
 * awaiting approval, errored tool call, streaming in progress) exported on
 * their own so stories can render a single state in isolation.
 *
 * NOTE: this duplicates what the shared `src/stories/fixtures/chat.ts` barrel
 * is meant to provide. The shared fixtures directory did not exist in the
 * working tree when these stories were written, so — per house rules — the
 * chat area carries its own copy. If the shared fixtures return, this file can
 * be swapped for barrel imports without touching the stories.
 *
 * Types come from the package source (`../../web-react`) — the same types the
 * chat components consume — so a drift in `ChatUiMessage` fails typecheck here.
 */
import type { CatalogModel, ChatToolCallInfo, ChatUiMessage } from '../../web-react';
/** The catalogue the thread prices against. Every fixture message runs Opus. */
export declare const chatCatalogModels: CatalogModel[];
/** A completed sandbox command, args + result captured for the expanded row. */
export declare const doneShellToolCall: ChatToolCallInfo;
/**
 * A proposal the human has not ruled on yet: `pendingApprovalOf` keys on
 * `result.status === 'queued_for_approval'` + a proposalId, so the row becomes
 * the Approve/Reject decision card when the story passes `approval` handlers.
 */
export declare const proposalToolCall: ChatToolCallInfo;
/** A tool call whose run failed — the row renders the error state + message. */
export declare const erroredToolCall: ChatToolCallInfo;
/** A tool call still executing — no `result` yet, the row shows the spinner. */
export declare const runningToolCall: ChatToolCallInfo;
/**
 * A settled `schedule_followup` — NOT a decision and not a failure, so it
 * renders as the quiet follow-up row (its own visual kind).
 */
export declare const scheduledFollowupToolCall: ChatToolCallInfo;
/** Assistant turn whose proposal is still awaiting human approval. */
export declare const proposalAwaitingApprovalMessage: ChatUiMessage;
/** Assistant turn whose only tool call failed. */
export declare const erroredToolCallMessage: ChatUiMessage;
/**
 * A turn still streaming: partial answer text, a tool call in flight, and no
 * completion metrics yet (no `completionTokens`/`durationMs` — producers only
 * stamp those when the turn settles).
 */
export declare const streamingAssistantMessage: ChatUiMessage;
/**
 * ~16 messages covering every rendered state: plain exchanges, reasoning,
 * per-message metrics, interleaved `segments`, a proposal awaiting approval,
 * an errored tool call, and a trailing in-flight turn. Long enough that the
 * thread scrolls, so spacing/typography stories evaluate real rhythm.
 */
export declare const chatThread: ChatUiMessage[];
/** Three turns — the smallest thread that still shows bubble/answer rhythm. */
export declare const shortThread: ChatUiMessage[];
/**
 * Six representative turns (user bubble, assistant + approval card, errored
 * tool, long user message, segmented assistant) for side-by-side density
 * comparisons — compact enough to judge rhythm within one viewport.
 */
export declare const densityThread: ChatUiMessage[];
/** The segmented `usage_report` turn on its own (custom-renderer demos). */
export declare const usageReportMessage: ChatUiMessage[];
/**
 * A workflow-authoring session: both assistant turns carry `reasoning`, the
 * first emits four consecutive settled tool calls (past the collapse threshold,
 * so they fold into one "Worked through 4 steps" disclosure), the second
 * interleaves text and tools via `segments` (under the threshold, so the cards
 * render inline, chronologically).
 */
export declare const reasoningToolThread: ChatUiMessage[];
