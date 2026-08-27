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

import { formatBytes } from './wire'
import type { SniffResult } from './binary-sniff'

/** Ceiling on a binary attachment's raw (pre-encoding) byte size. */
export const MAX_BINARY_ATTACHMENT_BYTES = 10 * 1024 * 1024

/** Ceiling on a text attachment's raw byte size. Text hydrates through
 *  inline prompt parts, a separate path that remains proxy-capped (see
 *  `INLINE_PARTS_MAX_BYTES` in `./wire`). */
export const MAX_TEXT_ATTACHMENT_BYTES = 950 * 1024

/** Most files a single request may carry: the composer staging cap, the
 *  upload route's per-request cap, and the chat body's `attachments` cap. */
export const ATTACHMENT_MAX_COUNT = 10

/** Aggregate raw-byte ceiling across one message's attachments. */
export const MAX_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024

/**
 * Accept list for the composer file picker + type validation, same grammar as
 * the native `<input accept>` attribute. Images plus the text/doc types a
 * product's store actually reads.
 */
export const ATTACHMENT_ACCEPT =
  'image/*,.pdf,.txt,.md,.csv,.json,.yaml,.yml,.html'

/** Sniffed-mime counterpart of `ATTACHMENT_ACCEPT`: the binary formats
 *  `sniffBinary` can identify from magic bytes among the accepted types.
 *  Values must match `sniffBinary`'s output strings verbatim, or every
 *  upload of that format fails the type gate. */
export const ALLOWED_ATTACHMENT_SNIFFED_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/bmp',
  'image/tiff',
  'image/x-icon',
  'image/webp',
  'image/svg+xml',
  'image/avif',
  'image/heic',
  'image/heif',
  'application/pdf',
])

/** Extensions whose magic-byte family is unambiguous, mapped to the mime
 *  `sniffBinary` emits for genuine content of that format. Keep in sync with
 *  `ATTACHMENT_ACCEPT`: an extension only belongs here if its format has a
 *  detectable magic-byte signature. Text extensions (.txt/.md/.csv/.json/
 *  .yaml/.yml/.html) are deliberately absent — they have no magic bytes to
 *  compare against, so they ride the plain UTF-8 gate instead. AVIF/HEIC/HEIF
 *  extensions are also deliberately absent: the ISO-BMFF brand-to-extension
 *  mapping in that family isn't one-to-one (a legitimate `.heic` can carry a
 *  `mif1` brand), so an extension-implies-mime entry would reject genuine
 *  files. They still ride the allowlist gate below, which is what catches an
 *  mp4 renamed `.avif` (its content sniffs `video/mp4`, not an allowed mime). */
const EXTENSION_IMPLIES_SNIFFED_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  ico: 'image/x-icon',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
}

/** Represent the result of checking an attachment's type with success or specific failure details */
export type AttachmentTypeCheckResult =
  | { succeeded: true }
  | { succeeded: false; code: 'attachment_type_mismatch' | 'attachment_type_not_allowed'; message: string }

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
export function checkAttachmentType(
  fileName: string,
  sniff: SniffResult,
  allowed: ReadonlySet<string> = ALLOWED_ATTACHMENT_SNIFFED_MIMES,
): AttachmentTypeCheckResult {
  if (sniff.binary === false) return { succeeded: true }

  const extension = fileName.split('.').pop()?.toLowerCase() ?? ''
  const impliedMime = EXTENSION_IMPLIES_SNIFFED_MIME[extension]
  if (impliedMime && sniff.mime && sniff.mime !== impliedMime) {
    return {
      succeeded: false,
      code: 'attachment_type_mismatch',
      message: `${fileName} has a .${extension} extension, but its content is ${sniff.mime}`,
    }
  }

  if (!sniff.mime || !allowed.has(sniff.mime)) {
    return {
      succeeded: false,
      code: 'attachment_type_not_allowed',
      message: sniff.mime
        ? `${fileName}'s content (${sniff.mime}) is not an allowed attachment type`
        : `${fileName}'s content is not a recognized attachment type`,
    }
  }

  return { succeeded: true }
}

/**
 * Rewrite a filename into the store-path charset (`A-Za-z0-9._-` per
 * segment) — attachment paths double as store keys, sandbox file paths, and
 * in-message path references, none of which tolerate spaces or punctuation.
 * Runs of unsupported characters collapse to one `-`; leading dots/dashes are
 * stripped so the name can't read as a hidden segment. The original name is
 * preserved separately (the returned `ChatAttachmentInput.name`), so
 * sanitization loses nothing.
 */
export function sanitizeAttachmentFileName(name: string): string {
  const sanitized = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
  return sanitized || 'file'
}

/** Human-readable error naming both the actual size and the limit that was
 *  exceeded. Shared so the server route and the composer pre-check report
 *  the same message shape. */
export function attachmentSizeErrorMessage(name: string, actualBytes: number, limitBytes: number): string {
  return `${name} is ${formatBytes(actualBytes)}; attachments are limited to ${formatBytes(limitBytes)}`
}

/** Human-readable error for a chat message whose combined attachments exceed
 *  the aggregate raw-byte ceiling. */
export function attachmentTotalSizeErrorMessage(totalBytes: number, limitBytes: number): string {
  return `Attachments total ${formatBytes(totalBytes)}; each message is limited to ${formatBytes(limitBytes)}`
}
