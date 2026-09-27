/**
 * Shared attachment validation core — constants, type-gate, and filename
 * sanitization used by BOTH the (server) attachment upload route and the
 * (browser) composer's client-side pre-validation, so a rejection never
 * differs depending on which side classified the bytes first.
 *
 * ≈ gtm-agent's `src/lib/attachment-limits.ts`, minus what agent-app already
 * has (`ATTACHMENT_MAX_COUNT`/`MAX_ATTACHMENT_TOTAL_BYTES`/
 * `attachmentTotalSizeErrorMessage` lived in `./resolve-attachments` and are
 * re-homed here so the whole validation vocabulary — count cap, size caps,
 * and type gate — has one address). Import-free besides `./wire`
 * (`formatBytes`) and `./binary-sniff` (`SniffResult`): `/web-react`
 * re-exports `/chat-routes` modules into browser bundles
 * (`tests/browser-safe-subpaths.test.ts` walks the graph), so nothing here
 * may reach a Node builtin or an engine package.
 */
import type { SniffResult } from './binary-sniff';
/** Ceiling on a binary attachment's raw (pre-encoding) byte size. */
export declare const MAX_BINARY_ATTACHMENT_BYTES: number;
/** Ceiling on a text attachment's raw byte size. Text hydrates through
 *  inline prompt parts, a separate path that remains proxy-capped (see
 *  `INLINE_PARTS_MAX_BYTES` in `./wire`). */
export declare const MAX_TEXT_ATTACHMENT_BYTES: number;
/** Most files a single request may carry: the composer staging cap, the
 *  upload route's per-request cap, and the chat body's `attachments` cap. */
export declare const ATTACHMENT_MAX_COUNT = 10;
/** Aggregate raw-byte ceiling across one message's attachments. */
export declare const MAX_ATTACHMENT_TOTAL_BYTES: number;
/**
 * Accept list for the composer file picker + type validation, same grammar as
 * the native `<input accept>` attribute. Images plus the text/doc types a
 * product's store actually reads.
 *
 * Every extension here is one the default {@link ALLOWED_ATTACHMENT_SNIFFED_MIMES}
 * actually admits — a picker that offers a format the gate then rejects is a
 * defect, so `tests/chat-routes/attachment-validation.test.ts` walks this
 * string and proves each entry uploads.
 */
export declare const ATTACHMENT_ACCEPT = "image/*,.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.json,.yaml,.yml,.html";
/** The Office (OOXML) package mimes the default allow-list admits — the
 *  formats professionals actually send: Word contracts, Excel workpapers,
 *  PowerPoint decks. Admitting the format is a gate decision only; whether a
 *  product can EXTRACT text from one is that product's concern. */
export declare const OOXML_SNIFFED_MIMES: ReadonlySet<string>;
/** Macro-enabled Office package mimes (`.docm`/`.xlsm`/`.pptm`), reported by
 *  `sniffBinary` but deliberately NOT in the default allow-list: a package
 *  carrying a VBA project is a different risk decision than a plain document,
 *  and it is the product's to make. Opt in by widening the allow-list at the
 *  route's `allowedSniffedMimes` seam:
 *  `new Set([...ALLOWED_ATTACHMENT_SNIFFED_MIMES, ...MACRO_ENABLED_OOXML_SNIFFED_MIMES])`. */
export declare const MACRO_ENABLED_OOXML_SNIFFED_MIMES: ReadonlySet<string>;
/** Sniffed-mime counterpart of `ATTACHMENT_ACCEPT`: the binary formats
 *  `sniffBinary` can identify from content among the accepted types.
 *  Values must match `sniffBinary`'s output strings verbatim, or every
 *  upload of that format fails the type gate — locked by the round-trip test
 *  that sniffs real bytes of every mime listed here. */
export declare const ALLOWED_ATTACHMENT_SNIFFED_MIMES: ReadonlySet<string>;
/** Represent the result of checking an attachment's type with success or specific failure details */
export type AttachmentTypeCheckResult = {
    succeeded: true;
} | {
    succeeded: false;
    code: 'attachment_type_mismatch' | 'attachment_type_not_allowed';
    message: string;
};
/**
 * Cross-check a filename's extension against its sniffed content.
 *
 * Text content (`sniff.binary === false`) always passes here — it has no
 * magic bytes to compare, so it rides the existing UTF-8 gate instead. For
 * binary content: an extension with an unambiguous magic-byte family (e.g.
 * `.pdf`) must match the sniffed mime, or the upload is a mismatch (a
 * renamed file). Otherwise the sniffed mime must be one of `allowed`
 * (default {@link ALLOWED_ATTACHMENT_SNIFFED_MIMES}), or the upload is
 * rejected outright. The `allowed` param feeds a route's override seam (a
 * product accepting a narrower or wider set than the default).
 */
export declare function checkAttachmentType(fileName: string, sniff: SniffResult, allowed?: ReadonlySet<string>): AttachmentTypeCheckResult;
/**
 * Rewrite a filename into the store-path charset (`A-Za-z0-9._-` per
 * segment) — attachment paths double as store keys, sandbox file paths, and
 * in-message path references, none of which tolerate spaces or punctuation.
 * Runs of unsupported characters collapse to one `-`; leading dots/dashes are
 * stripped so the name can't read as a hidden segment. The original name is
 * preserved separately (the returned `ChatAttachmentInput.name`), so
 * sanitization loses nothing.
 */
export declare function sanitizeAttachmentFileName(name: string): string;
/** Human-readable error naming both the actual size and the limit that was
 *  exceeded. Shared so the server route and the composer pre-check report
 *  the same message shape. */
export declare function attachmentSizeErrorMessage(name: string, actualBytes: number, limitBytes: number): string;
/** Human-readable error for a chat message whose combined attachments exceed
 *  the aggregate raw-byte ceiling. */
export declare function attachmentTotalSizeErrorMessage(totalBytes: number, limitBytes: number): string;
