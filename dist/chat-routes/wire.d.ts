import type { ReasoningEffort } from '@tangle-network/agent-interface';
/**
 * Wire contract between the chat client (composer + `streamChatTurn`) and the
 * assembled server vertical (`createChatTurnRoutes`). This module must remain
 * browser-safe: `/web-react` re-exports these types into browser bundles, so
 * imports must not reach a Node builtin or an engine package.
 *
 * The client part shape permits an absolute file path until the server converts
 * it to the URL required by the sandbox SDK. It is derived here, not imported,
 * so the client bundle never touches the SDK.
 */
export interface ChatTurnTextPartInput {
    type: 'text';
    text: string;
}
/** A non-text prompt part the upload route hands back and the client echoes
 *  on send. `url` carries an inline `data:` URI for small files; `path` is a
 *  sandbox workspace reference for large ones (the >1 MiB gateway body cap
 *  makes the two-step upload mandatory). */
export interface ChatTurnFilePartInput {
    type: 'image' | 'file';
    filename?: string;
    mediaType?: string;
    url?: string;
    path?: string;
}
/** Resolve input as either a text part or a file part of a chat turn */
export type ChatTurnPartInput = ChatTurnTextPartInput | ChatTurnFilePartInput;
/** A chat turn's automatic sentinel plus the canonical agent reasoning levels. */
export type ChatReasoningEffort = 'auto' | ReasoningEffort;
/** Represent a text event produced by a source with a fixed type and associated text content */
export interface ProducerTextEvent {
    type: 'text';
    text: string;
}
/** Define an event representing reasoning output with a fixed type and associated text */
export interface ProducerReasoningEvent {
    type: 'reasoning';
    text: string;
}
/** Represent an event triggered by a producer tool call with its identifier, name, and arguments */
export interface ProducerToolCallEvent {
    type: 'tool_call';
    call: {
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
    };
}
/** Describe the structure of an event representing the result of a producer tool call */
export interface ProducerToolResultEvent {
    type: 'tool_result';
    toolCallId: string;
    toolName: string;
    outcome: {
        ok: boolean;
        result?: unknown;
        message?: string;
    };
}
/** Describe cumulative provider usage reported by a producer. */
export interface ProducerUsageEvent {
    type: 'usage';
    usage: {
        promptTokens: number;
        completionTokens: number;
        reasoningTokens?: number;
        toolTokens?: number;
        toolCallCount?: number;
        providerCostUsd?: number;
        /** Present only when the provider enforced the complete execution budget. */
        budgetEnforced?: boolean;
    };
}
/** Define the structure for a producer notice event with type, id, kind, and text fields */
export interface ProducerNoticeEvent {
    type: 'notice';
    id: string;
    /** Kept inline with `/interactions`' `NoticeKind` so this file stays import-free. */
    noticeKind: 'warning' | 'auto-declined';
    text: string;
}
/** Represent an error event emitted by a producer containing message, code, and optional details */
export interface ProducerErrorEvent {
    type: 'error';
    data: {
        message: string;
        code?: string;
        details?: Record<string, unknown>;
    };
}
/** Stable raw lifecycle/interaction/plan/route events forwarded unchanged. */
export type ProducerPassthroughEventType = 'turn' | 'metadata' | 'interaction' | 'interaction.cancel' | 'plan.submitted' | 'done' | 'warning' | 'session.run.started' | 'session.run.completed' | 'session.run.failed' | 'turn_status';
/** Define an event carrying passthrough data with flexible properties for producer communication */
export interface ProducerPassthroughEvent {
    type: ProducerPassthroughEventType;
    data?: Record<string, unknown>;
    /** Route markers and raw passthroughs may carry `turnId`, `status`, `seq`, etc. */
    [key: string]: unknown;
}
/** Represent events emitted by a producer during its operation for processing and handling */
export type ProducerWireEvent = ProducerTextEvent | ProducerReasoningEvent | ProducerToolCallEvent | ProducerToolResultEvent | ProducerUsageEvent | ProducerNoticeEvent | ProducerErrorEvent | ProducerPassthroughEvent;
/** The image/file split an attachment is rendered and persisted under — the
 *  same discriminant as {@link ChatMentionKind}, but a distinct name because an
 *  attachment carries content the product uploaded (`ChatAttachmentInput`)
 *  while a mention points at a file the box already has. Defined HERE (the
 *  import-free layer) so `ChatAttachmentInput` can reference it and the client
 *  composer imports it without pulling the persisted-part vocabulary;
 *  `/chat-store`'s parts module re-exports it alongside the attachment helpers. */
