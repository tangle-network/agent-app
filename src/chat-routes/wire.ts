/**
 * Wire contract between the chat client (composer + `streamChatTurn`) and the
 * assembled server vertical (`createChatTurnRoutes`). Import-free on purpose:
 * `/web-react` re-exports these types into browser bundles, so nothing here may
 * reach a Node builtin or an engine package.
 *
 * The part shape mirrors the sandbox SDK's `PromptInputPart` structurally
 * (text | image | file with filename/mediaType/url/path/content) — derived
 * here, not imported, so the client bundle never touches the SDK.
 */

export interface ChatTurnTextPartInput {
  type: 'text'
  text: string
}

/** A non-text prompt part the upload route hands back and the client echoes
 *  on send. `url` carries an inline `data:` URI for small files; `path` is a
 *  sandbox workspace reference for large ones (the >1 MiB gateway body cap
 *  makes the two-step upload mandatory). */
export interface ChatTurnFilePartInput {
  type: 'image' | 'file'
  filename?: string
  mediaType?: string
  url?: string
  path?: string
  content?: string
}

/** Resolve input as either a text part or a file part of a chat turn */
export type ChatTurnPartInput = ChatTurnTextPartInput | ChatTurnFilePartInput

// ── producer stream vocabulary ───────────────────────────────────────────────

/** Represent a text event produced by a source with a fixed type and associated text content */
export interface ProducerTextEvent {
  type: 'text'
  text: string
}

/** Define an event representing reasoning output with a fixed type and associated text */
export interface ProducerReasoningEvent {
  type: 'reasoning'
  text: string
}

/** Represent an event triggered by a producer tool call with its identifier, name, and arguments */
export interface ProducerToolCallEvent {
  type: 'tool_call'
  call: {
    toolCallId: string
    toolName: string
    args: Record<string, unknown>
  }
}

/** Describe the structure of an event representing the result of a producer tool call */
export interface ProducerToolResultEvent {
  type: 'tool_result'
  toolCallId: string
  toolName: string
  outcome: {
    ok: boolean
    result?: unknown
    message?: string
  }
}

/** Describe usage event with prompt and completion token counts for a producer */
export interface ProducerUsageEvent {
  type: 'usage'
  usage: {
    promptTokens: number
    completionTokens: number
  }
}

/** Define the structure for a producer notice event with type, id, kind, and text fields */
export interface ProducerNoticeEvent {
  type: 'notice'
  id: string
  /** Kept inline with `/interactions`' `NoticeKind` so this file stays import-free. */
  noticeKind: 'warning' | 'auto-declined'
  text: string
}

/** Represent an error event emitted by a producer containing message, code, and optional details */
export interface ProducerErrorEvent {
  type: 'error'
  data: {
    message: string
    code?: string
    details?: Record<string, unknown>
  }
}

/** Stable raw lifecycle/interaction/plan/route events forwarded unchanged. */
export type ProducerPassthroughEventType =
  | 'turn'
  | 'metadata'
  | 'interaction'
  | 'interaction.cancel'
  | 'plan.submitted'
  | 'done'
  | 'warning'
  | 'session.run.started'
  | 'session.run.completed'
  | 'session.run.failed'
  | 'turn_status'

/** Define an event carrying passthrough data with flexible properties for producer communication */
export interface ProducerPassthroughEvent {
  type: ProducerPassthroughEventType
  data?: Record<string, unknown>
  /** Route markers and raw passthroughs may carry `turnId`, `status`, `seq`, etc. */
  [key: string]: unknown
}

/** Represent events emitted by a producer during its operation for processing and handling */
export type ProducerWireEvent =
  | ProducerTextEvent
  | ProducerReasoningEvent
  | ProducerToolCallEvent
  | ProducerToolResultEvent
  | ProducerUsageEvent
  | ProducerNoticeEvent
  | ProducerErrorEvent
  | ProducerPassthroughEvent

/** The image/file split an attachment is rendered and persisted under — the
 *  same discriminant as {@link ChatMentionKind}, but a distinct name because an
 *  attachment carries content the product uploaded (`ChatAttachmentInput`)
 *  while a mention points at a file the box already has. Defined HERE (the
 *  import-free layer) so `ChatAttachmentInput` can reference it and the client
 *  composer imports it without pulling the persisted-part vocabulary;
 *  `/chat-store`'s parts module re-exports it alongside the attachment helpers. */
export type ChatAttachmentKind = 'image' | 'file'

