/**
 * Shared attachment validation core — constants, type-gate, and filename
 * sanitization used by BOTH the (server) attachment upload route and the
 * (browser) composer's client-side pre-validation, so a rejection never
 * differs depending on which side classified the bytes first. The structural
 * `attachments` parser lives here too, so the chat route and the operator API
 * refuse the same turn bodies without either pulling in the chat store.
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

import { formatBytes, type ChatAttachmentInput, type ChatAttachmentKind } from './wire'
import {
  OOXML_PRESENTATION_MACRO_ENABLED_MIME,
  OOXML_PRESENTATION_MIME,
  OOXML_SPREADSHEET_MACRO_ENABLED_MIME,
  OOXML_SPREADSHEET_MIME,
  OOXML_WORD_MACRO_ENABLED_MIME,
  OOXML_WORD_MIME,
} from './binary-sniff'
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
 *
 * Every extension here is one the default {@link ALLOWED_ATTACHMENT_SNIFFED_MIMES}
 * actually admits — a picker that offers a format the gate then rejects is a
 * defect, so `tests/chat-routes/attachment-validation.test.ts` walks this
 * string and proves each entry uploads.
 */
export const ATTACHMENT_ACCEPT =
  'image/*,.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.json,.yaml,.yml,.html'

/** The Office (OOXML) package mimes the default allow-list admits — the
 *  formats professionals actually send: Word contracts, Excel workpapers,
 *  PowerPoint decks. Admitting the format is a gate decision only; whether a
 *  product can EXTRACT text from one is that product's concern. */
export const OOXML_SNIFFED_MIMES: ReadonlySet<string> = new Set([
  OOXML_WORD_MIME,
  OOXML_SPREADSHEET_MIME,
  OOXML_PRESENTATION_MIME,
])

/** Macro-enabled Office package mimes (`.docm`/`.xlsm`/`.pptm`), reported by
 *  `sniffBinary` but deliberately NOT in the default allow-list: a package
 *  carrying a VBA project is a different risk decision than a plain document,
 *  and it is the product's to make. Opt in by widening the allow-list at the
 *  route's `allowedSniffedMimes` seam:
 *  `new Set([...ALLOWED_ATTACHMENT_SNIFFED_MIMES, ...MACRO_ENABLED_OOXML_SNIFFED_MIMES])`. */
export const MACRO_ENABLED_OOXML_SNIFFED_MIMES: ReadonlySet<string> = new Set([
  OOXML_WORD_MACRO_ENABLED_MIME,
  OOXML_SPREADSHEET_MACRO_ENABLED_MIME,
  OOXML_PRESENTATION_MACRO_ENABLED_MIME,
])

/** Sniffed-mime counterpart of `ATTACHMENT_ACCEPT`: the binary formats
 *  `sniffBinary` can identify from content among the accepted types.
 *  Values must match `sniffBinary`'s output strings verbatim, or every
 *  upload of that format fails the type gate — locked by the round-trip test
 *  that sniffs real bytes of every mime listed here. */
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
  ...OOXML_SNIFFED_MIMES,
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
 *  mp4 renamed `.avif` (its content sniffs `video/mp4`, not an allowed mime).
 *  The Office extensions ARE here: a `.zip` renamed `.docx` sniffs
 *  `application/zip` (its container carries neither of the two OPC parts an
 *  Office package must have), so the entry turns a generic 415 into a mismatch
 *  that names what the file actually is. Sniffing answers what format the
 *  bytes CLAIM to be, not whether they are a readable document — see
 *  `sniffOoxml`'s note on what a reader with no inflater can and cannot prove.
 *  The macro-enabled and EBML-video extensions are listed for the same reason
 *  even though the default allow-list refuses them — a product that widens
 *  the allow-list gets the renamed-file check with it. */
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
  docx: OOXML_WORD_MIME,
  xlsx: OOXML_SPREADSHEET_MIME,
  pptx: OOXML_PRESENTATION_MIME,
  docm: OOXML_WORD_MACRO_ENABLED_MIME,
  xlsm: OOXML_SPREADSHEET_MACRO_ENABLED_MIME,
  pptm: OOXML_PRESENTATION_MACRO_ENABLED_MIME,
  webm: 'video/webm',
  mkv: 'video/x-matroska',
}

/** The sniffed mime a filename's extension implies, when its format has an
 *  unambiguous magic-byte family (`.xlsx` → the spreadsheet mime). */
