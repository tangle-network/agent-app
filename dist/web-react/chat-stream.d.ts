/**
 * Client-side chat-stream consumption — the NDJSON parse loop every agent
 * app's chat UI hand-rolls (and breaks). Normalizes the three line shapes the
 * agent-app chat routes emit:
 *
 *   {kind:'event', event:{type:'text'|'reasoning'|'tool_call'|'usage'|'notice'|'error', ...}}
 *   {kind:'tool_result', toolCallId, toolName, label, outcome}
 *   {type:'turn'|'metadata'|'error'|'turn_status', ...}          (route-level)
 *   {type:'interaction', data:{request}}                         (sidecar ask)
 *
 * Replayed lines carry an extra `seq` — transparently ignored. Works for
 * router-backed and sandbox-backed chats alike: anything producing these
 * lines (live pump, queued follow, resume replay) feeds the same callbacks.
 */
import { type ChatInteraction, type InteractionCancelData } from './chat-interactions';
import { type ChatPlan } from '../plans/index';
export { chatTurnRequestInit, type ChatTurnFilePartInput, type ChatTurnPartInput, type ChatTurnRequestPayload, type ProducerTextEvent, type ProducerReasoningEvent, type ProducerToolCallEvent, type ProducerToolResultEvent, type ProducerUsageEvent, type ProducerNoticeEvent, type ProducerErrorEvent, type ProducerPassthroughEventType, type ProducerPassthroughEvent, type ProducerWireEvent, type FileMention, fileMentionsToParts, buildMentionPromptBlock, mediaTypeForMentionPath, mentionKindForPath, type ChatAttachmentKind, type ChatAttachmentInput, DISPATCH_REQUEST_MAX_BYTES, DISPATCH_STRUCTURAL_RESERVE_BYTES, DISPATCH_MAX_PARTS, DISPATCH_MAX_MEDIA_PARTS, base64WireLen, } from '../chat-routes/wire';
export { type FileIndexResponse, type FileIndexReadyResponse, type FileIndexWarmingResponse, } from '../chat-routes/file-index';
/** Define the structure for a chat tool call including optional ID, name, and arguments object */
export interface ChatStreamToolCall {
    toolCallId?: string;
    toolName: string;
    args: Record<string, unknown>;
}
/** Describe the result of a chat stream tool including its outcome and optional metadata fields */
export interface ChatStreamToolResult {
    toolCallId?: string;
    toolName?: string;
    label?: string;
    outcome: {
        ok: boolean;
        result?: unknown;
        code?: string;
        message?: string;
    };
}
/** Define callbacks to handle events and data during a chat streaming session */
export interface ChatStreamCallbacks {
    onTurnId?: (turnId: string) => void;
    onText?: (delta: string) => void;
    onReasoning?: (delta: string) => void;
    onToolCall?: (call: ChatStreamToolCall) => void;
    onToolResult?: (result: ChatStreamToolResult) => void;
    onUsage?: (usage: {
        promptTokens: number;
        completionTokens: number;
    }) => void;
    onNotice?: (notice: {
        id: string;
        noticeKind: 'warning' | 'auto-declined';
        text: string;
    }) => void;
    onMetadata?: (data: Record<string, unknown>) => void;
    /** Structured detail from a loop-level error event. Fired alongside the
     *  legacy string-only `onErrorEvent` callback. */
    onErrorEventDetail?: (detail: {
        message: string;
        code?: string;
        details?: Record<string, unknown>;
    }) => void;
    /** A loop-level error event (the turn failed server-side). Optional, but the
     *  error never vanishes: when omitted, the message is synthesized into the
     *  transcript via `onText` (rendered by ChatMessages as a text segment) and
     *  logged with `console.error`. */
    onErrorEvent?: (message: string) => void;
    /** A sidecar interaction ask (kind: "question"/"plan"/…). The run is BLOCKED
     *  in the broker until the user answers; a pending ask is "waiting on the
     *  user", not "model working". Optional — a consumer that doesn't wire it
     *  parses the same stream unchanged. */
    onInteraction?: (interaction: ChatInteraction) => void;
    /** A terminal withdrawal/timeout for a previously emitted interaction. */
    onInteractionCancel?: (cancel: InteractionCancelData) => void;
    /** A durable-plan snapshot from any plan lifecycle event. */
    onPlan?: (plan: ChatPlan) => void;
}
/** Represent the result of consuming a chat stream including turn ID and content reception status */
export interface ConsumeChatStreamResult {
    turnId: string | null;
    /** True when any text/reasoning/tool activity was received. */
    receivedContent: boolean;
}
/** Parse one NDJSON line into the callbacks. Exposed for tests. */
export declare function dispatchChatStreamLine(line: string, cb: ChatStreamCallbacks): {
    turnId?: string;
    receivedContent: boolean;
};
/** Drain one NDJSON body into the callbacks. Throws on transport failure
 *  (caller decides whether to resume). */
export declare function consumeChatStream(body: ReadableStream<Uint8Array>, cb: ChatStreamCallbacks): Promise<ConsumeChatStreamResult>;
/** Define options for managing and resuming streaming chat interactions with callbacks */
export interface StreamChatOptions {
    /** Start the turn (POST the chat request); must return a streaming Response. */
    start: () => Promise<Response>;
    /** Re-attach to a turn after a transport drop (GET the resume route). */
    resume?: (turnId: string, fromSeq: number) => Promise<Response>;
    callbacks: ChatStreamCallbacks;
    /** Called before a resume replays from 0 so the UI can reset accumulated
     *  turn state (text, reasoning, tool chips). */
    onResetForResume?: () => void;
}
/**
 * Run one chat turn with automatic single-shot resume: if the transport drops
 * mid-turn and the server announced a turnId, reset and replay the buffered
 * turn. Server-side the turn keeps running either way (queued runner).
 */
export declare function streamChatTurn(opts: StreamChatOptions): Promise<ConsumeChatStreamResult>;
