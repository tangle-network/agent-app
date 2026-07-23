import { describe, expect, it, vi } from 'vitest'
import {
  buildDispatchParts,
  type BuildDispatchPartsInput,
  type ReadSandboxMentionFn,
  type PromptInputPart,
} from '../../src/chat-routes/dispatch-parts'
import type { ReadAttachmentFn } from '../../src/chat-routes/attachment-store'
import type { ChatAttachmentPart, ChatMentionPart } from '../../src/chat-store/parts'
import type { SandboxExecChannel } from '../../src/sandbox/binary-read'

// Port of gtm's `dispatch-parts.test.ts`. gtm's vault-default-reader block (the
// `readVaultFileState`-backed branch) is dropped: `readAttachment` is now
// REQUIRED (no default), so that frontmatter/base64 logic lives behind the
// injected reader in the product. `GTM_SANDBOX_VAULT_DIR` becomes the injected
// `resolveAttachmentPath` (kept at the same `/home/agent/vault` value so the
// emitted absolute paths byte-match the source), and the budget/demotion/XOR/
// caps behaviour is otherwise identical.

const VAULT_DIR = '/home/agent/vault'

function attachment(overrides: Partial<ChatAttachmentPart> = {}): ChatAttachmentPart {
  return { type: 'image', path: 'uploads/pic.png', name: 'pic.png', mediaType: 'image/png', ...overrides }
}

/** Injectable reader that always succeeds with the given base64/mediaType.
 *  `size` is ignored by dispatch (it sizes from the assembled part). */
function stubReader(base64: string, mediaType?: string): ReadAttachmentFn {
  return async () => ({ ok: true, size: base64.length, base64, mediaType })
}

function base(overrides: Partial<BuildDispatchPartsInput> = {}): BuildDispatchPartsInput {
  return {
    text: 'hi',
    attachments: [] as ChatAttachmentPart[],
    history: [] as Array<{ role: 'user' | 'assistant'; content: string }>,
    systemPrompt: '',
    profileWireBytes: 0,
    scopeId: 'ws-1',
    resolveAttachmentPath: (path: string) => `${VAULT_DIR}/${path}`,
    readAttachment: stubReader('', undefined),
    ...overrides,
  }
}

function isMediaPart(part: PromptInputPart): part is Extract<PromptInputPart, { type: 'image' | 'file' }> {
  return part.type === 'image' || part.type === 'file'
}

describe('buildDispatchParts — parts[0] text', () => {
  it('is byte-identical to input.text', async () => {
    const result = await buildDispatchParts(base({ text: 'exact prompt text\nwith a newline' }))
    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    expect(result.value[0]).toEqual({ type: 'text', text: 'exact prompt text\nwith a newline' })
  })
})

describe('buildDispatchParts — inlining', () => {
  it('inlines a small image as a data: URI with no path key', async () => {
    const result = await buildDispatchParts(
      base({ attachments: [attachment()], readAttachment: stubReader('c21hbGwtcGF5bG9hZA==', 'image/png') }),
    )
    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    const part = result.value[1]
    expect(part).toEqual({
      type: 'image',
      filename: 'pic.png',
      mediaType: 'image/png',
      url: 'data:image/png;base64,c21hbGwtcGF5bG9hZA==',
    })
    expect('path' in (part as object)).toBe(false)
  })

  it('inlines a small text file with the AISDK shape (filename+url, no path key)', async () => {
    const result = await buildDispatchParts(
      base({
        attachments: [attachment({ type: 'file', path: 'uploads/notes.txt', name: 'notes.txt', mediaType: 'text/plain' })],
        readAttachment: stubReader('c21hbGwtdGV4dA==', 'text/plain'),
      }),
    )
    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    const part = result.value[1]
    expect(part).toEqual({
      type: 'file',
      filename: 'notes.txt',
      mediaType: 'text/plain',
      url: 'data:text/plain;base64,c21hbGwtdGV4dA==',
    })
    expect('path' in (part as object)).toBe(false)
  })
})

