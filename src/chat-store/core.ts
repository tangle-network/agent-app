/**
 * Pure (drizzle-free) pieces of the chat store: thread-title derivation, the
 * bulk-delete bound, message-write contract, and typed input error. Split from
 * `./schema`/`./store`
 * so the root barrel can re-export them without dragging the optional
 * drizzle-orm peer into every root-entry consumer.
 */

import type { ChatMessagePart } from './parts'

/** Bounds a single bulk-delete request's write set; product surfaces cap
 *  thread lists at far fewer, so a larger batch is a malformed or hostile
 *  request. (Lifted from legal's api.threads.bulk-delete route.) */
export const BULK_DELETE_MAX_THREADS = 200

/** Invalid caller input (missing/oversized ids, empty title). Products map it
 *  to a 400; anything else out of the store is a real failure. */
export class ChatStoreInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatStoreInputError'
  }
}

/** Thread titles come from the first message — keep the list scannable by
 *  storing only its first non-empty line, capped at 80 chars, never the whole
 *  multi-page prompt. (Lifted verbatim from legal's chat.new route.) */
export function threadTitleFromMessage(message: string): string {
  const firstLine = message.split('\n').find((l) => l.trim().length > 0)?.trim() ?? ''
  if (!firstLine) return 'New Thread'
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine
}

/** Stored message body, model attribution and usage shared by append and patch adapters. */
export type ChatMessageValues = {
  content: string
  parts?: ChatMessagePart[]
  model?: string | null
  requestedModel?: string | null
  servedModel?: string | null
  servedProvider?: string | null
  servedSource?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  reasoningTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  costUsd?: number | null
}
