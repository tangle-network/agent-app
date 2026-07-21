import { describe, expect, it } from 'vitest'

import {
  buildMentionPromptBlock,
  fileMentionsToParts,
  mediaTypeForMentionPath,
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
