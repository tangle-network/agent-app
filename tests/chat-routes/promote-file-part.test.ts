import { describe, expect, it } from 'vitest'
import {
  promoteAgentFilePart,
  PROMOTE_MAX_FILE_BYTES,
  type RawAgentFilePart,
} from '../../src/chat-routes/promote-file-part'
import type { WriteAttachmentFn } from '../../src/chat-routes/attachment-store'
import type { SandboxExecChannel } from '../../src/sandbox/binary-read'

// Written from scratch (gtm had no promote test): the harness hands back a
// `type:"file"` part whose bytes live in a `data:` URI or a sandbox path, and
// promotion writes them into the product store via the injected writer, naming
// the file deterministically so a re-promote overwrites in place.

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

const FIXED_CLOCK = () => new Date('2026-07-23T12:00:00.000Z')

/** Records every write and answers `ok` (or a fixed failure). */
function recordingWriter(fail?: string): {
  fn: WriteAttachmentFn
  writes: Array<{
    scopeId: string
    path: string
    content: Uint8Array | string
    mediaType?: string
    name?: string
    originalName?: string
    size?: number
  }>
} {
  const writes: Array<{
    scopeId: string
    path: string
    content: Uint8Array | string
    mediaType?: string
    name?: string
    originalName?: string
    size?: number
  }> = []
  const fn: WriteAttachmentFn = async (scopeId, path, content, opts) => {
    writes.push({
      scopeId,
      path,
      content,
      mediaType: opts.mediaType,
      name: opts.name,
      originalName: opts.originalName,
      size: opts.size,
    })
    return fail ? { ok: false, reason: fail } : { ok: true }
  }
  return { fn, writes }
}

/** A box whose `wc -c`/`base64` execs answer for one seeded file. */
function fakeBox(fileBytes: Uint8Array): SandboxExecChannel {
  return {
    async exec(command: string) {
      if (command.startsWith('wc -c')) return { stdout: String(fileBytes.byteLength), stderr: '', exitCode: 0 }
      if (command.startsWith('base64')) return { stdout: bytesToBase64(fileBytes), stderr: '', exitCode: 0 }
      return { stdout: '', stderr: 'unexpected command', exitCode: 1 }
    },
  }
}

const HELLO = new Uint8Array([104, 101, 108, 108, 111]) // "hello"
const HELLO_B64 = bytesToBase64(HELLO)

describe('promoteAgentFilePart — data URI', () => {
  it('decodes a base64 data URI, writes the raw bytes, and returns a store part', async () => {
    const { fn, writes } = recordingWriter()
    const raw: RawAgentFilePart = { type: 'file', filename: 'photo.png', url: `data:image/png;base64,${HELLO_B64}` }
    const result = await promoteAgentFilePart({ raw, scopeId: 'ws', sessionId: 't1', writeAttachment: fn, now: FIXED_CLOCK })

    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    expect(result.part.type).toBe('image')
    expect(result.part.name).toBe('photo.png')
    expect(result.part.size).toBe(5)
    expect(result.part.mediaType).toBe('image/png')
    expect(result.part.path).toMatch(/^uploads\/agent\/2026-07-23\/photo-[0-9a-f]{8}\.png$/)

    expect(writes).toHaveLength(1)
    expect(writes[0]!.scopeId).toBe('ws')
    expect(writes[0]!.path).toBe(result.part.path)
    expect(writes[0]!.content).toBeInstanceOf(Uint8Array)
    expect(Array.from(writes[0]!.content as Uint8Array)).toEqual([104, 101, 108, 108, 111])
    expect(writes[0]!.mediaType).toBe('image/png')
    // Writer metadata mirrors gtm's vault frontmatter (originalName/name/size).
    expect(writes[0]!.name).toBe('photo.png')
    expect(writes[0]!.originalName).toBe('photo.png')
    expect(writes[0]!.size).toBe(5)
  })

  it('passes the pre-sanitization filename as originalName, distinct from the sanitized name', async () => {
    const { fn, writes } = recordingWriter()
    const raw: RawAgentFilePart = {
      type: 'file',
      filename: 'My Report (final)!.png',
      url: `data:image/png;base64,${HELLO_B64}`,
    }
    const result = await promoteAgentFilePart({ raw, scopeId: 'ws', sessionId: 't1', writeAttachment: fn, now: FIXED_CLOCK })
    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    expect(writes[0]!.originalName).toBe('My Report (final)!.png')
    expect(writes[0]!.name).toBe(result.part.name)
    expect(writes[0]!.name).not.toBe(writes[0]!.originalName)
  })

  it('falls back originalName to the sanitized name when the raw part carries no filename', async () => {
    const { fn, writes } = recordingWriter()
    const raw: RawAgentFilePart = { type: 'file', url: `data:image/png;base64,${HELLO_B64}` }
    const result = await promoteAgentFilePart({ raw, scopeId: 'ws', sessionId: 't1', writeAttachment: fn, now: FIXED_CLOCK })
    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    expect(writes[0]!.originalName).toBe(writes[0]!.name)
    expect(writes[0]!.originalName).toBe(result.part.name)
  })

  it('sniffs a media type from the filename when the part carries none', async () => {
    const { fn } = recordingWriter()
    const raw: RawAgentFilePart = { type: 'file', filename: 'notes.md', url: `data:;base64,${HELLO_B64}` }
    const result = await promoteAgentFilePart({ raw, scopeId: 'ws', sessionId: 't1', writeAttachment: fn, now: FIXED_CLOCK })
    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    expect(result.part.mediaType).toBe('text/markdown')
    expect(result.part.type).toBe('file')
  })
})

