import { describe, expect, it } from 'vitest'

import type { MentionItem } from './use-file-mentions'
import {
  collectMentions,
  parseMentionValue,
  serializeMentionDoc,
  type MentionDocNode,
} from './mention-serialize'

function known(...items: MentionItem[]): Map<string, MentionItem> {
  return new Map(items.map((item) => [item.id, item]))
}

const FILE: MentionItem = {
  id: 'src/app.tsx',
  label: 'app.tsx',
  kind: 'file',
}

describe('mention serialization', () => {
  it('serializes mention nodes as @<id> and paragraphs as newlines', () => {
    const doc: MentionDocNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'look at ' },
            { type: 'mention', attrs: { id: 'src/app.tsx', label: 'app.tsx' } },
            { type: 'text', text: ' now' },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'line two' }] },
      ],
    }
    expect(serializeMentionDoc(doc)).toBe('look at @src/app.tsx now\nline two')
  })

  it('serializes a hard break as a newline within a paragraph', () => {
    const doc: MentionDocNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a' },
            { type: 'hardBreak' },
            { type: 'text', text: 'b' },
          ],
        },
      ],
    }
    expect(serializeMentionDoc(doc)).toBe('a\nb')
  })

  it('restores pills for known @<id> runs and leaves unknown ones as text', () => {
    const doc = parseMentionValue('hi @src/app.tsx and @unknown/file.ts end', known(FILE))
    expect(serializeMentionDoc(doc)).toBe('hi @src/app.tsx and @unknown/file.ts end')
    const mentions = collectMentions(doc)
    expect(mentions).toEqual([{ id: 'src/app.tsx', label: 'app.tsx', kind: 'file' }])
  })

  it('round-trips a serialized value back to the same string', () => {
    const value = 'see @src/app.tsx here'
    const doc = parseMentionValue(value, known(FILE))
    expect(serializeMentionDoc(doc)).toBe(value)
  })

  it('prefers the longest known id and respects a whitespace boundary', () => {
    const shorter: MentionItem = { id: 'src/app', label: 'app' }
    const longer: MentionItem = { id: 'src/app.tsx', label: 'app.tsx' }

    const exact = parseMentionValue('@src/app.tsx', known(shorter, longer))
    expect(collectMentions(exact).map((m) => m.id)).toEqual(['src/app.tsx'])

    // Only the shorter id is known — the longer typed path is not a boundary
    // match, so nothing is turned into a pill.
    const noBoundary = parseMentionValue('@src/app.tsx', known(shorter))
    expect(collectMentions(noBoundary)).toHaveLength(0)
    expect(serializeMentionDoc(noBoundary)).toBe('@src/app.tsx')
  })
})
