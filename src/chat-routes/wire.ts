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