describe('promoteAgentFilePart — sandbox path', () => {
  it('reads bytes from the box and promotes an absolute-path part', async () => {
    const { fn, writes } = recordingWriter()
    const raw: RawAgentFilePart = { type: 'file', url: '/home/agent/out/report.pdf' }
    const result = await promoteAgentFilePart({
      raw,
      box: fakeBox(HELLO),
      scopeId: 'ws',
      sessionId: 't1',
      writeAttachment: fn,
      now: FIXED_CLOCK,
    })
    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    expect(result.part.name).toBe('report.pdf')
    expect(result.part.mediaType).toBe('application/pdf')
    expect(result.part.type).toBe('file')
    expect(result.part.size).toBe(5)
    expect(result.part.path).toMatch(/^uploads\/agent\/2026-07-23\/report-[0-9a-f]{8}\.pdf$/)
    expect(writes[0]!.path).toBe(result.part.path)
  })

  it('fails loud when a sandbox-path part has no box to read from', async () => {
    const { fn } = recordingWriter()
    const raw: RawAgentFilePart = { type: 'file', url: '/home/agent/out/report.pdf' }
    const result = await promoteAgentFilePart({ raw, scopeId: 'ws', sessionId: 't1', writeAttachment: fn })
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.reason).toContain('no sandbox')
  })

  it('rejects an unsupported URL scheme', async () => {
    const { fn } = recordingWriter()
    const raw: RawAgentFilePart = { type: 'file', url: 'https://example.com/x.png' }
    const result = await promoteAgentFilePart({ raw, box: fakeBox(HELLO), scopeId: 'ws', sessionId: 't1', writeAttachment: fn })
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.reason).toContain('unsupported file URL scheme')
  })
})

describe('promoteAgentFilePart — failure modes', () => {
  it('rejects a file over the size cap without writing', async () => {
    const { fn, writes } = recordingWriter()
    const raw: RawAgentFilePart = { type: 'file', filename: 'big.bin', url: `data:application/octet-stream;base64,${HELLO_B64}` }
    const result = await promoteAgentFilePart({ raw, scopeId: 'ws', sessionId: 't1', writeAttachment: fn, maxBytes: 4, now: FIXED_CLOCK })
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.filename).toBe('big.bin')
    expect(result.reason).toContain('limited to 4B')
    expect(writes).toHaveLength(0)
  })

  it('pins the exact small-number human-readable oversize error text', async () => {
    const { fn } = recordingWriter()
    const raw: RawAgentFilePart = {
      type: 'file',
      filename: 'report.pdf',
      url: `data:application/pdf;base64,${HELLO_B64}`,
    }
    const result = await promoteAgentFilePart({ raw, scopeId: 'ws', sessionId: 't1', writeAttachment: fn, maxBytes: 4, now: FIXED_CLOCK })
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.reason).toBe('report.pdf is 5B; attachments are limited to 4B')
  })

  it('pins the exact megabyte-scale oversize error text (byte-identical to gtm\'s attachmentSizeErrorMessage)', async () => {
    // gtm's attachmentSizeErrorMessage (attachment-limits.ts:87-89) formats
    // BOTH numbers via formatBytes — e.g. "big.bin is 11MB; attachments are
    // limited to 10MB" — never raw byte counts. Model an 11 MiB sandbox file
    // against the real 10 MiB default cap.
    const elevenMb = new Uint8Array(11 * 1024 * 1024)
    const { fn } = recordingWriter()
    const raw: RawAgentFilePart = { type: 'file', filename: 'big.bin', url: '/home/agent/out/big.bin' }
    const result = await promoteAgentFilePart({
      raw,
      box: fakeBox(elevenMb),
      scopeId: 'ws',
      sessionId: 't1',
      writeAttachment: fn,
      now: FIXED_CLOCK,
    })
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.reason).toBe('big.bin is 11MB; attachments are limited to 10MB')
  })

  it('surfaces a store-write failure as a typed outcome', async () => {
    const { fn } = recordingWriter('disk full')
    const raw: RawAgentFilePart = { type: 'file', filename: 'photo.png', url: `data:image/png;base64,${HELLO_B64}` }
    const result = await promoteAgentFilePart({ raw, scopeId: 'ws', sessionId: 't1', writeAttachment: fn, now: FIXED_CLOCK })
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.filename).toBe('photo.png')
    expect(result.reason).toBe('disk full')
  })

  it('rejects a malformed part carrying no url', async () => {
    const { fn } = recordingWriter()
    const raw = { type: 'file' } as RawAgentFilePart
    const result = await promoteAgentFilePart({ raw, scopeId: 'ws', sessionId: 't1', writeAttachment: fn })
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.reason).toContain('no url')
  })

  it('never throws when the writer throws — folds it into the outcome', async () => {
    const fn: WriteAttachmentFn = async () => {
      throw new Error('coordinator down')
    }
    const raw: RawAgentFilePart = { type: 'file', filename: 'photo.png', url: `data:image/png;base64,${HELLO_B64}` }
    const result = await promoteAgentFilePart({ raw, scopeId: 'ws', sessionId: 't1', writeAttachment: fn, now: FIXED_CLOCK })
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.reason).toContain('coordinator down')
  })
})

