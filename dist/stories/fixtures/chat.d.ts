/**
 * Chat fixtures: a long, realistic `ChatUiMessage` thread for story spacing
 * evaluation, plus the individual edge-state messages (proposal awaiting
 * approval, errored tool call, streaming in progress) exported on their own
 * so stories can render a single state in isolation.
 *
 * Types come from the package source (`../../web-react`) — the same types the
 * chat components consume — so a drift in `ChatUiMessage` fails typecheck here.
 */
import type { ChatToolCallInfo, ChatUiMessage } from '../../web-react';
/** A completed sandbox command, args + result captured for the expanded card. */
export declare const doneShellToolCall: ChatToolCallInfo;
/**
 * A proposal the human has not ruled on yet: `pendingApprovalOf` keys on
 * `result.status === 'queued_for_approval'` + a proposalId, so the chip renders
 * the Approve/Reject affordance when the story passes `approval` handlers.
 */
export declare const proposalToolCall: ChatToolCallInfo;
/** A tool call whose run failed — the chip renders the error state + message. */
export declare const erroredToolCall: ChatToolCallInfo;
/** A tool call still executing — no `result` yet, chip shows the spinner. */
export declare const runningToolCall: ChatToolCallInfo;
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