describe('buildDispatchParts — path demotion', () => {
  it('demotes an oversize image to a path part (no url key)', async () => {
    const result = await buildDispatchParts(
      base({ attachments: [attachment()], readAttachment: stubReader('A'.repeat(2_000_000), 'image/png') }),
    )
    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    const part = result.value[1]
    expect(part).toEqual({ type: 'image', filename: 'pic.png', mediaType: 'image/png', path: `${VAULT_DIR}/uploads/pic.png` })
    expect('url' in (part as object)).toBe(false)
  })

  it('demotes an oversize file to a path-only part (no mediaType/filename/url keys)', async () => {
    const result = await buildDispatchParts(
      base({
        attachments: [attachment({ type: 'file', path: 'uploads/big.csv', name: 'big.csv', mediaType: 'text/csv' })],
        readAttachment: stubReader('A'.repeat(2_000_000), 'text/csv'),
      }),
    )
    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    expect(result.value[1]).toEqual({ type: 'file', path: `${VAULT_DIR}/uploads/big.csv` })
  })

  it('forces demotion of an otherwise-inlinable image when systemPrompt consumes the budget', async () => {
    const result = await buildDispatchParts(
      base({
        systemPrompt: 'x'.repeat(950_000),
        attachments: [attachment()],
        readAttachment: stubReader('B'.repeat(50_000), 'image/png'),
      }),
    )
    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    expect(result.value[1]).toEqual({ type: 'image', filename: 'pic.png', mediaType: 'image/png', path: `${VAULT_DIR}/uploads/pic.png` })
  })

  it('forcePath sends every attachment as a path part even when small', async () => {
    const result = await buildDispatchParts(
      base({
        forcePath: true,
        attachments: [
          attachment(),
          attachment({ type: 'file', path: 'uploads/notes.txt', name: 'notes.txt', mediaType: 'text/plain' }),
        ],
        readAttachment: stubReader('dGlueQ==', 'image/png'),
      }),
    )
    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    expect(result.value[1]).toEqual({ type: 'image', filename: 'pic.png', mediaType: 'image/png', path: `${VAULT_DIR}/uploads/pic.png` })
    expect(result.value[2]).toEqual({ type: 'file', path: `${VAULT_DIR}/uploads/notes.txt` })
  })
})

describe('buildDispatchParts — budget math', () => {
  it('inlines a ~100KiB attachment when history/systemPrompt are empty', async () => {
    const payload = 'C'.repeat(100 * 1024)
    const result = await buildDispatchParts(
      base({
        attachments: [attachment({ type: 'file', path: 'uploads/mid.bin', name: 'mid.bin', mediaType: 'application/octet-stream' })],
        readAttachment: stubReader(payload, 'application/octet-stream'),
      }),
    )
    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    const part = result.value[1]
    expect(part?.type).toBe('file')
    if (part?.type === 'file') expect(part.url).toBe(`data:application/octet-stream;base64,${payload}`)
  })

  it('inlines only the first of two attachments when both cannot fit', async () => {
    const payload = 'D'.repeat(600 * 1024)
    const result = await buildDispatchParts(
      base({
        attachments: [
          attachment({ type: 'file', path: 'uploads/one.bin', name: 'one.bin', mediaType: 'application/octet-stream' }),
          attachment({ type: 'file', path: 'uploads/two.bin', name: 'two.bin', mediaType: 'application/octet-stream' }),
        ],
        readAttachment: stubReader(payload, 'application/octet-stream'),
      }),
    )
    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    const [, first, second] = result.value
    expect(first?.type).toBe('file')
    if (first?.type === 'file') expect(typeof first.url).toBe('string')
    expect(second).toEqual({ type: 'file', path: `${VAULT_DIR}/uploads/two.bin` })
  })
})

describe('buildDispatchParts — fail-loud paths', () => {
  it('fails when the injected reader reports the file missing/deleted', async () => {
    const result = await buildDispatchParts(
      base({
        attachments: [attachment()],
        readAttachment: async () => ({ ok: false, reason: 'attachment store file missing or deleted: uploads/pic.png' }),
      }),
    )
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.error).toContain('uploads/pic.png')
  })

  it('fails when the injected reader reports a missing body', async () => {
    const result = await buildDispatchParts(
      base({
        attachments: [attachment({ type: 'file', path: 'uploads/empty.bin', name: 'empty.bin' })],
        readAttachment: async () => ({ ok: false, reason: 'attachment store base64 body missing: uploads/empty.bin' }),
      }),
    )
    expect(result.succeeded).toBe(false)
  })

  it('fails when the reader produces neither base64 nor bytes', async () => {
    const result = await buildDispatchParts(
      base({ attachments: [attachment()], readAttachment: async () => ({ ok: true, size: 0 }) }),
    )
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.error).toContain('no content')
  })

  it('fails when an image attachment has no mediaType anywhere', async () => {
    const result = await buildDispatchParts(
      base({ attachments: [attachment({ mediaType: undefined })], readAttachment: stubReader('c21hbGw=', undefined) }),
    )
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.error).toContain('mediaType')
  })

  it('defaults a file attachment with no mediaType anywhere to application/octet-stream (no failure)', async () => {
    const result = await buildDispatchParts(
      base({
        attachments: [attachment({ type: 'file', path: 'uploads/plain', name: 'plain', mediaType: undefined })],
        readAttachment: stubReader('c21hbGw=', undefined),
      }),
    )
    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    const part = result.value[1]
    expect(part?.type).toBe('file')
    if (part?.type === 'file') expect(part.mediaType).toBe('application/octet-stream')
  })

  it('reuses raw bytes from a reader that returns no base64', async () => {
    const bytes = new Uint8Array([104, 105]) // "hi"
    const result = await buildDispatchParts(
      base({
        attachments: [attachment({ type: 'file', path: 'uploads/hi.bin', name: 'hi.bin', mediaType: 'text/plain' })],
        readAttachment: async () => ({ ok: true, size: bytes.byteLength, bytes, mediaType: 'text/plain' }),
      }),
    )
    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    const part = result.value[1]
    if (part?.type === 'file') expect(part.url).toBe('data:text/plain;base64,aGk=')
  })
})