describe('promoteAgentFilePart — determinism', () => {
  it('promotes the same source part to a stable path across re-promotion', async () => {
    const raw: RawAgentFilePart = { type: 'file', id: 'part-9', filename: 'photo.png', url: `data:image/png;base64,${HELLO_B64}` }
    const a = await promoteAgentFilePart({ raw, scopeId: 'ws', sessionId: 't1', writeAttachment: recordingWriter().fn, now: FIXED_CLOCK })
    const b = await promoteAgentFilePart({ raw, scopeId: 'ws', sessionId: 't2', writeAttachment: recordingWriter().fn, now: FIXED_CLOCK })
    expect(a.succeeded && b.succeeded).toBe(true)
    if (!a.succeeded || !b.succeeded) return
    expect(a.part.path).toBe(b.part.path)
  })

  it('hashes the id over the url — two files sharing a name but not an id get distinct paths', async () => {
    const base = { type: 'file' as const, filename: 'photo.png', url: `data:image/png;base64,${HELLO_B64}` }
    const one = await promoteAgentFilePart({ raw: { ...base, id: 'a' }, scopeId: 'ws', sessionId: 't', writeAttachment: recordingWriter().fn, now: FIXED_CLOCK })
    const two = await promoteAgentFilePart({ raw: { ...base, id: 'b' }, scopeId: 'ws', sessionId: 't', writeAttachment: recordingWriter().fn, now: FIXED_CLOCK })
    expect(one.succeeded && two.succeeded).toBe(true)
    if (!one.succeeded || !two.succeeded) return
    expect(one.part.path).not.toBe(two.part.path)
  })

  it('puts the injected clock date into the path', async () => {
    const { fn } = recordingWriter()
    const raw: RawAgentFilePart = { type: 'file', filename: 'photo.png', url: `data:image/png;base64,${HELLO_B64}` }
    const result = await promoteAgentFilePart({ raw, scopeId: 'ws', sessionId: 't', writeAttachment: fn, now: () => new Date('2001-02-03T00:00:00Z') })
    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    expect(result.part.path).toContain('uploads/agent/2001-02-03/')
  })

  it('honours an injected buildAttachmentPath override', async () => {
    const { fn } = recordingWriter()
    const raw: RawAgentFilePart = { type: 'file', filename: 'photo.png', url: `data:image/png;base64,${HELLO_B64}` }
    const result = await promoteAgentFilePart({
      raw,
      scopeId: 'ws',
      sessionId: 't',
      writeAttachment: fn,
      buildAttachmentPath: ({ filename, hash8, kind }) => `assets/${kind}/${filename}#${hash8}`,
      now: FIXED_CLOCK,
    })
    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    expect(result.part.path).toMatch(/^assets\/image\/photo\.png#[0-9a-f]{8}$/)
  })

  it('does not exceed the default cap for a small file', async () => {
    // Guards the default constant against an accidental shrink.
    expect(PROMOTE_MAX_FILE_BYTES).toBe(10 * 1024 * 1024)
  })
})
