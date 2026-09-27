/**
 * Renders a message's attachment parts (images + files) as thumbnails and
 * download chips — the transcript-side counterpart to `ChatComposer`'s
 * staged-upload chips. Ported from gtm-agent's `chat-attachment-parts.tsx`
 * onto agent-app's RAW-BYTES download contract: the host supplies
 * `resolveFileUrl(part)`, a URL that serves the attachment's raw bytes
 * directly, so this module never parses a JSON `{file:{blobUrl,body}}`
 * envelope or decodes a `[base64]` marker the way gtm's vault route did.
 *
 * No icon-library or primitives dependency (`ChatComposer`'s house style):
 * the loading skeleton is an inline `animate-pulse` span and the few glyphs
 * are inline SVGs.
 */
import { type ReactNode } from 'react';
import type { ChatAttachmentPart } from './chat-attachments';
/** Typed outcome of fetching one attachment's raw bytes. Callers must check
 *  `ok` before touching `blob` — a failed fetch never produces a blank
 *  render, it produces a visible error state. */
export type AttachmentFileResult = {
    ok: true;
    blob: Blob;
} | {
    ok: false;
    message: string;
};
export declare function __resetAttachmentFileCacheForTests(): void;
/** Fetches (and caches) the raw bytes behind one attachment url. Concurrent
 *  callers for the SAME url dedupe to one in-flight fetch. Only a successful
 *  settlement stays cached — evicting failures means a remount or click-retry
 *  after a transient error issues a fresh fetch. */
export declare function loadAttachmentFile(url: string, fetchFile?: (url: string) => Promise<Response>): Promise<AttachmentFileResult>;
/** Drives an anchor-click download from an already-resolved blob. Returns a
 *  typed outcome rather than throwing — a chip that fails to synthesize the
 *  download must show the failure, not silently no-op. */
export declare function triggerAttachmentDownload(name: string, blob: Blob): {
    ok: true;
} | {
    ok: false;
    message: string;
};
export interface MessageAttachmentsProps {
    parts: ChatAttachmentPart[];
    /** URL serving the attachment's RAW bytes. */
    resolveFileUrl: (part: ChatAttachmentPart) => string;
    /** Row alignment — a user-bubble attachment row is right-aligned by
     *  default; pass `"start"` for an assistant-turn attachment, which sits
     *  inline with the rest of the transcript. */
    justify?: 'start' | 'end';
    /** Override the fetch used to load an attachment's bytes. Default:
     *  `fetch(url, { credentials: 'same-origin' })`. */
    fetchFile?: (url: string) => Promise<Response>;
}
/** Renders a message's attachment parts as a row of image thumbnails and file
 *  chips. `null` when there are none, so callers can render unconditionally
 *  without an extra length check. */
export declare function MessageAttachments({ parts, resolveFileUrl, justify, fetchFile }: MessageAttachmentsProps): ReactNode;
