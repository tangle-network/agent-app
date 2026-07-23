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
 * refactor gtm never made: persistence goes through the injected
 * {@link WriteAttachmentFn} (gtm hard-wired its vault writer), the path strategy
 * is the injected `buildAttachmentPath` (neutral `uploads/agent/<date>/` default,
 * no domain bucket taxonomy baked), the MIME map is an injectable hook, and the
 * date segment reads an injectable clock. The idempotent `hash8(id ?? url ??
 * filename)` naming is preserved so re-promoting the same source part resolves
 * to the same path.
 */

import {
  statSandboxFileSize,
  readSandboxBinaryBytes,
  type SandboxExecChannel,
} from '../sandbox/binary-read'
import { attachmentKindForMime, type ChatAttachmentKind, type ChatAttachmentPart } from '../chat-store/parts'
import type { WriteAttachmentFn } from './attachment-store'
import { formatBytes } from './wire'

/** Default ceiling on a promoted file's raw (pre-encoding) byte size. */
export const PROMOTE_MAX_FILE_BYTES = 10 * 1024 * 1024

export interface RawAgentFilePart {
  type: 'file'
  id?: string
  filename?: string
  /** AI-SDK-shaped parts carry the MIME type here… */
  mediaType?: string
  /** …but OpenCode's native FilePart calls the same field `mime`. */
  mime?: string
  url?: string
}

export type PromoteFilePartResult =
  | { succeeded: true; part: ChatAttachmentPart }
  | { succeeded: false; filename: string; reason: string }

type ByteResolution =
  | { succeeded: true; bytes: Uint8Array }
  | { succeeded: false; reason: string }

/** Arguments handed to a {@link PromoteAgentFilePartOptions.buildAttachmentPath}
 *  override — everything needed to place the file deterministically. */
export interface AttachmentPathArgs {
  /** Sanitized display filename (basename, safe charset). */
  filename: string
  /** First 8 hex chars of the SHA-256 idempotency digest. */
  hash8: string
  /** `YYYY-MM-DD` from the injected clock. */
  date: string
  /** Resolved media type. */
  mediaType: string
  /** `image`/`file` split of the media type. */
  kind: ChatAttachmentKind
}

/** Minimal extension→mime map — the last-resort media type when the part
 *  carries none. Generic file typing, NOT a product accept-list (which is a
 *  domain value the product supplies): an unknown extension falls to
 *  `text/plain`, it never rejects. */
const EXT_TO_MIME: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
}

/** Default MIME hook: extension → mime, or `text/plain` for the unknown. */
export function sniffMimeFromName(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  if (!ext) return 'text/plain'
  return EXT_TO_MIME[ext] ?? 'text/plain'
}

/**
 * Rewrite a filename into a store-path-safe charset (`A-Za-z0-9._-`). Runs of
 * unsupported characters collapse to one `-`; leading dots/dashes are stripped
 * so the name can't read as a hidden segment. The original name is preserved on
 * the returned part, so sanitization loses nothing.
 */
function sanitizeAttachmentFileName(name: string): string {
  const sanitized = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
  return sanitized || 'file'
}

/** Decode base64 with `atob` (not `Buffer.from`, which SKIPS out-of-alphabet
 *  characters and would decode a corrupt payload to something plausible). */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function parseDataUrl(url: string): { base64: boolean; data: string } | null {
  const match = /^data:[^,]*,([\s\S]*)$/.exec(url)
  if (!match) return null
  return { base64: /;base64,/i.test(url), data: match[1] ?? '' }
}

/** The MIME type embedded in a `data:` URI's header, if any — the last-resort
 *  signal when the part itself carries no mediaType/mime field. */
function dataUrlMime(url: string | undefined): string | undefined {
  if (!url) return undefined
  const match = /^data:([^;,]+)[;,]/.exec(url)
  return match ? match[1] : undefined
}

