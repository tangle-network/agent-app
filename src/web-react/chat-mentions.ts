/**
 * Transcript-side counterpart to the composer's `@`-mention primitive
 * (sandbox-ui#184). The composer serializes a picked file into the message
 * text as `@<path>`; this module is the exact inverse — it finds those tokens
 * again in a PERSISTED message and splits the text so a renderer can draw a
 * pill where the user typed one and leave the rest as prose.
 *
 * Pure and product-agnostic: no React, no fetch, no DOM. The only input beyond
 * the text is the message's OWN mention parts, so one message can never render
 * a pill for a path another message mentioned.
 *
 * `ChatMentionPart` and the runtime helpers `mentionInputToPart` /
 * `mentionPartsFromMessageParts` are re-exported here from `../chat-store/parts`
 * directly (not the `/chat-store` barrel), so a browser bundle gets the mention
 * vocabulary and its converters without importing `/chat-store`, whose barrel
 * pulls the drizzle peer.
 */

import { mentionInputToPart, mentionPartsFromMessageParts, type ChatMentionKind, type ChatMentionPart } from '../chat-store/parts'
// The `@<path>` token grammar (boundary classes + code-point readers) lives
// in `mention-boundaries.ts`, shared with the editor's pill restore and kept
// out of the public barrel — this module is barrel-exported wholesale, and
// the grammar's internals are not API.
import { charAt, charBefore, PATH_CONTINUATION_CHAR, WORD_CHAR } from './mention-boundaries'

export type { ChatMentionKind, ChatMentionPart }
export { mentionInputToPart, mentionPartsFromMessageParts }

/** One run of a segmented message: literal prose, or a matched mention with
 *  the part that produced it. `text` for a mention segment is the token as it
 *  appears in the message (`@<path>`), so a renderer that ignores `part` still
 *  reproduces the original string exactly. */
export interface MentionTextSegment {
  type: 'text' | 'mention'
  text: string
  part?: ChatMentionPart
}

/**
 * Split a message's text into plain-text and mention segments by matching
 * `@<path>` runs against that message's own mention parts.
 *
 * Only a part whose exact `@<path>` token appears in `content`, at a token
 * boundary on both sides, counts as a match; everything else — including
 * unrelated `@` text — passes through as plain text untouched. When two parts'
 * tokens both match at the same position (one path a prefix of another), the
 * LONGEST token wins, so nested-looking paths split at the right boundary.
 *
 * Returns the matched parts alongside the segments: a caller that also renders
 * a fallback chip row can drop the chip for anything now shown inline and keep
 * it only for mentions the text does not actually contain (a restored draft, a
 * queued message whose text was edited).
 */
export function segmentMentionContent(
  content: string,
  parts: ReadonlyArray<ChatMentionPart>,
): { segments: MentionTextSegment[]; matched: Set<ChatMentionPart> } {
  const matched = new Set<ChatMentionPart>()
  if (!content) return { segments: [], matched }
  if (parts.length === 0) return { segments: [{ type: 'text', text: content }], matched }

  const candidates = parts
    .map((part) => ({ part, token: `@${part.path}` }))
    .sort((a, b) => b.token.length - a.token.length)

  const segments: MentionTextSegment[] = []
  let cursor = 0
  let textStart = 0
  while (cursor < content.length) {
    if (content[cursor] !== '@') {
      cursor += 1
      continue
    }
    const prevChar = charBefore(content, cursor)
    if (prevChar && WORD_CHAR.test(prevChar)) {
      cursor += 1
      continue
    }
    const candidate = candidates.find(({ token }) => content.startsWith(token, cursor))
    if (!candidate) {
      cursor += 1
      continue
    }
    const endIdx = cursor + candidate.token.length
    const nextChar = charAt(content, endIdx)
    if (nextChar && PATH_CONTINUATION_CHAR.test(nextChar)) {
      cursor += 1
      continue
    }

    if (cursor > textStart) segments.push({ type: 'text', text: content.slice(textStart, cursor) })
    segments.push({ type: 'mention', text: candidate.token, part: candidate.part })
    matched.add(candidate.part)
    cursor = endIdx
    textStart = cursor
  }
  if (textStart < content.length) segments.push({ type: 'text', text: content.slice(textStart) })

  return { segments, matched }
}