/** `POST` turn-body entry describing a file already uploaded to the product's
 *  store (vault/object-store) — distinct from an inline {@link
 *  ChatTurnFilePartInput} (which carries bytes) and from a {@link FileMention}
 *  (a sandbox path the box already holds). The route resolves this field with
 *  {@link resolveChatAttachments}: every path is re-validated and every size is
 *  re-derived from the stored body, so nothing here is trusted as sent. */
export interface ChatAttachmentInput {
  path: string
  name: string
  size: number
  mediaType: string
  kind: ChatAttachmentKind
}

/** POST body for the turn route. `content` may be empty when `parts` carry the
 *  message (an image-only send). Product routing fields (workspaceId etc.) ride
 *  alongside and are read by the product's `authorize` seam. */
export interface ChatTurnRequestPayload {
  threadId: string
  content?: string
  /** Non-text parts from the upload route, echoed back verbatim. */
  parts?: ChatTurnFilePartInput[]
  /** `@`-picked file mentions for this turn — path references into the
   *  workspace sandbox, NOT uploads, so they travel in their own field rather
   *  than as `parts` entries. A product whose `parts` field is already spoken
   *  for (an attachment sentinel) can still send mentions, and mentions
   *  persist as their own `ChatMentionPart`s so a retry rebuilds them. The
   *  route validates this field with {@link parseFileMentions} and replaces it
   *  on the payload with the validated, deduped list. */
  mentions?: FileMention[]
  /** Files uploaded to the product's store ahead of the turn — path
   *  references, NOT inline bytes (those ride `parts`). Validated and
   *  size-re-derived by {@link resolveChatAttachments} into persistable
   *  attachment parts; a product whose `parts` field is spoken for by inline
   *  uploads still sends store-backed files here. */
  attachments?: ChatAttachmentInput[]
  model?: string
  effort?: 'auto' | 'low' | 'medium' | 'high'
  harness?: string
  /** Client-generated idempotency key for the logical turn (retry-safe). */
  turnId?: string
  [key: string]: unknown
}

/** `fetch` init for the turn route — the one place the client wire shape is
 *  serialized, so composer glue and products never drift from the server's
 *  parser. */
export function chatTurnRequestInit(payload: ChatTurnRequestPayload): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }
}

// ── inline-part byte budget ─────────────────────────────────────────────────
//
// The sandbox gateway caps request bodies at 1 MiB; a turn body whose inline
// `data:` parts exceed it dies at the gateway with an opaque 413. Enforce the
// budget at the route boundary instead, with headroom for the JSON envelope
// (same fail-loud-at-the-choke-point style as /sandbox's provision-payload and
// env-size gates).

/** Define the maximum byte size allowed for inline parts in data processing */
export const INLINE_PARTS_MAX_BYTES = 950_000

// ── dispatch (parts[]) budget vocabulary ────────────────────────────────────
//
// The default caps `buildDispatchParts` sizes an attachment/mention dispatch
// against — the sidecar/proxy limits an assembled `parts` array crosses, one
// step past `INLINE_PARTS_MAX_BYTES` (which gates the raw turn BODY). Grouped
// here, in the import-free layer, so the numbers are one overridable
// vocabulary the client can read and a product can tune per call rather than
// constants buried in the server module. NOTE: these model sidecar/proxy caps,
// not a product's MIME accept-list or vault bucketing — those are DOMAIN
// values the product supplies, never defaulted here.

/** Hard cap on the whole `/prompt` request body as it crosses the sandbox
 *  proxy — smaller in practice than a raw-file write cap because a dispatch
 *  carries several inline parts plus the flattened history in one request. */
export const DISPATCH_REQUEST_MAX_BYTES = 1024 * 1024

/** Bytes reserved off the top of {@link DISPATCH_REQUEST_MAX_BYTES} for the
 *  JSON structure around the parts array (keys, delimiters, per-part
 *  `type`/`filename`/`mediaType` fields) that {@link base64WireLen} does not
 *  account for — keeps the inline budget off the exact proxy cap where one
 *  stray byte trips the 413. */
export const DISPATCH_STRUCTURAL_RESERVE_BYTES = 64 * 1024

/** Sidecar's hard cap on the `parts` array of one prompt request — a dispatch
 *  must never assemble more parts than this or the whole turn 400s. */
export const DISPATCH_MAX_PARTS = 64

