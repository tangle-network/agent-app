/**
 * Round-trip between the mention editor's document and the composer's plain
 * `value` string. A mention node serializes to `@<id>`; parsing restores a
 * pill only for ids the session already knows (fetched, inserted, or
 * restored), so unknown `@…` runs stay literal text.
 *
 * The document shape is kept structural (no TipTap import) so this round-trip
 * is unit-testable on its own and never pulls the editor chunk into a bundle.
 */

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
 * every other `@…` stays literal text. Each line becomes a paragraph.
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
    if (line[i] === '@') {
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
 * The longest known id that starts at `pos` and ends on a boundary (end of
 * line or whitespace) — mentions serialize with a trailing space, so a bare
 * prefix of a longer path never matches by accident.
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
    const after = pos + id.length
    if (after < line.length && !/\s/.test(line[after]!)) continue
    best = id
  }
  return best
}
