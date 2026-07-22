import { describe, expect, it } from 'vitest'

import {
  buildMentionPromptBlock,
  ChatTurnInputError,
  fileMentionsToParts,
  mediaTypeForMentionPath,
  MENTION_MAX_COUNT,
  mentionKindForPath,
  parseFileMentions,
  validateSandboxMentionPath,
  type FileMention,
} from '../../src/chat-routes/index'

describe('mediaTypeForMentionPath', () => {
  it('maps known image extensions to their mime type, case-insensitively', () => {
    expect(mediaTypeForMentionPath('a/b/chart.PNG')).toBe('image/png')
    expect(mediaTypeForMentionPath('shot.jpeg')).toBe('image/jpeg')
    expect(mediaTypeForMentionPath('icon.svg')).toBe('image/svg+xml')
  })

  it('returns undefined for non-image extensions and extensionless paths', () => {
    expect(mediaTypeForMentionPath('notes.md')).toBeUndefined()
    expect(mediaTypeForMentionPath('Makefile')).toBeUndefined()
    expect(mediaTypeForMentionPath('src/component')).toBeUndefined()
  })
})

describe('fileMentionsToParts', () => {
  it('emits path-only parts — never a url (the url/path XOR invariant)', () => {
    const mentions: FileMention[] = [
      { path: 'src/app.ts', name: 'app.ts' },
      { path: 'assets/logo.png', name: 'logo.png' },
    ]
    const parts = fileMentionsToParts(mentions)
    expect(parts).toEqual([
      { type: 'file', filename: 'app.ts', path: 'src/app.ts' },
      { type: 'image', filename: 'logo.png', path: 'assets/logo.png', mediaType: 'image/png' },
    ])
    for (const part of parts) {
      expect(part.url).toBeUndefined()
      expect(part.path).toBeTruthy()
    }
  })

  it('discriminates image vs file by extension', () => {
    const [imagePart, filePart] = fileMentionsToParts([
      { path: 'a.gif', name: 'a.gif' },
      { path: 'a.pdf', name: 'a.pdf' },
    ])
    expect(imagePart!.type).toBe('image')
    expect(filePart!.type).toBe('file')
    expect(filePart!.mediaType).toBeUndefined()
  })

  it('resolves paths through the supplied resolver (e.g. a host prefixing its vault root)', () => {
    const parts = fileMentionsToParts([{ path: 'notes.md', name: 'notes.md' }], {
      resolvePath: (p) => `/home/agent/vault/${p}`,
    })
    expect(parts[0]!.path).toBe('/home/agent/vault/notes.md')
  })

  it('returns an empty array for an empty mention list', () => {
    expect(fileMentionsToParts([])).toEqual([])
  })
})

describe('buildMentionPromptBlock', () => {
  it('returns empty string for no mentions', () => {
    expect(buildMentionPromptBlock([])).toBe('')
  })

  it('builds a pointer block naming each mentioned path', () => {
    const block = buildMentionPromptBlock([
      { name: 'app.ts', path: 'src/app.ts' },
      { name: 'logo.png', path: 'assets/logo.png' },
    ])
    expect(block).toContain('Mentioned files')
    expect(block).toContain('- app.ts (src/app.ts)')
    expect(block).toContain('- logo.png (assets/logo.png)')
  })

  it('is safe to append unconditionally to a dispatched prompt', () => {
    const content = 'Summarize these'
    expect(`${content}${buildMentionPromptBlock([])}`).toBe(content)
    expect(
      `${content}${buildMentionPromptBlock([{ name: 'b.png', path: 'b.png' }])}`,
    ).toBe(`${content}\n\nMentioned files — read them from these paths:\n- b.png (b.png)`)
  })
})

describe('mentionKindForPath', () => {
  it('reads the same extension table as mediaTypeForMentionPath', () => {
    expect(mentionKindForPath('a/b/chart.PNG')).toBe('image')
    expect(mentionKindForPath('icon.svg')).toBe('image')
    expect(mentionKindForPath('notes.md')).toBe('file')
    expect(mentionKindForPath('Makefile')).toBe('file')
  })

  it('agrees with mediaTypeForMentionPath on every path — one table, not two', () => {
    for (const path of ['a.png', 'a.JPEG', 'a.heif', 'a.avif', 'a.md', 'a', 'a.tar.gz', '.hidden']) {
      expect(mentionKindForPath(path)).toBe(mediaTypeForMentionPath(path) ? 'image' : 'file')
    }
  })
})

