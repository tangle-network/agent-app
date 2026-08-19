/**
 * Round-trip between the mention editor's document and the composer's plain
 * `value` string. A mention node serializes to `@<id>`; parsing restores a
 * pill only for ids the session already knows (fetched, inserted, or
 * restored), so unknown `@…` runs stay literal text.
 *
 * The document shape is kept structural (no TipTap import) so this round-trip
 * is unit-testable on its own and never pulls the editor chunk into a bundle.
 */

import { charAt, charBefore, PATH_CONTINUATION_CHAR, WORD_CHAR } from './chat-mentions'
import type { MentionItem } from './use-file-mentions'

/**
 * The subset of a TipTap/ProseMirror JSON document the mention editor
 * produces: a `doc` of paragraphs, each holding text, hard breaks, and atomic
 * mention nodes.
 */
export interface MentionDocNode {
  type: string
  text?: string
  attrs?: { id?: string | null; label?: string | null; kind?: string | null }
  content?: MentionDocNode[]
}

const MENTION_TYPE = 'mention'

/**
 * Plain-text serialization of the editor document. Paragraphs join with a
 * newline, hard breaks become a newline, and a mention node becomes `@<id>` —
 * the stable text form the controlled `value` carries.
 */
export function serializeMentionDoc(doc: MentionDocNode): string {
  return (doc.content ?? []).map(serializeBlock).join('\n')
}

function serializeBlock(node: MentionDocNode): string {
  if (node.type === 'paragraph') {
    return (node.content ?? []).map(serializeInline).join('')
  }
  return ''
}

function serializeInline(node: MentionDocNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  if (node.type === MENTION_TYPE) return `@${node.attrs?.id ?? ''}`
  return ''
}

/** Every mention node in the document, in order, as `MentionItem`s. */
export function collectMentions(doc: MentionDocNode): MentionItem[] {
  const out: MentionItem[] = []
  const walk = (node: MentionDocNode) => {
    if (node.type === MENTION_TYPE && node.attrs?.id) {
      out.push({
        id: node.attrs.id,
        label: node.attrs.label ?? node.attrs.id,
        kind: node.attrs.kind ?? undefined,
      })
    }
    for (const child of node.content ?? []) walk(child)
  }
  walk(doc)
  return out
}

/**
 * Parse a controlled `value` string back into an editor document. `@<id>`
 * runs that match a currently-known mention restore as atomic mention nodes;
 * every other `@…` stays literal text. Each line becomes a paragraph — a
 * deliberate asymmetry with `serializeMentionDoc`, which also flattens an
 * in-paragraph `hardBreak` to `\n`: the string round-trips byte-identically,
 * but a restored Shift+Enter comes back as a paragraph break. The two render
 * identically under the composer's styling (no paragraph margins), so the
 * plain-text `value` contract stays the source of truth.
 */
export function parseMentionValue(
  value: string,
  known: Map<string, MentionItem>,
): MentionDocNode {
  const lines = value.split('\n')
  return {
    type: 'doc',
    content: lines.map((line) => ({
      type: 'paragraph',
      content: parseLine(line, known),
    })),
  }
}

function parseLine(line: string, known: Map<string, MentionItem>): MentionDocNode[] {
  const content: MentionDocNode[] = []
  let text = ''
  const flush = () => {
    if (text) {
      content.push({ type: 'text', text })
      text = ''
    }
  }

  let i = 0
  while (i < line.length) {
    // A word character right before the `@` means it is part of a longer
    // token (an email local part, a handle), never a mention start — the
    // same rule the transcript segmenter applies to persisted messages.
    // Read as a full code point: an astral letter's low surrogate would
    // fail WORD_CHAR and let an embedded `@` start a mention.
    const before = charBefore(line, i)
    const partOfLongerToken = before !== undefined && WORD_CHAR.test(before)
    if (line[i] === '@' && !partOfLongerToken) {
      const id = matchKnownId(line, i + 1, known)
      if (id) {
        const item = known.get(id)!
        flush()
        content.push({
          type: MENTION_TYPE,
          attrs: {
            id: item.id,
            label: item.label,
            kind: item.kind ?? null,
          },
        })
        i += 1 + id.length
        continue
      }
    }
    text += line[i]
    i += 1
  }
  flush()
  return content
}

/**
 * The longest known id that starts at `pos` and ends on a boundary: end of
 * line, or any full character (never a lone surrogate) that could not
 * continue the same path — the transcript segmenter's rule, so `@a.tsx,`
 * restores its pill while `@a.tsx.bak` never matches the shorter `a.tsx`
 * mid-filename. The scan is linear in `known.size` per `@` run on purpose:
 * `known` holds only the ids PICKED this session (a handful), never the
 * file index, so an index structure would buy nothing.
 */
function matchKnownId(
  line: string,
  pos: number,
  known: Map<string, MentionItem>,
): string | null {
  let best: string | null = null
  for (const id of known.keys()) {
    if (id.length === 0) continue
    if (best !== null && id.length <= best.length) continue
    if (!line.startsWith(id, pos)) continue
    const next = charAt(line, pos + id.length)
    if (next !== undefined && PATH_CONTINUATION_CHAR.test(next)) continue
    best = id
  }
  return best
}