/** Product-side cap on media parts per dispatch (current turn + carried
 *  history), well under {@link DISPATCH_MAX_PARTS}. History trimming that keeps
 *  a transcript's native media under this is a PRODUCT concern (the pointer
 *  block keeps trimmed media reachable); `buildDispatchParts` enforces only the
 *  total {@link DISPATCH_MAX_PARTS} cap. */
export const DISPATCH_MAX_MEDIA_PARTS = 24

/** Size a base64-encoded string occupies on the wire given the raw
 *  (pre-encoding) byte length: base64 packs 3 raw bytes into 4 output
 *  characters, rounded up to the next multiple of 4. */
export function base64WireLen(byteLen: number): number {
  return Math.ceil(byteLen / 3) * 4
}

/**
 * Render a raw byte count as a human-readable size (`512B`, `3KB`, `12MB
 * 500KB`). Ported EXACTLY from gtm-agent's `attachment-limits.ts` — byte-
 * identical implementation, not a reinterpretation — so `resolve-attachments`'s
 * and `promote-file-part`'s error strings match gtm's wording verbatim. Lives
 * in the import-free wire layer (not `resolve-attachments.ts` alone) because
 * BOTH the aggregate-cap message here and the per-file oversize message in
 * `promote-file-part.ts` need it; a browser composer wanting the same
 * formatting for a client-side pre-check can also import it with no engine
 * pulled in.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes >= 1024 * 1024) {
    const megabytes = Math.floor(bytes / (1024 * 1024))
    const remainder = bytes % (1024 * 1024)
    return remainder === 0 ? `${megabytes}MB` : `${megabytes}MB ${formatBytes(remainder)}`
  }
  return `${Math.round(bytes / 1024)}KB`
}

/** Represent errors for invalid chat turn inputs with status and code properties */
export class ChatTurnInputError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'INVALID_CHAT_TURN') {
    super(message)
    this.name = 'ChatTurnInputError'
  }
}

function partByteSize(part: ChatTurnPartInput): number {
  let bytes = 0
  if (part.type === 'text') return part.text.length
  if (part.url) bytes += part.url.length
  if (part.content) bytes += part.content.length
  if (part.path) bytes += part.path.length
  return bytes
}

/** Calculate the total byte size of an array of chat turn parts */
export function promptPartsByteSize(parts: ChatTurnPartInput[]): number {
  return parts.reduce((total, part) => total + partByteSize(part), 0)
}

/** Throws `ChatTurnInputError` (413) when the parts' inline payload would blow
 *  the gateway cap. Path-ref parts are tiny by construction and always pass. */
export function assertPromptPartsWithinCap(
  parts: ChatTurnPartInput[],
  maxBytes = INLINE_PARTS_MAX_BYTES,
): void {
  const total = promptPartsByteSize(parts)
  if (total <= maxBytes) return
  const largest = [...parts].sort((a, b) => partByteSize(b) - partByteSize(a))[0]
  const largestName = largest && largest.type !== 'text' ? largest.filename ?? largest.path ?? largest.type : 'text'
  throw new ChatTurnInputError(
    `Inline prompt parts total ${total}B, over the ${maxBytes}B budget (largest: ${largestName}, ${largest ? partByteSize(largest) : 0}B). ` +
      'Upload large files through the upload route so they travel as sandbox path references.',
    413,
    'PROMPT_PARTS_TOO_LARGE',
  )
}

// ── file mentions ────────────────────────────────────────────────────────
//
// A file mention (`@`-picked in the composer, sandbox-ui#184) is a path
// reference into the workspace sandbox — no byte upload. These helpers turn
// a resolved mention list into wire parts and the prompt pointer block that
// tells the agent where to read them from.

/** A file mention resolved from the composer's `@`-picker: the
 *  workspace-relative path plus enough metadata to build a prompt part and
 *  pointer text. `path` is the canonical identity — the mention pill's
 *  `MentionItem.id` for the file kind (`/web-react`'s `useFileMentions`). */
export interface FileMention {
  path: string
  name: string
  size?: number
}

const MENTION_IMAGE_MEDIA_TYPES: ReadonlyMap<string, string> = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.bmp', 'image/bmp'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
  ['.avif', 'image/avif'],
])

function extensionOf(path: string): string {
  const base = path.split('/').filter(Boolean).pop() ?? path
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : ''
}

/** The `image/*` mime for a mention path by extension, or `undefined` for
 *  anything not in the known image set (dispatched as `type: 'file'`). */
