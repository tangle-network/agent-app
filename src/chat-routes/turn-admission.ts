/** Validated request and transcript projections at the chat-route boundary. */
import { mentionInputToPart, toChatMessageParts, type ChatMessagePart } from '../chat-store/parts'
import { normalizeClientTurnId } from '../stream/index'
import type { TurnTrace } from '../turn-trace/recorder'
import { formatServerTiming } from '../turn-trace/server-timing'
import type { ChatTurnAuthorization } from './turn-route-contracts'
import {
  assertPromptPartsWithinCap,
  ChatTurnInputError,
  parseChatTurnParts,
  parseFileMentions,
  type ChatTurnFilePartInput,
  type ChatTurnRequestPayload,
  type FileMention,
} from './wire'

/** A turn whose body parsed and whose caller `authorize` admitted. */
export type AdmittedTurn<TContext> = { parsed: ParsedTurnBody; auth: Extract<ChatTurnAuthorization<TContext>, { ok: true }>; trace: TurnTrace }

/** Emits one stage on a progress-first stream. */
export type TurnProgress = (phase: string, message: string) => void

export function errorResponse(err: ChatTurnInputError): Response {
  return Response.json({ code: err.code, error: err.message }, { status: err.status })
}

export interface ParsedTurnBody {
  payload: ChatTurnRequestPayload
  content: string
  fileParts: ChatTurnFilePartInput[]
  mentions: FileMention[]
  turnId: string | undefined
}

/**
 * The turn's admission as a `Server-Timing` value: `admission` for the
 * request-to-stream wall time, then each `admission.*` span the trace holds in
 * start order. A timed request reads where admission went from the response
 * headers alone; the same spans reach the trace sink.
 */
export function admissionServerTiming(trace: TurnTrace): string {
  const now = Date.now()
  const steps = trace.spans(now)
    .filter((span) => span.kind === 'admission')
    .sort((a, b) => a.startMs - b.startMs)
    .map((span) => ({ name: span.name, durMs: span.endMs - span.startMs }))
  return formatServerTiming([{ name: 'admission', durMs: now - trace.startedAt }, ...steps])
}

export function validateTurnBody(body: Record<string, unknown>, maxInlinePartBytes: number | undefined): ParsedTurnBody {
  const threadId = typeof body.threadId === 'string' ? body.threadId.trim() : ''
  if (!threadId) throw new ChatTurnInputError('Missing threadId')
  const rawContent = body.content ?? body.message ?? ''
  if (typeof rawContent !== 'string') throw new ChatTurnInputError('content must be a string')
  const content = rawContent.trim()
  const fileParts = parseChatTurnParts(body.parts)
  // Path references, not bytes — validated for traversal/charset/count, never
  // counted against the inline-parts byte budget below.
  const mentions = parseFileMentions(body.mentions)
  // A mention is a turn's whole payload often enough to count: "@chart.png"
  // with no prose is a real ask, and the pointer block the mentions produce is
  // prompt content the model reads.
  const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0
  if (!content && fileParts.length === 0 && mentions.length === 0 && !hasAttachments) {
    throw new ChatTurnInputError('Missing content (send text, parts, mentions, attachments, or any combination)')
  }
  assertPromptPartsWithinCap(fileParts, maxInlinePartBytes)
  let turnId: string | undefined
  try {
    turnId = normalizeClientTurnId(body.turnId)
  } catch (err) {
    throw new ChatTurnInputError(err instanceof Error ? err.message : 'Invalid turnId')
  }
  const retryAttemptId = body.retryAttemptId
  if (retryAttemptId !== undefined && (
    typeof retryAttemptId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(retryAttemptId) || !turnId
  )) throw new ChatTurnInputError('retryAttemptId requires turnId and 1–64 letters, digits, underscores, or hyphens')
  return {
    // The VALIDATED, deduped mention list replaces the raw one on the payload,
    // so every downstream seam (`authorize`, `contextGate`, `beforeTurn`,
    // `produce`) reads checked paths and never the request's own.
    payload: { ...body, threadId, content, mentions } as ChatTurnRequestPayload,
    content,
    fileParts,
    mentions,
    turnId,
  }
}

/** File parts persist onto the user message verbatim — the wire shape is the
 *  persisted `ChatFilePart`/`ChatImagePart` vocabulary already. Mentions get
 *  the one mapping step their own vocabulary needs. The typed projection is
 *  `/chat-store`'s (same boundary as the assistant hop).
 *
 *  Mentions persist as parts rather than being folded into the prompt because
 *  the prompt is not readable back: a retry rebuilds the turn from the stored
 *  row, and a transcript draws its pills from it. Turning them INTO prompt
 *  text stays the product's job — only the product knows how to resolve a
 *  workspace-relative path to an in-box one (`fileMentionsToParts`'
 *  `resolvePath` seam), so the route never dispatches them itself. */
export function userPartsWithFiles(
  userParts: Array<Record<string, unknown>>,
  fileParts: ChatTurnFilePartInput[],
  mentions: FileMention[],
): ChatMessagePart[] {
  return toChatMessageParts([
    ...userParts,
    ...fileParts.map((part) => ({ ...part })),
    ...mentions.map((mention) => ({ ...mentionInputToPart(mention) })),
  ])
}
