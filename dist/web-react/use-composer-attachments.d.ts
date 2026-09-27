/**
 * `useComposerAttachments` — the composer's staged-upload lifecycle: validate
 * selected/dropped/pasted files against the shared limits (the SAME
 * `sniffBinary`/`checkAttachmentType`/size-cap vocabulary the store-backed
 * upload route enforces server-side, `../chat-routes/attachment-validation`
 * + `../chat-routes/binary-sniff`), upload each accepted file with one POST
 * request per file (so a single failure never poisons the batch), and track
 * every file's status so a host composer can render chips and gate sending.
 *
 * Ported from gtm-agent's `src/components/composer-attachments.tsx`
 * (gtm#584/#592/#593 hardened the sniff gate and batch semantics this leans
 * on), de-gtm-ified:
 *   - the hardcoded `/api/vault/upload?workspaceId=` URL becomes
 *     `uploadUrl`/`buildUploadRequest` (the latter wins — it hands back both
 *     the URL and a `RequestInit` override, e.g. an auth header);
 *   - `sonner` toasts become `onReject` (client pre-validation, never hits the
 *     network) and `onError` (a request that reached the server and failed);
 *   - the `accept`-string gate comes from `./composer-file-accept`, the one
 *     matcher `ChatComposer` also funnels its picker/drop/paste ingress
 *     through, so both ends of the staging path admit the same files;
 *   - the response is expected to be `{ files: ChatAttachmentInput[] }` (full
 *     server-authoritative descriptors — size/mediaType/kind — not gtm's
 *     `{path, name}`), so `references` is a verbatim pass-through with no
 *     client recompute;
 *   - `workspaceId`'s truthiness gate becomes `enabled` (default `true`).
 *
 * Import-free beyond React + the browser-safe `/chat-routes` validation core:
 * this module ships through `/web-react` into client bundles
 * (`tests/browser-safe-subpaths.test.ts` walks the graph), so nothing here
 * may reach a Node builtin, `sandbox-ui`, or an engine package.
 */
import type { ChatAttachmentInput, ChatAttachmentKind } from './chat-stream';
import type { ComposerFile } from './chat-composer';
export { ATTACHMENT_ACCEPT } from '../chat-routes/attachment-validation';
/** Define options for configuring file upload behavior and handling in a composer component */
export interface UseComposerAttachmentsOptions {
    /** Simple upload target: every file POSTs here. Ignored when
     *  `buildUploadRequest` is provided. */
    uploadUrl?: string;
    /** Full request-building seam (auth headers, per-file routing, …) — wins
     *  over `uploadUrl` when both are set. */
    buildUploadRequest?: (args: {
        file: File;
        name: string;
        form: FormData;
    }) => {
        url: string;
        init?: Omit<RequestInit, 'body' | 'signal'>;
    };
    /** Client pre-validation rejections — a file that never reaches the
     *  network (bad type, over a size cap, over count, disallowed kind). */
    onReject?: (reason: string, file?: File) => void;
    /** A file that reached the upload endpoint and failed (HTTP error,
     *  transport error, malformed response). */
    onError?: (reason: string) => void;
    limits?: {
        maxCount?: number;
        maxBinaryBytes?: number;
        maxTextBytes?: number;
        maxTotalBytes?: number;
    };
    /** Attachment kinds accepted, checked against the sniffed content's
     *  mime. Default: both (`['image', 'file']` — i.e. no restriction). */
    allowedKinds?: ChatAttachmentKind[];
    /** `<input accept>`-style gate for the file picker/drop/paste path.
     *  Default {@link ATTACHMENT_ACCEPT}. */
    accept?: string;
    /** When `false`, `addFiles` rejects every call via `onReject` (and
     *  `blockReason` explains why) instead of staging anything — the
     *  replacement for gtm's `workspaceId`-truthiness gate (e.g. no workspace
     *  loaded yet). Default `true`. */
    enabled?: boolean;
}
/** Provide staged file chips, ready attachments, and methods to add, retry, or drop composer files */
export interface UseComposerAttachmentsResult {
    /** Chip models for `ChatComposer`'s `pendingFiles` prop, one per staged
     *  file — `kind` is always `'file'` (agent-app's `ComposerFile.kind`
     *  discriminates file-vs-folder chips, not attachment media type). */
    composerFiles: ComposerFile[];
    /** Ready-to-send attachment descriptors — only files whose upload
     *  succeeded, straight from the server's response (no recompute). Feed
     *  this into `ChatTurnRequestPayload.attachments`. */
    references: ChatAttachmentInput[];
    /** Validate + stage + upload the given files, one request per file. */
    addFiles: (files: File[] | FileList) => Promise<void>;
    /** Re-upload a failed entry using its retained `File`. */
    retry: (id: string) => void;
    /** Drop one staged entry, aborting its upload and revoking its preview. */
    removeAttachment: (id: string) => void;
    /** Forget every staged entry (call after a successful send). */
    clear: () => void;
    /** True while any file is still pending or uploading. */
    hasPending: boolean;
    /** True while any file failed to upload. */
    hasError: boolean;
    /** Why a send is blocked, or `null` when the queue is clean. */
    blockReason: string | null;
}
/**
 * Owns the composer's attachment lifecycle: validate selected/dropped/pasted
 * files against the shared limits, upload each accepted file to the
 * product's store (one request per file), and track every file's status so
 * the composer can render chips and gate sending.
 *
 * Failures surface loud — a rejected file calls `onReject` and is never
 * uploaded; a failed upload calls `onError` and leaves an error chip the user
 * can retry or remove. `references` only ever contains files whose upload the
 * server actually confirmed.
 */
export declare function useComposerAttachments(options: UseComposerAttachmentsOptions): UseComposerAttachmentsResult;