describe('validateSandboxMentionPath', () => {
  it('rejects a `..` path segment, anywhere', () => {
    const result = validateSandboxMentionPath('content/../../secrets.env')
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.error).toContain('..')
    expect(validateSandboxMentionPath('..').succeeded).toBe(false)
  })

  it('rejects an absolute (leading-slash) path', () => {
    const result = validateSandboxMentionPath('/etc/passwd')
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.error).toContain('absolute')
  })

  it('rejects backslashes and null bytes', () => {
    expect(validateSandboxMentionPath('content\\notes.md').succeeded).toBe(false)
    expect(validateSandboxMentionPath('content/notes\0.md').succeeded).toBe(false)
  })

  it('rejects an empty, over-long, or non-string path', () => {
    expect(validateSandboxMentionPath('').succeeded).toBe(false)
    expect(validateSandboxMentionPath(undefined).succeeded).toBe(false)
    expect(validateSandboxMentionPath(42).succeeded).toBe(false)
    expect(validateSandboxMentionPath('a'.repeat(1025)).succeeded).toBe(false)
  })

  it('allows spaces and unicode — in-box filenames are arbitrary', () => {
    expect(validateSandboxMentionPath('notes/My Report — final.md').succeeded).toBe(true)
    expect(validateSandboxMentionPath('研究/計画.md').succeeded).toBe(true)
    expect(validateSandboxMentionPath('content/uploads/pic.png').succeeded).toBe(true)
  })

  it('allows a path that merely CONTAINS dots without a `..` segment', () => {
    expect(validateSandboxMentionPath('a..b/c.md').succeeded).toBe(true)
    expect(validateSandboxMentionPath('...hidden/c.md').succeeded).toBe(true)
  })
})

describe('parseFileMentions', () => {
  const mention = (over: Record<string, unknown> = {}) => ({
    path: 'content/notes.md',
    name: 'notes.md',
    ...over,
  })

  it('returns [] for an absent or null field', () => {
    expect(parseFileMentions(undefined)).toEqual([])
    expect(parseFileMentions(null)).toEqual([])
  })

  it('throws ChatTurnInputError (400) when the field is not an array', () => {
    expect(() => parseFileMentions({ path: 'x' })).toThrow(ChatTurnInputError)
    try {
      parseFileMentions({ path: 'x' })
    } catch (err) {
      expect((err as ChatTurnInputError).status).toBe(400)
      expect((err as ChatTurnInputError).message).toContain('array')
    }
  })

  it('fails loud on a traversal path, naming the entry (never sanitize-and-continue)', () => {
    expect(() => parseFileMentions([mention({ path: 'content/../../secrets.env' })]))
      .toThrow(/mentions\[0\].*\.\./)
  })

  it('rejects absolute paths, backslashes and NUL', () => {
    expect(() => parseFileMentions([mention({ path: '/etc/passwd' })])).toThrow(ChatTurnInputError)
    expect(() => parseFileMentions([mention({ path: 'a\\b.md' })])).toThrow(ChatTurnInputError)
    expect(() => parseFileMentions([mention({ path: 'a\0b.md' })])).toThrow(ChatTurnInputError)
  })

  it('rejects a non-object entry', () => {
    expect(() => parseFileMentions(['content/notes.md'])).toThrow(/mentions\[0\] must be an object/)
    expect(() => parseFileMentions([[]])).toThrow(/mentions\[0\] must be an object/)
  })

  it('rejects a missing, blank, or over-long name', () => {
    expect(() => parseFileMentions([{ path: 'content/x.md' }])).toThrow(/name/)
    expect(() => parseFileMentions([mention({ name: '   ' })])).toThrow(/name/)
    expect(() => parseFileMentions([mention({ name: 'n'.repeat(257) })])).toThrow(/name/)
  })

  it('rejects a negative or non-finite size', () => {
    expect(() => parseFileMentions([mention({ size: -1 })])).toThrow(/size/)
    expect(() => parseFileMentions([mention({ size: Number.NaN })])).toThrow(/size/)
    expect(() => parseFileMentions([mention({ size: '10' })])).toThrow(/size/)
  })

  it('rejects more than MENTION_MAX_COUNT entries', () => {
    const many = Array.from({ length: MENTION_MAX_COUNT + 1 }, (_, i) =>
      mention({ path: `content/f${i}.md`, name: `f${i}.md` }),
    )
    expect(() => parseFileMentions(many)).toThrow(new RegExp(String(MENTION_MAX_COUNT)))
    expect(parseFileMentions(many.slice(0, MENTION_MAX_COUNT))).toHaveLength(MENTION_MAX_COUNT)
  })

  it('keeps only the declared fields, dropping anything else off the wire', () => {
    expect(parseFileMentions([mention({ size: 128, evil: 'x' })])).toEqual([
      { path: 'content/notes.md', name: 'notes.md', size: 128 },
    ])
    expect(parseFileMentions([mention()])).toEqual([
      { path: 'content/notes.md', name: 'notes.md' },
    ])
  })

  it('dedupes a path repeated within one turn, keeping the first', () => {
    const parsed = parseFileMentions([
      mention({ name: 'first.md' }),
      mention({ name: 'second.md' }),
    ])
    expect(parsed).toEqual([{ path: 'content/notes.md', name: 'first.md' }])
  })

  it('produces exactly what fileMentionsToParts consumes', () => {
    const parsed: FileMention[] = parseFileMentions([
      mention({ path: 'assets/logo.png', name: 'logo.png' }),
    ])
    expect(fileMentionsToParts(parsed)).toEqual([
      { type: 'image', filename: 'logo.png', path: 'assets/logo.png', mediaType: 'image/png' },
    ])
  })
})