describe('buildDispatchParts — url/path exclusivity invariant', () => {
  it('every emitted media part has exactly one of a data: url or an absolute path', async () => {
    const result = await buildDispatchParts(
      base({
        attachments: [attachment(), attachment({ type: 'file', path: 'uploads/big.csv', name: 'big.csv', mediaType: 'text/csv' })],
        readAttachment: async (_ws, path) =>
          path === 'uploads/big.csv'
            ? { ok: true, size: 2_000_000, base64: 'A'.repeat(2_000_000), mediaType: 'text/csv' }
            : { ok: true, size: 8, base64: 'c21hbGw=', mediaType: 'image/png' },
      }),
    )
    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    for (const part of result.value) {
      if (!isMediaPart(part)) continue
      const hasUrl = typeof part.url === 'string' && part.url.startsWith('data:')
      const hasPath = typeof part.path === 'string' && part.path.startsWith('/')
      expect(hasUrl).not.toBe(hasPath)
      expect(hasUrl || hasPath).toBe(true)
    }
  })
})

describe('buildDispatchParts — profile wire reserve', () => {
  it('demotes an attachment that would fit without the profile but not with it', async () => {
    const payload = 'a'.repeat(100 * 1024)
    const withoutProfile = await buildDispatchParts(
      base({ attachments: [attachment()], readAttachment: stubReader(payload, 'image/png') }),
    )
    expect(withoutProfile.succeeded).toBe(true)
    if (!withoutProfile.succeeded) return
    expect(withoutProfile.value[1]).not.toHaveProperty('path')

    const profileWireBytes = 1024 * 1024 - 120 * 1024
    const withProfile = await buildDispatchParts(
      base({ attachments: [attachment()], readAttachment: stubReader(payload, 'image/png'), profileWireBytes }),
    )
    expect(withProfile.succeeded).toBe(true)
    if (!withProfile.succeeded) return
    const part = withProfile.value[1]
    expect(part).not.toHaveProperty('url')
    if (part && isMediaPart(part)) expect(part.path).toBe(`${VAULT_DIR}/uploads/pic.png`)
  })

  it('final size check includes the profile rider', async () => {
    const result = await buildDispatchParts(
      base({ attachments: [attachment()], readAttachment: stubReader('c21hbGw=', 'image/png'), profileWireBytes: 1024 * 1024 }),
    )
    expect(result.succeeded).toBe(false)
  })
})

describe('buildDispatchParts — reader boundary', () => {
  it('converts a thrown reader error into the typed outcome', async () => {
    const throwingReader: ReadAttachmentFn = async () => {
      throw new Error('KV coordinator unavailable')
    }
    const result = await buildDispatchParts(base({ attachments: [attachment()], readAttachment: throwingReader }))
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.error).toContain('KV coordinator unavailable')
    expect(result.error).toContain('uploads/pic.png')
  })
})

const FAKE_BOX = {} as SandboxExecChannel

function mention(overrides: Partial<ChatMentionPart> = {}): ChatMentionPart {
  return { type: 'mention', mentionKind: 'image', path: 'pic.png', name: 'pic.png', ...overrides }
}

/** Injectable box reader: always succeeds, returning `size` (and `base64` only
 *  when the caller asked for bytes — mirroring the real stat-then-read). */
function mentionStub(size: number, base64: string): ReadSandboxMentionFn {
  return async (_box, _path, options) => ({
    succeeded: true,
    value: options.readBytes ? { size, base64 } : { size },
  })
}

