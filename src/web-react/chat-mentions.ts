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

/** A character that could plausibly continue the SAME path/filename past a
 *  matched token. Without this lookahead a mention of `@a/b.md` would match
 *  inside the unrelated `@a/b.md.bak` and split it mid-filename.
 *
 *  Unicode-aware because the wire validator (`validateSandboxMentionPath`)
 *  deliberately ALLOWS non-ASCII paths — in-box filenames are arbitrary. An
 *  ASCII-only class here would accept input the segmenter then mangles. */
const PATH_CONTINUATION_CHAR = /[\p{L}\p{N}._\-/]/u
/** A character that, immediately BEFORE an `@`, means the `@` is part of a
 *  longer token (an email local part, a handle) rather than a mention start.
 *  Unicode-aware for the same reason. */
const WORD_CHAR = /[\p{L}\p{N}]/u

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
    const prevChar = cursor > 0 ? content[cursor - 1] : undefined
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
    const nextChar = endIdx < content.length ? content[endIdx] : undefined
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
