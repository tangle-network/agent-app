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

  it('restores a pill when ordinary punctuation follows the id', () => {
    // Same boundary vocabulary as the transcript segmenter: any character
    // that could not continue a path ends the token.
    for (const value of ['see @src/app.tsx, please', '(@src/app.tsx)', 'ok @src/app.tsx?']) {
      const doc = parseMentionValue(value, known(FILE))
      expect(collectMentions(doc).map((m) => m.id), value).toEqual(['src/app.tsx'])
      expect(serializeMentionDoc(doc)).toBe(value)
    }
  })

  it('keeps a trailing period literal — a dot continues filenames', () => {
    // `.` is a path-continuation character (`app.tsx.bak`), so a sentence
    // ending right at the id cannot be told apart from a longer filename.
    const doc = parseMentionValue('see @src/app.tsx.', known(FILE))
    expect(collectMentions(doc)).toHaveLength(0)
    expect(serializeMentionDoc(doc)).toBe('see @src/app.tsx.')
  })

  it('never starts a mention inside a longer token (email local parts)', () => {
    const doc = parseMentionValue('mail user@src/app.tsx today', known(FILE))
    expect(collectMentions(doc)).toHaveLength(0)
    expect(serializeMentionDoc(doc)).toBe('mail user@src/app.tsx today')
  })

  it('reads boundaries as full characters, not UTF-16 code units', () => {
    // 𝐀/𝐁 are astral letters — a code-unit read hands the classes a lone
    // surrogate, which fails `\p{L}` and flips both boundary verdicts.
    const before = parseMentionValue('𝐀@src/app.tsx', known(FILE))
    expect(collectMentions(before)).toHaveLength(0)

    const after = parseMentionValue('@src/app.tsx𝐁', known(FILE))
    expect(collectMentions(after)).toHaveLength(0)
  })

  it('resolves space-grouping ambiguity by the longest known id — the documented rule', () => {
    // `@my file.ts` cannot distinguish a `my` mention followed by prose from
    // a `my file.ts` mention; the plain-text contract resolves to the
    // longest known id, the same rule the transcript segmenter applies.
    const doc = parseMentionValue(
      '@my file.ts',
      known({ id: 'my', label: 'my' }, { id: 'my file.ts', label: 'my file.ts' }),
    )
    expect(collectMentions(doc).map((m) => m.id)).toEqual(['my file.ts'])
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