describe('buildDispatchParts — mentions', () => {
  it('inlines a small image mention as a data: URI (no path key)', async () => {
    const result = await buildDispatchParts(
      base({ mentions: [mention()], box: FAKE_BOX, readSandboxMention: mentionStub(12, 'c21hbGwtcGF5bG9hZA==') }),
    )
    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    expect(result.value[1]).toEqual({
      type: 'image',
      filename: 'pic.png',
      mediaType: 'image/png',
      url: 'data:image/png;base64,c21hbGwtcGF5bG9hZA==',
    })
    expect('path' in (result.value[1] as object)).toBe(false)
  })

  it('demotes an over-budget image mention to an in-box path part (no url, never reads bytes)', async () => {
    const reader = vi.fn(async (_box: SandboxExecChannel, _path: string, options: { readBytes: boolean }) => ({
      succeeded: true as const,
      value: options.readBytes ? { size: 2_000_000, base64: 'A'.repeat(2_700_000) } : { size: 2_000_000 },
    }))
    const result = await buildDispatchParts(base({ mentions: [mention()], box: FAKE_BOX, readSandboxMention: reader }))
    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    expect(result.value[1]).toEqual({ type: 'image', filename: 'pic.png', mediaType: 'image/png', path: `${VAULT_DIR}/pic.png` })
    expect(reader).toHaveBeenCalledTimes(1)
    expect(reader.mock.calls[0]![2]).toEqual({ readBytes: false })
  })

  it('ships a non-image mention as a bare in-box path part (stat only, no bytes)', async () => {
    const reader = vi.fn(async (_box: SandboxExecChannel, _path: string, _options: { readBytes: boolean }) => ({
      succeeded: true as const,
      value: { size: 42 },
    }))
    const result = await buildDispatchParts(
      base({ mentions: [mention({ mentionKind: 'file', path: 'notes.md', name: 'notes.md' })], box: FAKE_BOX, readSandboxMention: reader }),
    )
    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    expect(result.value[1]).toEqual({ type: 'file', path: `${VAULT_DIR}/notes.md` })
    expect(reader).toHaveBeenCalledTimes(1)
    expect(reader.mock.calls[0]![2]).toEqual({ readBytes: false })
  })

  it('resolves a nested workspace-relative mention path against the mount', async () => {
    const reader = vi.fn(async (_box: SandboxExecChannel, _path: string, _options: { readBytes: boolean }) => ({
      succeeded: true as const,
      value: { size: 42 },
    }))
    const path = 'research/competitors/Q3 review — final.md'
    const result = await buildDispatchParts(
      base({ mentions: [mention({ mentionKind: 'file', path, name: 'Q3 review — final.md' })], box: FAKE_BOX, readSandboxMention: reader }),
    )
    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    expect(result.value[1]).toEqual({ type: 'file', path: `${VAULT_DIR}/${path}` })
    expect(reader.mock.calls[0]![1]).toBe(`${VAULT_DIR}/${path}`)
  })

  it('fails loud when a mentioned file was deleted (stat fails)', async () => {
    const result = await buildDispatchParts(
      base({
        mentions: [mention({ mentionKind: 'file', path: 'gone.md', name: 'gone.md' })],
        box: FAKE_BOX,
        readSandboxMention: async () => ({ succeeded: false, error: 'mentioned sandbox file missing or unreadable: /home/agent/vault/gone.md' }),
      }),
    )
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.error).toContain('gone.md')
  })

  it('fails loud when mentions are present but no box was supplied', async () => {
    const result = await buildDispatchParts(base({ mentions: [mention()] }))
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.error).toContain('box')
  })

  it('every emitted mention media part satisfies the url/path exclusivity invariant', async () => {
    const result = await buildDispatchParts(
      base({
        mentions: [mention(), mention({ mentionKind: 'file', path: 'notes.md', name: 'notes.md' })],
        box: FAKE_BOX,
        readSandboxMention: mentionStub(12, 'c21hbGw='),
      }),
    )
    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    for (const part of result.value) {
      if (!isMediaPart(part)) continue
      const hasUrl = typeof part.url === 'string' && part.url.startsWith('data:')
      const hasPath = typeof part.path === 'string' && part.path.startsWith('/')
      expect(hasUrl).not.toBe(hasPath)
      expect(hasUrl || hasPath).toBe(true)
    }
  })

  it('dedupes a mention whose absolute path already rode as an attachment', async () => {
    const result = await buildDispatchParts(
      base({
        attachments: [attachment({ path: 'pic.png' })],
        readAttachment: stubReader('c21hbGw=', 'image/png'),
        mentions: [mention({ path: 'pic.png', name: 'pic.png' })],
        box: FAKE_BOX,
        readSandboxMention: mentionStub(12, 'c21hbGw='),
      }),
    )
    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    // parts[0] text + exactly one media part (the attachment), mention deduped.
    expect(result.value).toHaveLength(2)
  })
})

describe('buildDispatchParts — parts-count cap', () => {
  it('fails loud past the sidecar per-request parts cap', async () => {
    const attachments = Array.from({ length: 64 }, (_, index) =>
      attachment({ path: `uploads/pic-${index}.png`, name: `pic-${index}.png` }),
    )
    const result = await buildDispatchParts(base({ attachments, readAttachment: stubReader('c21hbGw=', 'image/png') }))
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.error).toContain('parts')
  })
})
