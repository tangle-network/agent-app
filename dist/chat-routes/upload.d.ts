/**
 * `createUploadRoute` — the multimodal middle. Accepts multipart file uploads
 * and returns `PromptInputPart`-shaped descriptors the client echoes back on
 * send (`ChatTurnRequestPayload.parts`):
 *
 *   ≤ inlineMaxBytes (700 KiB default) → inline `data:` URI part — rides the
 *     turn body directly, no sandbox round trip.
 *   > inlineMaxBytes → written into the sandbox workspace (base64 through the
 *     structural `write` seam — `box.fs` satisfies it) and referenced by
 *     `path`. Mandatory two-step: the gateway caps request bodies at ~1 MiB,
 *     so a large file can never ride the prompt POST.
 *
 * The sink is structural (no sandbox-SDK import); products pass `box.fs`.
 *
 * @remarks Sole consumer today is the `--chat` scaffold (`create-agent-app
 * --chat` → `template-chat/src/chat.ts`), the reference multimodal path — its
 * inline-`data:`-or-ephemeral-sandbox-workspace split stays the scaffold's
 * proven upload pattern, not a fleet primitive; keep that distinction in mind
 * before widening its surface. Fleet apps with a durable store of their own
 * (KV, or AES-GCM-encrypted R2) no longer need to hand-roll a vault upload
 * route: `createAttachmentUploadRoute` (`./attachment-upload`, agent-app#234)
 * is the shared hardened path for that persistence model — a content-sniffed
 * type gate, two-phase atomic batch writes, and per-kind/aggregate size caps,
 * all seamed through an injected `WriteAttachmentFn`. Point readers there
 * instead of widening this route to cover both models.
 */
import type { ChatTurnFilePartInput } from './wire';
/** 700 KiB: base64 inflates ~4/3, so an inline part stays comfortably under
 *  the ~1 MiB gateway body cap alongside the JSON envelope. */
export declare const UPLOAD_INLINE_MAX_BYTES: number;
/** 8 MiB default ceiling per file — one base64 `write` call handles it. Raise
 *  it only with a sink that can take the bigger single write. */
export declare const UPLOAD_MAX_FILE_BYTES: number;
/** Structural match of the sandbox SDK's `box.fs` write surface (v0.10.5+:
 *  `encoding: 'base64'` is the worker-safe binary path). */
export interface SandboxUploadSink {
    write(path: string, content: string, options?: {
        encoding?: 'utf8' | 'base64';
    }): Promise<unknown>;
}
/** Resolve upload authorization status and provide upload destination or error response */
export type UploadAuthorization = {
    ok: true;
    /** Where large files land. Absent/null: only inline uploads are
     *  accepted and an over-inline-cap file is rejected with 413. */
    sink?: SandboxUploadSink | null;
    /** Per-request override of the workspace directory large files go to. */
    uploadDir?: string;
} | {
    ok: false;
    response: Response;
};
/** Define options to authorize uploads and configure file size limits and upload directory */
export interface CreateUploadRouteOptions {
    /** Authenticate the caller and resolve the sandbox file sink (usually
     *  `ensureWorkspaceSandbox(...)` → `box.fs`). */
    authorize(args: {
        request: Request;
    }): Promise<UploadAuthorization>;
    /** Inline-vs-sandbox threshold. Default {@link UPLOAD_INLINE_MAX_BYTES}. */
    inlineMaxBytes?: number;
    /** Hard per-file cap. Default {@link UPLOAD_MAX_FILE_BYTES}. */
    maxFileBytes?: number;
    /** Absolute workspace directory for path-ref files.
     *  Default `'/workspace/uploads'`. */
    uploadDir?: string;
}
/** One uploaded file, ready for the composer chip and the turn body. */
export interface UploadedChatFile {
    id: string;
    name: string;
    size: number;
    mediaType: string;
    /** True when the part carries the bytes inline (`data:` URI). */
    inline: boolean;
    /** Echo this back verbatim in `ChatTurnRequestPayload.parts`. */
    part: ChatTurnFilePartInput;
}
/** Path-safe file name: basename only, conservative charset, length-capped. */
export declare function sanitizeUploadFilename(name: string): string;
/** Convert a Uint8Array of bytes into a base64-encoded string */
export declare function bytesToBase64(bytes: Uint8Array): string;
/** Create an upload route handler that authorizes requests and processes file uploads with size limits */
export declare function createUploadRoute(options: CreateUploadRouteOptions): (request: Request) => Promise<Response>;