export type ChatAttachmentKind = 'image' | 'file';
/** `POST` turn-body entry describing a file already uploaded to the product's
 *  store (vault/object-store) — distinct from an inline {@link
 *  ChatTurnFilePartInput} (which carries bytes) and from a {@link FileMention}
 *  (a sandbox path the box already holds). The route resolves this field with
 *  {@link resolveChatAttachments}: every path is re-validated and every size is
 *  re-derived from the stored body, so nothing here is trusted as sent. */
export interface ChatAttachmentInput {
    path: string;
    name: string;
    size: number;
    mediaType: string;
    kind: ChatAttachmentKind;
}
/** POST body for the turn route. `content` may be empty when `parts` carry the
 *  message (an image-only send). Product routing fields (workspaceId etc.) ride
 *  alongside and are read by the product's `authorize` seam. */
export interface ChatTurnRequestPayload {
    threadId: string;
    content?: string;
    /** Non-text parts from the upload route, echoed back verbatim. */
    parts?: ChatTurnFilePartInput[];
    /** `@`-picked file mentions for this turn — path references into the
     *  workspace sandbox, NOT uploads, so they travel in their own field rather
     *  than as `parts` entries. A product whose `parts` field is already spoken
     *  for (an attachment sentinel) can still send mentions, and mentions
     *  persist as their own `ChatMentionPart`s so a retry rebuilds them. The
     *  route validates this field with {@link parseFileMentions} and replaces it
     *  on the payload with the validated, deduped list. */
    mentions?: FileMention[];
    /** Files uploaded to the product's store ahead of the turn — path
     *  references, NOT inline bytes (those ride `parts`). Validated and
     *  size-re-derived by {@link resolveChatAttachments} into persistable
     *  attachment parts; a product whose `parts` field is spoken for by inline
     *  uploads still sends store-backed files here. */
    attachments?: ChatAttachmentInput[];
    model?: string;
    effort?: ChatReasoningEffort;
    harness?: string;
    /** Client-generated idempotency key for the logical turn (retry-safe). */
    turnId?: string;
    [key: string]: unknown;
}
/** `fetch` init for the turn route — the one place the client wire shape is
 *  serialized, so composer glue and products never drift from the server's
 *  parser. */
export declare function chatTurnRequestInit(payload: ChatTurnRequestPayload): RequestInit;
/** Define the maximum byte size allowed for inline parts in data processing */
export declare const INLINE_PARTS_MAX_BYTES = 950000;
/** Hard cap on the whole `/prompt` request body as it crosses the sandbox
 *  proxy — smaller in practice than a raw-file write cap because a dispatch
 *  carries several inline parts plus the flattened history in one request. */
export declare const DISPATCH_REQUEST_MAX_BYTES: number;
/** Bytes reserved off the top of {@link DISPATCH_REQUEST_MAX_BYTES} for the
 *  JSON structure around the parts array (keys, delimiters, per-part
 *  `type`/`filename`/`mediaType` fields) that {@link base64WireLen} does not
 *  account for — keeps the inline budget off the exact proxy cap where one
 *  stray byte trips the 413. */
export declare const DISPATCH_STRUCTURAL_RESERVE_BYTES: number;
/** Sidecar's hard cap on the `parts` array of one prompt request — a dispatch
 *  must never assemble more parts than this or the whole turn 400s. */
export declare const DISPATCH_MAX_PARTS = 64;
/** Product-side cap on media parts per dispatch (current turn + carried
 *  history), well under {@link DISPATCH_MAX_PARTS}. History trimming that keeps
 *  a transcript's native media under this is a PRODUCT concern (the pointer
 *  block keeps trimmed media reachable); `buildDispatchParts` enforces only the
 *  total {@link DISPATCH_MAX_PARTS} cap. */
export declare const DISPATCH_MAX_MEDIA_PARTS = 24;
/** Size a base64-encoded string occupies on the wire given the raw
 *  (pre-encoding) byte length: base64 packs 3 raw bytes into 4 output
 *  characters, rounded up to the next multiple of 4. */
export declare function base64WireLen(byteLen: number): number;
/**
 * Render a raw byte count as a human-readable size (`512B`, `3KB`, `12MB
 * 500KB`). Ported EXACTLY from gtm-agent's `attachment-limits.ts` — byte-
 * identical implementation, not a reinterpretation — so `resolve-attachments`'s
 * and `promote-file-part`'s error strings match gtm's wording verbatim. Lives
 * in the import-free wire layer (not `resolve-attachments.ts` alone) because
 * BOTH the aggregate-cap message here and the per-file oversize message in
 * `promote-file-part.ts` need it; a browser composer wanting the same
 * formatting for a client-side pre-check can also import it with no engine
 * pulled in.
 */
