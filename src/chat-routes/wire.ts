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

export type ChatTurnPartInput = ChatTurnTextPartInput | ChatTurnFilePartInput

/** POST body for the turn route. `content` may be empty when `parts` carry the
 *  message (an image-only send). Product routing fields (workspaceId etc.) ride
 *  alongside and are read by the product's `authorize` seam. */
export interface ChatTurnRequestPayload {
  threadId: string
  content?: string
  /** Non-text parts from the upload route, echoed back verbatim. */
  parts?: ChatTurnFilePartInput[]
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

export const INLINE_PARTS_MAX_BYTES = 950_000

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