export function mediaTypeForMentionPath(path: string): string | undefined {
  return MENTION_IMAGE_MEDIA_TYPES.get(extensionOf(path))
}

/** The image/file split a mention is rendered and persisted under — the
 *  composer pill's icon, the dispatched part's `type`, and
 *  `ChatMentionPart.mentionKind` are all this one value. */
export type ChatMentionKind = 'image' | 'file'

/** `image` when the path's extension is in the known image set (the same table
 *  {@link mediaTypeForMentionPath} reads), `file` otherwise. Exported so a
 *  client that needs only the discriminant — a pill icon, a persisted part's
 *  `mentionKind` — never re-declares the extension table; two frozen copies of
 *  one mime table is how one gains a format and the other doesn't. */
export function mentionKindForPath(path: string): ChatMentionKind {
  return mediaTypeForMentionPath(path) ? 'image' : 'file'
}

/** Define options to resolve mention paths when converting file mentions to parts */
export interface FileMentionsToPartsOptions {
  /** Resolve a mention's workspace-relative path to the absolute path the
   *  dispatched part should carry (e.g. a host prefixing the in-box vault
   *  root). Default: identity — the path travels unchanged. */
  resolvePath?: (path: string) => string
}

/** Maps resolved file mentions to path-only `ChatTurnFilePartInput`s —
 *  `image` vs `file` by extension, and always a `path`, never a `url` (the
 *  url/path XOR invariant: a mention is a sandbox path reference, never
 *  inline bytes). */
export function fileMentionsToParts(
  mentions: readonly FileMention[],
  opts: FileMentionsToPartsOptions = {},
): ChatTurnFilePartInput[] {
  const resolvePath = opts.resolvePath ?? ((path: string) => path)
  return mentions.map((mention) => {
    const mediaType = mediaTypeForMentionPath(mention.path)
    const part: ChatTurnFilePartInput = {
      type: mediaType ? 'image' : 'file',
      filename: mention.name,
      path: resolvePath(mention.path),
    }
    if (mediaType) part.mediaType = mediaType
    return part
  })
}

/** The agent-facing pointer block appended to the dispatched prompt — never
 *  persisted in message `content`. Empty array → `''` so callers can append
 *  unconditionally. This is the sole producer of that text: the current
 *  turn's dispatch and any history projection built from the same mention
 *  list both route through here, so the two can't drift apart. */
export function buildMentionPromptBlock(
  mentions: readonly Pick<FileMention, 'name' | 'path'>[],
): string {
  if (mentions.length === 0) return ''
  const lines = mentions.map((m) => `- ${m.name} (${m.path})`)
  return `\n\nMentioned files — read them from these paths:\n${lines.join('\n')}`
}

// ── mention validation ───────────────────────────────────────────────────
//
// This package owns BOTH ends of the mention path contract — it emits paths
// from `createSandboxFileIndexRoute` and consumes them in `fileMentionsToParts`
// / `buildMentionPromptBlock` — so the validation belongs here rather than in
// each app that wires the pair up. A mention names a file that already exists
// in the sandbox, so validation is a pure path/charset/count check with no
// I/O: existence is proven later, when the agent reads the path and the turn
// fails loudly if it is gone.

/** Hard cap on mentions per turn. Bounds the prompt pointer block, the
 *  persisted parts, and whatever media budget a dispatch draws from them. */
export const MENTION_MAX_COUNT = 16

/** Longest mention display name accepted — bounds the pointer-block text and
 *  the transcript pill label. */
const MAX_MENTION_NAME_LENGTH = 256
/** Longest mention path accepted. */
const MAX_MENTION_PATH_LENGTH = 1024

/** Represent the result of a sandbox mention path check indicating success or failure with an error message */
export type SandboxMentionPathCheck =
  | { succeeded: true }
  | { succeeded: false; error: string }

/**
 * Validate a workspace-relative sandbox mention path. Rejects traversal (a
 * `..` path segment), absolute paths (leading `/`), backslashes, and null
 * bytes — the four ways a path picked in a client can escape the root the
 * index route scanned.
 *
 * Spaces and unicode are deliberately ALLOWED: in-box filenames are arbitrary,
 * and an ASCII-only charset would silently drop real files from a feature
 * whose whole job is naming them.
 */
