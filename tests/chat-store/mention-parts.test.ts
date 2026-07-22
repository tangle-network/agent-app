import { describe, expect, it } from 'vitest'

import {
  isChatMentionPart,
  mentionInputToPart,
  mentionPartsFromMessageParts,
  toChatMessageParts,
  type ChatMentionPart,
  type ChatMessagePart,
} from '../../src/chat-store/parts'

describe('mentionInputToPart', () => {
  it('derives the image/file kind from the path extension', () => {
    expect(mentionInputToPart({ path: 'assets/logo.PNG', name: 'logo.PNG' })).toEqual({
      type: 'mention',
      mentionKind: 'image',
      path: 'assets/logo.PNG',
      name: 'logo.PNG',
    })
    expect(mentionInputToPart({ path: 'docs/notes.md', name: 'notes.md' }).mentionKind).toBe('file')
  })

  it('keeps a finite size and DROPS an absent or non-finite one', () => {
    expect(mentionInputToPart({ path: 'a.md', name: 'a.md', size: 0 })).toHaveProperty('size', 0)
    expect(mentionInputToPart({ path: 'a.md', name: 'a.md' })).not.toHaveProperty('size')
    expect(
      mentionInputToPart({ path: 'a.md', name: 'a.md', size: Number.NaN }),
    ).not.toHaveProperty('size')
  })
})

describe('isChatMentionPart', () => {
  const valid: ChatMentionPart = {
    type: 'mention',
    mentionKind: 'file',
    path: 'docs/a.md',
    name: 'a.md',
  }

  it('accepts a well-formed mention part', () => {
    expect(isChatMentionPart(valid)).toBe(true)
  })

  it('rejects other part kinds, junk, and mentions missing what a pill needs', () => {
    expect(isChatMentionPart({ type: 'text', text: 'hi' })).toBe(false)
    expect(isChatMentionPart({ ...valid, path: '' })).toBe(false)
    expect(isChatMentionPart({ ...valid, name: undefined })).toBe(false)
    expect(isChatMentionPart({ ...valid, mentionKind: 'video' })).toBe(false)
    expect(isChatMentionPart(null)).toBe(false)
    expect(isChatMentionPart('mention')).toBe(false)
  })

  it('narrows a ChatMessagePart union member', () => {
    const part: ChatMessagePart = valid
    if (!isChatMentionPart(part)) throw new Error('expected a mention part')
    expect(part.path).toBe('docs/a.md')
  })
})

describe('mentionPartsFromMessageParts', () => {
  it('projects only the mention parts, in stored order', () => {
    const parts = [
      { type: 'text', text: 'see @docs/a.md and @assets/logo.png' },
      { type: 'mention', mentionKind: 'file', path: 'docs/a.md', name: 'a.md' },
      { type: 'image', url: 'data:image/png;base64,AA' },
      { type: 'mention', mentionKind: 'image', path: 'assets/logo.png', name: 'logo.png', size: 9 },
    ]
    expect(mentionPartsFromMessageParts(parts).map((part) => part.path)).toEqual([
      'docs/a.md',
      'assets/logo.png',
    ])
  })

  it('returns [] for null/undefined/empty parts', () => {
    expect(mentionPartsFromMessageParts(null)).toEqual([])
    expect(mentionPartsFromMessageParts(undefined)).toEqual([])
    expect(mentionPartsFromMessageParts([])).toEqual([])
  })
})

describe('toChatMessageParts — mention is part of the stored vocabulary', () => {
  it('narrows a stored mention row instead of dropping it as junk', () => {
    expect(
      toChatMessageParts([
        { type: 'mention', mentionKind: 'image', path: 'a/b.png', name: 'b.png', size: 12, turnId: 't1' },
      ]),
    ).toEqual([
      { type: 'mention', mentionKind: 'image', path: 'a/b.png', name: 'b.png', size: 12, turnId: 't1' },
    ])
  })

  it('drops a malformed mention row', () => {
    expect(toChatMessageParts([
      { type: 'mention', path: 'a/b.png', name: 'b.png' }, // no mentionKind
      { type: 'mention', mentionKind: 'file' }, // no path/name
    ])).toEqual([])
  })
})