export declare function formatBytes(bytes: number): string;
/** Represent errors for invalid chat turn inputs with status and code properties */
export declare class ChatTurnInputError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(message: string, status?: number, code?: string);
}
/** Calculate the total byte size of an array of chat turn parts */
export declare function promptPartsByteSize(parts: ChatTurnPartInput[]): number;
/** Throws `ChatTurnInputError` (413) when the parts' inline payload would blow
 *  the gateway cap. Path-ref parts are tiny by construction and always pass. */
export declare function assertPromptPartsWithinCap(parts: ChatTurnPartInput[], maxBytes?: number): void;
/** A file mention resolved from the composer's `@`-picker: the
 *  workspace-relative path plus enough metadata to build a prompt part and
 *  pointer text. `path` is the canonical identity — the mention pill's
 *  `MentionItem.id` for the file kind (`/web-react`'s `useFileMentions`). */
export interface FileMention {
    path: string;
    name: string;
    size?: number;
}
/** The `image/*` mime for a mention path by extension, or `undefined` for
 *  anything not in the known image set (dispatched as `type: 'file'`). */
export declare function mediaTypeForMentionPath(path: string): string | undefined;
/** The image/file split a mention is rendered and persisted under — the
 *  composer pill's icon, the dispatched part's `type`, and
 *  `ChatMentionPart.mentionKind` are all this one value. */
export type ChatMentionKind = 'image' | 'file';
/** `image` when the path's extension is in the known image set (the same table
 *  {@link mediaTypeForMentionPath} reads), `file` otherwise. Exported so a
 *  client that needs only the discriminant — a pill icon, a persisted part's
 *  `mentionKind` — never re-declares the extension table; two frozen copies of
 *  one mime table is how one gains a format and the other doesn't. */
export declare function mentionKindForPath(path: string): ChatMentionKind;
/** Define options to resolve mention paths when converting file mentions to parts */
export interface FileMentionsToPartsOptions {
    /** Resolve a mention's workspace-relative path to the absolute path the
     *  dispatched part should carry (e.g. a host prefixing the in-box vault
     *  root). Default: identity — the path travels unchanged. */
    resolvePath?: (path: string) => string;
}
/** Maps resolved file mentions to path-only `ChatTurnFilePartInput`s —
 *  `image` vs `file` by extension, and always a `path`, never a `url` (the
 *  url/path XOR invariant: a mention is a sandbox path reference, never
 *  inline bytes). */
export declare function fileMentionsToParts(mentions: readonly FileMention[], opts?: FileMentionsToPartsOptions): ChatTurnFilePartInput[];
/** The agent-facing pointer block appended to the dispatched prompt — never
 *  persisted in message `content`. Empty array → `''` so callers can append
 *  unconditionally. This is the sole producer of that text: the current
 *  turn's dispatch and any history projection built from the same mention
 *  list both route through here, so the two can't drift apart. */
export declare function buildMentionPromptBlock(mentions: readonly Pick<FileMention, 'name' | 'path'>[]): string;
/** Hard cap on mentions per turn. Bounds the prompt pointer block, the
 *  persisted parts, and whatever media budget a dispatch draws from them. */
export declare const MENTION_MAX_COUNT = 16;
/** Represent the result of a sandbox mention path check indicating success or failure with an error message */
export type SandboxMentionPathCheck = {
    succeeded: true;
} | {
    succeeded: false;
    error: string;
};
/**
 * Validate a workspace-relative sandbox mention path. Rejects traversal (a
 * `..` path segment), absolute paths (leading `/`), backslashes, and null
 * bytes — the four ways a path picked in a client can escape the root the
 * index route scanned.
 *
 * Spaces and unicode are deliberately ALLOWED: in-box filenames are arbitrary,
 * and an ASCII-only charset would silently drop real files from a feature
 * whose whole job is naming them.
 */
export declare function validateSandboxMentionPath(path: unknown): SandboxMentionPathCheck;
/**
 * Validates the untyped `mentions` array off the wire, mirroring
 * {@link parseChatTurnParts}: the typed list, or `ChatTurnInputError` (400)
 * naming the offending entry. Never sanitizes-and-continues — a traversal path
 * is a rejected request, not a trimmed one.
 *
 * A path repeated within one turn is deduped to its first occurrence rather
 * than rejected: mentioning the same file twice is plausible user input, not
 * an attack.
 */
export declare function parseFileMentions(raw: unknown): FileMention[];
/** Validates the untyped `parts` array off the wire. Returns the typed parts
 *  or throws `ChatTurnInputError` (400) naming the offending entry. */
export declare function parseChatTurnParts(raw: unknown): ChatTurnFilePartInput[];
