/**
 * `resolveChatAttachments` — validate a turn body's `attachments` field into
 * persistable {@link ChatAttachmentPart}s. Every path is re-validated (a path
 * off the wire is never trusted to stay inside the store root) and every size
 * is re-derived from the STORED body via the injected {@link ReadAttachmentFn},
 * never the client-reported `size` — the upload path lets a caller rewrite its
 * own frontmatter, so a stored size cannot bound anything and the wire size can
 * be anything. Both the aggregate cap and the size carried on the returned part
 * come from the authoritative read.
 *
 * Storage-parameterized: the frontmatter parsing / base64 sizing that derives
 * the authoritative size lives BEHIND `readAttachment` (a product's vault or
 * object-store adapter), so this module is a pure validator + budget gate with
 * no store knowledge. Lifted from gtm-agent's `resolve-attachments.ts`
 * (workspaceId → scopeId, the vault read → the injected reader) and kept
 * behavior-identical for gtm-agent#618 adoption.
 */
import { type ChatAttachmentPart } from '../chat-store/parts';
import type { ReadAttachmentFn } from './attachment-store';
/** Resolve the result of chat attachment processing with success status and corresponding data or error */
export type ResolveChatAttachmentsResult = {
    succeeded: true;
    value: ChatAttachmentPart[];
} | {
    succeeded: false;
    error: string;
};
/** Verdict of a path check: OK, or a rejection naming why. Mirrors
 *  `SandboxMentionPathCheck` in `./wire`. */
export type AttachmentPathCheck = {
    succeeded: true;
} | {
    succeeded: false;
    error: string;
};
/**
 * Default path validator when a caller supplies none. Rejects the ways a path
 * picked in a client can escape the store root — traversal (`..` segment),
 * absolute (leading `/`), backslashes, null bytes, control characters (see
 * {@link CONTROL_CHARS} — a path also feeds {@link buildAttachmentPromptBlock}'s
 * `(vault: ${path})` pointer, so it is exposed to the same injection surface as
 * `name`) — plus a dotfile/hidden segment (a leading `.` on any segment).
 * Generalized from gtm's `validateVaultFilePath`, in the spirit of
 * `validateSandboxMentionPath` (`/chat-routes`'s wire mention-path validator) —
 * but the dotfile rejection here is INTENTIONALLY stricter than that sibling:
 * an uploaded attachment path is sanitized store-relative storage the product
 * itself assigned, whereas a mention path points at a file that already exists
 * in the sandbox and may legitimately live under a dotfile segment. A caller
 * that needs gtm's exact (looser) rule can supply `validatePath` to override
 * this default entirely.
 */
export declare function defaultValidateAttachmentPath(path: string): AttachmentPathCheck;
/** Define options to resolve and validate chat attachments with size, count, and path constraints */
export interface ResolveChatAttachmentsOptions {
    /** The product's workspace/tenant key, passed to `readAttachment`. */
    scopeId: string;
    /** Authoritative size + content reader — see {@link ReadAttachmentFn}. */
    readAttachment: ReadAttachmentFn;
    /** Most attachments one request may carry. Default {@link ATTACHMENT_MAX_COUNT}. */
    maxCount?: number;
    /** Aggregate raw-byte ceiling. Default {@link MAX_ATTACHMENT_TOTAL_BYTES}. */
    maxTotalBytes?: number;
    /** Path validator override. Default {@link defaultValidateAttachmentPath}. */
    validatePath?: (path: string) => AttachmentPathCheck;
}
/**
 * Validate and resolve a turn body's `attachments` field into persistable
 * parts. Every path is confirmed present (and not deleted) in the caller's own
 * store by `readAttachment` before it is trusted, and size is derived from the
 * authoritative read for both the aggregate cap and the returned part's size.
 */
export declare function resolveChatAttachments(value: unknown, options: ResolveChatAttachmentsOptions): Promise<ResolveChatAttachmentsResult>;
