/**
 * `createAttachmentUploadRoute` — the fleet-primitive durable-store upload
 * route: a two-phase batch (every file is validated before any file is written),
 * with a stable legacy lane and an ownership-safe receipt lane for new callers,
 * a content-sniffed type gate
 * (`checkAttachmentType` over `sniffBinary`'s magic-byte read, not the
 * extension or the browser-reported MIME), binary/text caps with optional
 * per-sniffed-mime overrides, an aggregate byte cap, and sanitized filenames.
 * Storage is fully seamed through the injected
 * `WriteAttachmentFn` or `AtomicAttachmentWriter` (`./attachment-store`) — no
 * default store, the product owns where bytes actually live (vault, object
 * store, …), and auth/rate limiting is entirely the injected `authorize`
 * seam's job: this factory
 * never invents a 401 or 429 response, it only returns `auth.response`
 * verbatim on failure.
 *
 * Lifted from gtm-agent's `src/routes/api.vault.upload.ts` (the hardening
 * lineage other lifted modules in this vertical cite: gtm#584 binary
 * corruption, gtm#592 sniff gate/caps, gtm#593 batch-atomic writes) and
 * generalized the way `resolve-attachments.ts` generalized gtm's read path —
 * the vault-specific pieces (KV vault paths, frontmatter, per-user rate
 * limiting) are all injected seams here, while the validate-then-write phase
 * split and the type/size gate ordering survive byte-for-byte.
 *
 * @remarks Sibling to, NOT an extension of, `./upload.ts`'s
 * `createUploadRoute` — a different persistence model (durable product store
 * vs. inline-`data:`-or-ephemeral-sandbox-workspace). See that module's doc
 * comment for the up-to-date framing between the two.
 */
import type { ChatAttachmentKind } from './wire';
import { type AtomicAttachmentWriter, type WriteAttachmentFn } from './attachment-store';
import { type AttachmentPathCheck } from './resolve-attachments';
/** Stable authorization result for the original writer contract. */
export type AttachmentUploadAuthorization = {
    ok: true;
    scopeId: string;
    writeAttachment?: WriteAttachmentFn;
} | {
    ok: false;
    response: Response;
};
/** Authorization result for an ownership-safe attachment writer. */
export type AtomicAttachmentUploadAuthorization = {
    ok: true;
    scopeId: string;
    attachmentWriter?: AtomicAttachmentWriter;
} | {
    ok: false;
    response: Response;
};
/** The logger receives only sanitized backend details. The client receives the
 * opaque message below, regardless of the store's failure text. */
export type AttachmentUploadLogger = Pick<Console, 'error'>;
interface AttachmentUploadRouteCommonOptions {
    /** Overridable caps. Defaults come from `./attachment-validation`. */
    limits?: {
        /** Most files one request may carry. Default {@link ATTACHMENT_MAX_COUNT}. */
        maxCount?: number;
        /** Ceiling on a binary file's raw size. Default {@link MAX_BINARY_ATTACHMENT_BYTES}. */
        maxBinaryBytes?: number;
        /** Optional binary-file ceilings keyed by the content-sniffed mime. */
        maxBytesBySniffedMime?: ReadonlyMap<string, number>;
        /** Ceiling on a text file's raw size. Default {@link MAX_TEXT_ATTACHMENT_BYTES}. */
        maxTextBytes?: number;
        /** Aggregate raw-byte ceiling. Default {@link MAX_ATTACHMENT_TOTAL_BYTES}. */
        maxTotalBytes?: number;
    };
    /** Attachment kinds this route accepts. Default `['image', 'file']`. */
    allowedKinds?: ChatAttachmentKind[];
    /** Sniffed-mime allowlist fed to `checkAttachmentType`. */
    allowedSniffedMimes?: ReadonlySet<string>;
    /** Sanitized-name → logical store path. */
    pathFor?: (name: string) => string;
    /** Store-path validator. Default {@link defaultValidateAttachmentPath}. */
    validatePath?: (path: string) => AttachmentPathCheck;
    /** Last-resort media-type hook for text content the sniffer cannot type. */
    sniffMime?: (name: string) => string;
    /** Unique id source for atomic ownership keys. */
    createWriteId?: () => string;
    /** Server-side error sink. Backend text is sanitized before it is logged. */
    logger?: AttachmentUploadLogger;
}
/** Stable route options for products using the original writer contract. */
export interface CreateLegacyAttachmentUploadRouteOptions extends AttachmentUploadRouteCommonOptions {
    /** Authenticate the caller, rate-limit, and resolve the store scope
     *  (workspace/tenant id) — never a query param. */
    authorize(args: {
        request: Request;
    }): Promise<AttachmentUploadAuthorization>;
    /** Stable writer. `authorize` may override it per-request. */
    writeAttachment: WriteAttachmentFn;
}
/**
 * The original public route-options interface remains available for consumers
 * that extend it. Ownership-safe callers use the atomic interface below.
 */
export interface CreateAttachmentUploadRouteOptions extends CreateLegacyAttachmentUploadRouteOptions {
}
/** Ownership-safe route options for new products. */
export interface CreateAtomicAttachmentUploadRouteOptions extends AttachmentUploadRouteCommonOptions {
    /** Authenticate the caller, rate-limit, and resolve the store scope. */
    authorize(args: {
        request: Request;
    }): Promise<AtomicAttachmentUploadAuthorization>;
    /** Complete writer + ambiguous-write cleanup adapter. */
    attachmentWriter: AtomicAttachmentWriter;
}
/** Resolve an attachment upload route handler with customizable limits and validation options. */
export declare function createAttachmentUploadRoute(options: CreateAttachmentUploadRouteOptions | CreateAtomicAttachmentUploadRouteOptions): (request: Request) => Promise<Response>;
export {};
