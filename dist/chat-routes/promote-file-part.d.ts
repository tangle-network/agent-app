/**
 * `promoteAgentFilePart` — turn a harness-emitted `type:"file"` stream part
 * into a store-backed {@link ChatAttachmentPart}. The harness hands back a URL
 * pointing at bytes it produced (a `data:` URI, or a path inside the sandbox);
 * nothing durable survives past the turn unless it is written into the
 * product's store, the same way a user upload is. Typed outcomes throughout:
 * every failure mode (unsupported scheme, no sandbox, oversize, store-write
 * failure, malformed part) resolves to `{ succeeded: false, filename, reason }`
 * rather than throwing past this boundary, so the caller folds a visible notice
 * instead of losing the file silently.
 *
 * Storage-parameterized port of gtm-agent's `promote-file-parts.ts` with the
 * refactor gtm never made: persistence goes through an injected stable writer
 * or ownership-safe adapter, the path strategy is the injected
 * `buildAttachmentPath` (neutral `uploads/agent/<date>/` default, no domain
 * bucket taxonomy baked), the MIME map is an injectable hook, and the date
 * segment reads an injectable clock. The logical `hash8(id ?? url ?? filename)`
 * naming is preserved. Atomic callers also receive a fresh ownership suffix so
 * an ambiguous write cannot overwrite an older object.
 */
import { type SandboxExecChannel } from '../sandbox/binary-read';
import { type ChatAttachmentKind, type ChatAttachmentPart } from '../chat-store/parts';
import { type AtomicAttachmentWriter, type WriteAttachmentFn } from './attachment-store';
/** Default ceiling on a promoted file's raw (pre-encoding) byte size. */
export declare const PROMOTE_MAX_FILE_BYTES: number;
/** Define the structure for a raw file part with optional metadata and media type information */
export interface RawAgentFilePart {
    type: 'file';
    id?: string;
    filename?: string;
    /** AI-SDK-shaped parts carry the MIME type here… */
    mediaType?: string;
    /** …but OpenCode's native FilePart calls the same field `mime`. */
    mime?: string;
    url?: string;
}
/** Resolve the result of promoting a file part with success status and relevant data or error details */
export type PromoteFilePartResult = {
    succeeded: true;
    part: ChatAttachmentPart;
} | {
    succeeded: false;
    filename: string;
    reason: string;
};
/** Arguments handed to a {@link PromoteAgentFilePartOptions.buildAttachmentPath}
 *  override — everything needed to place the file deterministically. */
export interface AttachmentPathArgs {
    /** Sanitized display filename (basename, safe charset). */
    filename: string;
    /** First 8 hex chars of the SHA-256 idempotency digest. */
    hash8: string;
    /** `YYYY-MM-DD` from the injected clock. */
    date: string;
    /** Resolved media type. */
    mediaType: string;
    /** `image`/`file` split of the media type. */
    kind: ChatAttachmentKind;
}
/** Default MIME hook: extension → mime, or `text/plain` for the unknown. */
export declare function sniffMimeFromName(filename: string): string;
type PromoteFilePartLogger = Pick<Console, 'error'>;
interface PromoteFilePartCommonOptions {
    raw: RawAgentFilePart;
    /** The turn's box — required only to promote a sandbox-path part; a `data:`
     *  URI needs none. */
    box?: SandboxExecChannel;
    /** The product's workspace/tenant key, passed to `writeAttachment`. */
    scopeId: string;
    /** The turn's session id, used for the sandbox stat/read exec calls. */
    sessionId: string;
    /** Store-path strategy. Default {@link defaultBuildAttachmentPath}. */
    buildAttachmentPath?: (args: AttachmentPathArgs) => string;
    /** Raw-byte ceiling. Default {@link PROMOTE_MAX_FILE_BYTES}. */
    maxBytes?: number;
    /** Last-resort media-type hook. Default {@link sniffMimeFromName}. */
    sniffMime?: (filename: string) => string;
    /** Clock for the date path segment. Default `() => new Date()`. */
    now?: () => Date;
    /** Unique id source for tests or a product's id service. */
    createWriteId?: () => string;
    /** Server-side sink for redacted storage details. */
    logger?: PromoteFilePartLogger;
}
/** Stable promotion options from the original writer contract. */
export interface PromoteAgentFilePartOptions extends PromoteFilePartCommonOptions {
    /** REQUIRED store writer — no default (the product owns its store). */
    writeAttachment: WriteAttachmentFn;
}
/** Ownership-safe promotion options for new products. */
export interface AtomicPromoteAgentFilePartOptions extends PromoteFilePartCommonOptions {
    /** Complete writer + ambiguous-write cleanup adapter. */
    attachmentWriter: AtomicAttachmentWriter;
}
/** Promote a part using the stable writer contract. */
export declare function promoteAgentFilePart(options: PromoteAgentFilePartOptions): Promise<PromoteFilePartResult>;
/** Promote a part using an ownership-safe writer and cleanup adapter. */
export declare function promoteAgentFilePart(options: AtomicPromoteAgentFilePartOptions): Promise<PromoteFilePartResult>;
/** Promote a part when the caller selects the writer contract at runtime. */
export declare function promoteAgentFilePart(options: PromoteAgentFilePartOptions | AtomicPromoteAgentFilePartOptions): Promise<PromoteFilePartResult>;
export {};