function basenameFromUrl(url: string | undefined): string | undefined {
  if (!url || url.startsWith('data:')) return undefined
  const withoutQuery = url.split(/[?#]/)[0] ?? url
  const segments = withoutQuery.split('/').filter(Boolean)
  return segments[segments.length - 1] || undefined
}

/** `file://<path>` strips to `<path>`; a bare absolute path passes through
 *  unchanged. The remainder is percent-decoded — sidecar file URLs encode
 *  spaces and other reserved characters. */
function resolveFileUrlPath(url: string): { succeeded: true; path: string } | { succeeded: false; reason: string } {
  const withoutScheme = url.startsWith('file://') ? url.slice('file://'.length) : url
  try {
    return { succeeded: true, path: decodeURIComponent(withoutScheme) }
  } catch (err) {
    return { succeeded: false, reason: `malformed file path: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** Matches gtm's `attachmentSizeErrorMessage` (attachment-limits.ts:87-89)
 *  verbatim, via the shared {@link formatBytes} — e.g. "report.pdf is 10MB;
 *  attachments are limited to 10MB" — so an oversize promotion notice reads
 *  identically whether gtm's original composed it or agent-app's promoter did. */
function oversizeReason(filename: string, actual: number, limit: number): string {
  return `${filename} is ${formatBytes(actual)}; attachments are limited to ${formatBytes(limit)}`
}

function resolveDataUrlBytes(url: string, filename: string, maxBytes: number): ByteResolution {
  const parsed = parseDataUrl(url)
  if (!parsed) return { succeeded: false, reason: 'malformed data URI' }
  let bytes: Uint8Array
  try {
    bytes = parsed.base64 ? base64ToBytes(parsed.data) : new TextEncoder().encode(decodeURIComponent(parsed.data))
  } catch (err) {
    return { succeeded: false, reason: `failed to decode data URI: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (bytes.byteLength > maxBytes) {
    return { succeeded: false, reason: oversizeReason(filename, bytes.byteLength, maxBytes) }
  }
  return { succeeded: true, bytes }
}

async function resolveSandboxFileBytes(input: {
  path: string
  box: SandboxExecChannel
  sessionId: string
  filename: string
  maxBytes: number
}): Promise<ByteResolution> {
  // exec can reject outright (box teardown, timeout, transport failure) — that
  // is a per-file failure, not a turn failure, so it must resolve to a typed
  // outcome like a nonzero exit code does.
  const stat = await statSandboxFileSize(input.box, input.path, { sessionId: input.sessionId })
  if (!stat.succeeded) {
    return { succeeded: false, reason: `could not stat agent file: ${stat.error}` }
  }
  // Rejected before the bytes are ever pulled — a base64 exec of an oversize
  // file would waste a full sandbox round trip only to be discarded.
  if (stat.value > input.maxBytes) {
    return { succeeded: false, reason: oversizeReason(input.filename, stat.value, input.maxBytes) }
  }

  const read = await readSandboxBinaryBytes(input.box, input.path, stat.value, { sessionId: input.sessionId })
  if (!read.succeeded) {
    return { succeeded: false, reason: `could not read agent file: ${read.error}` }
  }
  return { succeeded: true, bytes: read.value.bytes }
}

async function resolveBytes(input: {
  raw: RawAgentFilePart
  box: SandboxExecChannel | undefined
  sessionId: string
  filename: string
  maxBytes: number
}): Promise<ByteResolution> {
  const url = input.raw.url
  if (!url) return { succeeded: false, reason: 'the file part carries no url' }

  if (url.startsWith('data:')) return resolveDataUrlBytes(url, input.filename, input.maxBytes)

  const isSandboxPath = url.startsWith('file://') || url.startsWith('/')
  if (!isSandboxPath) return { succeeded: false, reason: `unsupported file URL scheme: ${url}` }
  if (!input.box) return { succeeded: false, reason: 'no sandbox to read agent file' }

  const resolvedPath = resolveFileUrlPath(url)
  if (!resolvedPath.succeeded) return resolvedPath
  return resolveSandboxFileBytes({
    path: resolvedPath.path,
    box: input.box,
    sessionId: input.sessionId,
    filename: input.filename,
    maxBytes: input.maxBytes,
  })
}

/** First 8 hex chars of the SHA-256 of `seed` — deterministic (no
 *  `Math.random`) so promoting the same source part twice, even across
 *  requests, resolves to the same store path and overwrites in place. */
async function hash8(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed))
  return Array.from(new Uint8Array(digest).slice(0, 4))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/** Neutral default placement: everything under `uploads/agent/<date>/`, named
 *  `<base>-<hash8><ext>`. No domain bucket taxonomy (assets/audio/videos…) —
 *  a product that wants one supplies `buildAttachmentPath`. */
function defaultBuildAttachmentPath(args: AttachmentPathArgs): string {
  const extensionMatch = /\.[A-Za-z0-9]+$/.exec(args.filename)
  const extension = extensionMatch ? extensionMatch[0] : ''
  const base = extension ? args.filename.slice(0, -extension.length) : args.filename
  return `uploads/agent/${args.date}/${base}-${args.hash8}${extension}`
}

export interface PromoteAgentFilePartOptions {
  raw: RawAgentFilePart
  /** The turn's box — required only to promote a sandbox-path part; a `data:`
   *  URI needs none. */
  box?: SandboxExecChannel
  /** The product's workspace/tenant key, passed to `writeAttachment`. */
  scopeId: string
  /** The turn's session id, used for the sandbox stat/read exec calls. */
  sessionId: string
  /** REQUIRED store writer — no default (the product owns its store). */
  writeAttachment: WriteAttachmentFn
  /** Store-path strategy. Default {@link defaultBuildAttachmentPath}. */
  buildAttachmentPath?: (args: AttachmentPathArgs) => string
  /** Raw-byte ceiling. Default {@link PROMOTE_MAX_FILE_BYTES}. */
  maxBytes?: number
  /** Last-resort media-type hook. Default {@link sniffMimeFromName}. */
  sniffMime?: (filename: string) => string
  /** Clock for the date path segment. Default `() => new Date()`. */
  now?: () => Date
}

export async function promoteAgentFilePart(options: PromoteAgentFilePartOptions): Promise<PromoteFilePartResult> {
  const maxBytes = options.maxBytes ?? PROMOTE_MAX_FILE_BYTES
  const sniffMime = options.sniffMime ?? sniffMimeFromName
  const buildAttachmentPath = options.buildAttachmentPath ?? defaultBuildAttachmentPath
  const now = options.now ?? (() => new Date())

  const filename = sanitizeAttachmentFileName(
    options.raw.filename ?? basenameFromUrl(options.raw.url) ?? 'agent-file',
  )

  const resolved = await resolveBytes({
    raw: options.raw,
    box: options.box,
    sessionId: options.sessionId,
    filename,
    maxBytes,
  })
  if (!resolved.succeeded) return { succeeded: false, filename, reason: resolved.reason }

  const mediaType = options.raw.mediaType ?? options.raw.mime ?? dataUrlMime(options.raw.url) ?? sniffMime(filename)
  const kind = attachmentKindForMime(mediaType)
  const digest = await hash8(options.raw.id ?? options.raw.url ?? filename)
  const date = now().toISOString().split('T')[0] ?? ''
  const path = buildAttachmentPath({ filename, hash8: digest, date, mediaType, kind })

  // `name` is the sanitized filename already computed above; `originalName`
  // is the pre-sanitization source name (gtm's frontmatter `originalName`) —
  // the one field sanitization would otherwise destroy with no way back.
  let written: Awaited<ReturnType<WriteAttachmentFn>>
  try {
    written = await options.writeAttachment(options.scopeId, path, resolved.bytes, {
      mediaType,
      name: filename,
      originalName: options.raw.filename ?? filename,
      size: resolved.bytes.byteLength,
    })
  } catch (err) {
    return { succeeded: false, filename, reason: err instanceof Error ? err.message : String(err) }
  }
  if (!written.ok) return { succeeded: false, filename, reason: written.reason }

  return {
    succeeded: true,
    part: {
      type: kind,
      path,
      name: filename,
      size: resolved.bytes.byteLength,
      mediaType,
    },
  }
}
