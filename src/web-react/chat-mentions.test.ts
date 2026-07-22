import { describe, expect, it } from 'vitest'

import { segmentMentionContent, type ChatMentionPart } from './chat-mentions'

function mentionPart(path: string, name: string): ChatMentionPart {
  return { type: 'mention', mentionKind: 'file', path, name }
}

describe('segmentMentionContent', () => {
  it('splits a matching @<path> run into its own mention segment', () => {
    const part = mentionPart('competitor-analysis/daytona.md', 'daytona.md')
    const { segments, matched } = segmentMentionContent(
      'tell me what we have inside @competitor-analysis/daytona.md',
      [part],
    )
    expect(segments).toEqual([
      { type: 'text', text: 'tell me what we have inside ' },
      { type: 'mention', text: '@competitor-analysis/daytona.md', part },
    ])
    expect(matched).toEqual(new Set([part]))
  })

  it('renders text before and after the mention normally', () => {
    const part = mentionPart('a/b.md', 'b.md')
    const { segments } = segmentMentionContent('see @a/b.md for details', [part])
    expect(segments).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'mention', text: '@a/b.md', part },
      { type: 'text', text: ' for details' },
    ])
  })

  it('picks the longest token when one path prefixes another', () => {
    const short = mentionPart('a/b', 'b')
    const long = mentionPart('a/b.md', 'b.md')
    const { segments, matched } = segmentMentionContent('open @a/b.md now', [short, long])
    expect(segments).toEqual([
      { type: 'text', text: 'open ' },
      { type: 'mention', text: '@a/b.md', part: long },
      { type: 'text', text: ' now' },
    ])
    expect(matched).toEqual(new Set([long]))
  })

  it('leaves unrelated @ text untouched when no part matches', () => {
    const part = mentionPart('a/b.md', 'b.md')
    const content = 'ping @someone about it, no @a/c.md here'
    const { segments, matched } = segmentMentionContent(content, [part])
    expect(segments).toEqual([{ type: 'text', text: content }])
    expect(matched.size).toBe(0)
  })

  it('does not let a shorter known path swallow a longer unrelated run', () => {
    const part = mentionPart('a/b.md', 'b.md')
    const { segments, matched } = segmentMentionContent('see @a/b.md.bak instead', [part])
    expect(segments).toEqual([{ type: 'text', text: 'see @a/b.md.bak instead' }])
    expect(matched.size).toBe(0)
  })

  it('does not match a path embedded mid-word', () => {
    const part = mentionPart('a/b.md', 'b.md')
    const { segments, matched } = segmentMentionContent('foo@a/b.md bar', [part])
    expect(segments).toEqual([{ type: 'text', text: 'foo@a/b.md bar' }])
    expect(matched.size).toBe(0)
  })

  it('matches every occurrence and reports only the parts actually found', () => {
    const found = mentionPart('a/b.md', 'b.md')
    const missing = mentionPart('a/c.md', 'c.md')
    const { segments, matched } = segmentMentionContent('@a/b.md and @a/b.md again', [found, missing])
    expect(segments).toEqual([
      { type: 'mention', text: '@a/b.md', part: found },
      { type: 'text', text: ' and ' },
      { type: 'mention', text: '@a/b.md', part: found },
      { type: 'text', text: ' again' },
    ])
    expect(matched).toEqual(new Set([found]))
  })

  it('reproduces the original string when the segments are concatenated', () => {
    const part = mentionPart('a/b.md', 'b.md')
    const content = 'read @a/b.md then @a/b.md, thanks'
    const { segments } = segmentMentionContent(content, [part])
    expect(segments.map((segment) => segment.text).join('')).toBe(content)
  })

  it('passes empty content and empty parts through as empty', () => {
    expect(segmentMentionContent('', [mentionPart('a/b.md', 'b.md')])).toEqual({
      segments: [],
      matched: new Set(),
    })
    expect(segmentMentionContent('hello world', [])).toEqual({
      segments: [{ type: 'text', text: 'hello world' }],
      matched: new Set(),
    })
  })
})