export function sniffedMimeImpliedByName(fileName: string): string | undefined {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? ''
  return EXTENSION_IMPLIES_SNIFFED_MIME[extension]
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

/** Verdict of a path check: OK, or a rejection naming why. Mirrors
 *  `SandboxMentionPathCheck` in `./wire`. */
export type AttachmentPathCheck =
  | { succeeded: true }
  | { succeeded: false; error: string }

/** Longest attachment display name accepted — bounds what gets echoed into the
 *  prompt block and rendered as a chip label. */
const MAX_ATTACHMENT_NAME_LENGTH = 256

function isAttachmentKind(value: unknown): value is ChatAttachmentKind {
  return value === 'image' || value === 'file'
}

/** C0 control characters (0x00–0x1F) plus DEL (0x7F) — covers `\n`/`\r`/`\t`.
 *  A `name` or `path` carrying one of these has no legitimate use here and
 *  everything to gain from an attacker: {@link buildAttachmentPromptBlock} in
 *  `/chat-store` renders both fields verbatim into the dispatched agent
 *  prompt, so an embedded newline fabricates new prompt lines (a
 *  prompt-injection vector) rather than naming a file. Rejected at this
 *  boundary — not merely neutralized downstream — so the wire never accepts
 *  the input in the first place; a legitimate name/path never contains one. */
const CONTROL_CHARS = /[\x00-\x1F\x7F]/

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
export function defaultValidateAttachmentPath(path: string): AttachmentPathCheck {
  if (path.includes('\0')) return { succeeded: false, error: 'attachment path must not contain null bytes' }
  if (path.includes('\\')) return { succeeded: false, error: 'attachment path must not contain backslashes' }
  if (CONTROL_CHARS.test(path)) return { succeeded: false, error: 'attachment path must not contain control characters' }
  if (path.startsWith('/')) return { succeeded: false, error: 'attachment path must be store-relative, not absolute' }
  const segments = path.split('/')
  if (segments.some((segment) => segment === '..')) {
    return { succeeded: false, error: 'attachment path must not contain ".." segments' }
  }
  if (segments.some((segment) => segment.startsWith('.'))) {
    return { succeeded: false, error: 'attachment path must not contain a hidden (dotfile) segment' }
  }
  return { succeeded: true }
}

function parseAttachmentInput(
  value: unknown,
  index: number,
  validatePath: (path: string) => AttachmentPathCheck,
): { succeeded: true; value: ChatAttachmentInput } | { succeeded: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { succeeded: false, error: `attachments[${index}] must be an object` }
  }
  const record = value as Record<string, unknown>

  const path = record.path
  if (typeof path !== 'string' || !path) {
    return { succeeded: false, error: `attachments[${index}].path must be a non-empty string` }
  }
  const name = record.name
  if (typeof name !== 'string' || !name.trim()) {
    return { succeeded: false, error: `attachments[${index}].name must be a non-empty string` }
  }
  if (name.length > MAX_ATTACHMENT_NAME_LENGTH) {
    return { succeeded: false, error: `attachments[${index}].name must not exceed ${MAX_ATTACHMENT_NAME_LENGTH} characters` }
  }
  if (CONTROL_CHARS.test(name)) {
    return { succeeded: false, error: `attachments[${index}].name must not contain control characters` }
  }
  const size = record.size
  if (typeof size !== 'number' || !Number.isFinite(size)) {
    return { succeeded: false, error: `attachments[${index}].size must be a finite number` }
  }
  if (size < 0) {
    return { succeeded: false, error: `attachments[${index}].size must not be negative` }
  }
  const mediaType = record.mediaType
  if (typeof mediaType !== 'string') {
    return { succeeded: false, error: `attachments[${index}].mediaType must be a string` }
  }
  const kind = record.kind
  if (!isAttachmentKind(kind)) {
    return { succeeded: false, error: `attachments[${index}].kind must be "image" or "file"` }
  }

  const pathCheck = validatePath(path)
  if (!pathCheck.succeeded) return { succeeded: false, error: pathCheck.error }

  return { succeeded: true, value: { path, name, size, mediaType, kind } }
}

/** Structural limits for {@link parseChatAttachmentInputs}. */
export interface ParseChatAttachmentInputsOptions {
  /** Most attachments one request may carry. Default {@link ATTACHMENT_MAX_COUNT}. */
  maxCount?: number
  /** Path validator override. Default {@link defaultValidateAttachmentPath}. */
  validatePath?: (path: string) => AttachmentPathCheck
}

/**
 * Validate an `attachments` value's shape without reading the store: an
 * array of at most `maxCount` {@link ChatAttachmentInput}s with valid,
 * distinct paths. Absent (`undefined`/`null`) is an empty list. Sizes are
 * still client-reported here; {@link resolveChatAttachments} re-derives them
 * from the store.
 */
export function parseChatAttachmentInputs(
  value: unknown,
  options: ParseChatAttachmentInputsOptions = {},
): { succeeded: true; value: ChatAttachmentInput[] } | { succeeded: false; error: string } {
  const maxCount = options.maxCount ?? ATTACHMENT_MAX_COUNT
  const validatePath = options.validatePath ?? defaultValidateAttachmentPath

  if (value === undefined || value === null) return { succeeded: true, value: [] }
  if (!Array.isArray(value)) return { succeeded: false, error: 'attachments must be an array' }
  if (value.length > maxCount) {
    return { succeeded: false, error: `attachments must not exceed ${maxCount} entries` }
  }

  const inputs: ChatAttachmentInput[] = []
  const seenPaths = new Set<string>()
  for (let index = 0; index < value.length; index += 1) {
    const parsed = parseAttachmentInput(value[index], index, validatePath)
    if (!parsed.succeeded) return parsed
    if (seenPaths.has(parsed.value.path)) {
      return { succeeded: false, error: `attachments must not repeat a path: ${parsed.value.path}` }
    }
    seenPaths.add(parsed.value.path)
    inputs.push(parsed.value)
  }
  return { succeeded: true, value: inputs }
}