export function validateSandboxMentionPath(path: unknown): SandboxMentionPathCheck {
  if (typeof path !== 'string' || path.length === 0) {
    return { succeeded: false, error: 'mention path must be a non-empty string' }
  }
  if (path.length > MAX_MENTION_PATH_LENGTH) {
    return { succeeded: false, error: `mention path must not exceed ${MAX_MENTION_PATH_LENGTH} characters` }
  }
  if (path.includes('\0')) {
    return { succeeded: false, error: 'mention path must not contain null bytes' }
  }
  if (path.includes('\\')) {
    return { succeeded: false, error: 'mention path must not contain backslashes' }
  }
  if (path.startsWith('/')) {
    return { succeeded: false, error: 'mention path must be workspace-relative, not absolute' }
  }
  if (path.split('/').some((segment) => segment === '..')) {
    return { succeeded: false, error: 'mention path must not contain ".." segments' }
  }
  return { succeeded: true }
}

function parseFileMention(value: unknown, index: number): FileMention {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChatTurnInputError(`mentions[${index}] must be an object`)
  }
  const record = value as Record<string, unknown>

  const pathCheck = validateSandboxMentionPath(record.path)
  if (!pathCheck.succeeded) throw new ChatTurnInputError(`mentions[${index}]: ${pathCheck.error}`)

  const name = record.name
  if (typeof name !== 'string' || !name.trim()) {
    throw new ChatTurnInputError(`mentions[${index}].name must be a non-empty string`)
  }
  if (name.length > MAX_MENTION_NAME_LENGTH) {
    throw new ChatTurnInputError(`mentions[${index}].name must not exceed ${MAX_MENTION_NAME_LENGTH} characters`)
  }

  const size = record.size
  if (size !== undefined) {
    if (typeof size !== 'number' || !Number.isFinite(size)) {
      throw new ChatTurnInputError(`mentions[${index}].size must be a finite number`)
    }
    if (size < 0) {
      throw new ChatTurnInputError(`mentions[${index}].size must not be negative`)
    }
  }

  return { path: record.path as string, name, ...(typeof size === 'number' ? { size } : {}) }
}

/**
 * Validates the untyped `mentions` array off the wire, mirroring
 * {@link parseChatTurnParts}: the typed list, or `ChatTurnInputError` (400)
 * naming the offending entry. Never sanitizes-and-continues — a traversal path
 * is a rejected request, not a trimmed one.
 *
 * A path repeated within one turn is deduped to its first occurrence rather
 * than rejected: mentioning the same file twice is plausible user input, not
 * an attack.
 */
export function parseFileMentions(raw: unknown): FileMention[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new ChatTurnInputError('mentions must be an array')
  if (raw.length > MENTION_MAX_COUNT) {
    throw new ChatTurnInputError(`mentions must not exceed ${MENTION_MAX_COUNT} entries`)
  }

  const mentions: FileMention[] = []
  const seenPaths = new Set<string>()
  for (let index = 0; index < raw.length; index += 1) {
    const mention = parseFileMention(raw[index], index)
    if (seenPaths.has(mention.path)) continue
    seenPaths.add(mention.path)
    mentions.push(mention)
  }
  return mentions
}

/** Validates the untyped `parts` array off the wire. Returns the typed parts
 *  or throws `ChatTurnInputError` (400) naming the offending entry. */
export function parseChatTurnParts(raw: unknown): ChatTurnFilePartInput[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new ChatTurnInputError('parts must be an array')
  return raw.map((entry, index) => {
    const part = entry as Record<string, unknown> | null
    if (!part || typeof part !== 'object') {
      throw new ChatTurnInputError(`parts[${index}] must be an object`)
    }
    if (part.type !== 'image' && part.type !== 'file') {
      throw new ChatTurnInputError(`parts[${index}].type must be 'image' or 'file'`)
    }
    for (const key of ['filename', 'mediaType', 'url', 'path', 'content'] as const) {
      if (part[key] !== undefined && typeof part[key] !== 'string') {
        throw new ChatTurnInputError(`parts[${index}].${key} must be a string`)
      }
    }
    if (!part.url && !part.path && !part.content) {
      throw new ChatTurnInputError(`parts[${index}] needs a url, path, or content`)
    }
    return {
      type: part.type,
      ...(part.filename !== undefined ? { filename: part.filename as string } : {}),
      ...(part.mediaType !== undefined ? { mediaType: part.mediaType as string } : {}),
      ...(part.url !== undefined ? { url: part.url as string } : {}),
      ...(part.path !== undefined ? { path: part.path as string } : {}),
      ...(part.content !== undefined ? { content: part.content as string } : {}),
    }
  })
}
