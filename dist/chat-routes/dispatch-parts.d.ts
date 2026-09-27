/**
 * `buildDispatchParts` — assemble the `PromptInputPart[]` a turn carrying
 * attachments and/or `@`-mentions dispatches to the sandbox. `parts[0]` is
 * always the full prompt text (typed text plus the attachment + mention pointer
 * blocks); each attachment or mention becomes one media part. An attachment
 * (read from the product store via the injected reader) draws the inline byte
 * budget first; a mention (read from the LIVE box) takes what is left. A file
 * inlines as a `data:` URI when it fits the remaining budget, otherwise uses
 * the in-box file reference supported by the current sandbox prompt contract.
 * Every media part is deduped by its resolved absolute path. This module only
 * produces the parts array; the caller decides when a turn dispatches parts
 * instead of a plain string.
 *
 * Storage-parameterized port of gtm-agent's `dispatch-parts.ts`: the vault
 * default reader is dropped (`readAttachment` is REQUIRED — the product supplies
 * its store adapter), the `GTM_SANDBOX_VAULT_DIR` prefixing becomes the required
 * `resolveAttachmentPath` seam, the `GTM_MULTIMODAL_FORCE_PATH` env fallback
 * becomes an explicit `forcePath` flag, and every budget cap reads an overridable
 * `./wire` constant. Kept behavior-identical for gtm-agent#618 adoption (the
 * demotion math and emitted part shapes reproduce its dispatched prompt bytes).
 */
import { type PromptInputPart } from '../sandbox';
import { type SandboxExecChannel } from '../sandbox/binary-read';
import { type ChatTurnPartInput } from './wire';
import type { ChatAttachmentPart, ChatMentionPart } from '../chat-store/parts';
import type { ReadAttachmentFn } from './attachment-store';
export type { PromptInputPart };
/** Resolve the outcome of dispatching parts with success status and corresponding value or error message */
export type DispatchPartsOutcome = {
    succeeded: true;
    value: PromptInputPart[];
} | {
    succeeded: false;
    error: string;
};
/** One mention file's size (always) and inline bytes (only when the caller
 *  asked for them — a path-only mention never reads its bytes). */
type SandboxMentionReadOutcome = {
    succeeded: true;
    value: {
        size: number;
        base64?: string;
    };
} | {
    succeeded: false;
    error: string;
};
/** Resolve sandbox mention details by reading from a specified path with optional byte reading */
export type ReadSandboxMentionFn = (box: SandboxExecChannel, absolutePath: string, options: {
    readBytes: boolean;
}) => Promise<SandboxMentionReadOutcome>;
/**
 * Convert the browser-safe chat attachment contract into the current sandbox
 * prompt contract. Images carry exactly one URL or path; generic files carry a
 * filename and URL.
 */
export declare function normalizeChatPromptForSandbox(prompt: string | readonly ChatTurnPartInput[]): string | PromptInputPart[];
/** Build input parameters for dispatching chat message parts including text, attachments, mentions, and history */
export interface BuildDispatchPartsInput {
    text: string;
    attachments: ChatAttachmentPart[];
    mentions?: ChatMentionPart[];
    history: Array<{
        role: 'user' | 'assistant';
        content: string;
    }>;
    systemPrompt: string;
    /** Serialized size of the backend profile the SDK inlines into the same
     *  prompt request body — a large, non-negotiable rider that must come out of
     *  the inline budget or near-cap attachments 413 at the proxy instead of
     *  demoting to path parts. */
    profileWireBytes: number;
    /** The product's workspace/tenant key, passed to `readAttachment`. */
    scopeId: string;
    /** Maps an attachment's store-relative path to the in-box absolute path a
     *  local media reference uses (same style as `fileMentionsToParts`'s
     *  `resolvePath`). */
    resolveAttachmentPath: (path: string) => string;
    /** Maps a mention's workspace-relative path to its in-box absolute path.
     *  Default: {@link BuildDispatchPartsInput.resolveAttachmentPath} — in gtm the
     *  vault mount roots both; a product that mounts them apart overrides this. */
    resolveMentionPath?: (path: string) => string;
    /** The turn's already-ensured box — required when `mentions` is non-empty
     *  (mention bytes are read from the live box, not the store). */
    box?: SandboxExecChannel;
    /** Force every media part to a local file reference, skipping all inlining. */
    forcePath?: boolean;
    /** REQUIRED store reader for attachment content — no default (the product
     *  owns its store; see {@link ReadAttachmentFn}). */
    readAttachment: ReadAttachmentFn;
    readSandboxMention?: ReadSandboxMentionFn;
    /** Whole-request proxy cap. Default {@link DISPATCH_REQUEST_MAX_BYTES}. */
    requestMaxBytes?: number;
    /** JSON-envelope reserve off the top of the request cap. Default
     *  {@link DISPATCH_STRUCTURAL_RESERVE_BYTES}. */
    structuralReserveBytes?: number;
    /** Sidecar per-request parts-array cap. Default {@link DISPATCH_MAX_PARTS}. */
    maxParts?: number;
}
/** Build dispatch parts from input by resolving mentions, paths, and applying size constraints asynchronously */
export declare function buildDispatchParts(input: BuildDispatchPartsInput): Promise<DispatchPartsOutcome>;
