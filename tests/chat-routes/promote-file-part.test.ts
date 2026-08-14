import { describe, expect, it, vi } from 'vitest'
import {
  promoteAgentFilePart as runPromoteAgentFilePart,
  PROMOTE_MAX_FILE_BYTES,
  type AtomicPromoteAgentFilePartOptions,
  type PromoteAgentFilePartOptions,
  type RawAgentFilePart,
} from '../../src/chat-routes/promote-file-part'
import {
  createAtomicAttachmentWriter,
  type AbortAttachmentWriteFn,
  type AtomicWriteAttachmentFn,
  type AttachmentWriteReceipt,
  type WriteAttachmentFn,
} from '../../src/chat-routes/attachment-store'
import type { SandboxExecChannel } from '../../src/sandbox/binary-read'

// Written from scratch (gtm had no promote test): the harness hands back a
// `type:"file"` part whose bytes live in a `data:` URI or a sandbox path, and
// promotion writes them into the product store via the injected writer, naming
// the logical file name deterministically while each write gets an immutable
// ownership key.

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

const FIXED_CLOCK = () => new Date('2026-07-23T12:00:00.000Z')
const abortAttachment = async () => undefined

function promoteAgentFilePart(
  options: Omit<AtomicPromoteAgentFilePartOptions, 'attachmentWriter'> & {
    writeAttachment: AtomicWriteAttachmentFn
    abortAttachment?: AbortAttachmentWriteFn
  },
) {
  const { writeAttachment, abortAttachment: abort, ...rest } = options
  return runPromoteAgentFilePart({
    ...rest,
    attachmentWriter: createAtomicAttachmentWriter({ write: writeAttachment, abort: abort ?? abortAttachment }),
    createWriteId: options.createWriteId ?? (() => 'test-1'),
    logger: options.logger ?? { error: () => undefined },
  })
}

/** Records every write and answers `ok` (or a fixed failure). */
function recordingWriter(fail?: string): {
  fn: AtomicWriteAttachmentFn
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
  const fn: AtomicWriteAttachmentFn = async (scopeId, path, content, opts) => {
    writes.push({
      scopeId,
      path,
      content,
      mediaType: opts.mediaType,
      name: opts.name,
      originalName: opts.originalName,
      size: opts.size,
    })
    const receipt: AttachmentWriteReceipt = { ownership: opts.ownership, rollback: () => undefined }
    return fail ? { ok: false, reason: fail, receipt } : { ok: true, receipt }
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
    expect(result.part.path).toMatch(/^uploads\/agent\/2026-07-23\/photo-[0-9a-f]{8}\.png--test-1$/)

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

  it('keeps the legacy promotion writer result contract available', async () => {
    const writes: string[] = []
    const options: PromoteAgentFilePartOptions = {
      raw: { type: 'file', filename: 'legacy.txt', url: `data:text/plain;base64,${HELLO_B64}` },
      scopeId: 'ws',
      sessionId: 't1',
      writeAttachment: async (_scopeId, path, _content, opts) => {
        writes.push(path)
        expect(opts).not.toHaveProperty('ownership')
        return { ok: true }
      },
      now: FIXED_CLOCK,
    }
    const result = await runPromoteAgentFilePart(options)

    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    expect(result.part.path).not.toContain('--')
    expect(writes).toEqual([result.part.path])
  })

  it('redacts a legacy writer rejection reason', async () => {
    const options: PromoteAgentFilePartOptions = {
      raw: { type: 'file', filename: 'legacy.txt', url: `data:text/plain;base64,${HELLO_B64}` },
      scopeId: 'ws',
      sessionId: 't1',
      writeAttachment: async () => ({
        ok: false as const,
        reason: 'R2 secretAccessKey=legacy-promotion-secret SSN=123-45-6789',
      }),
      now: FIXED_CLOCK,
    }
    const result = await runPromoteAgentFilePart(options)

    expect(result).toEqual({
      succeeded: false,
      filename: 'legacy.txt',
      reason: expect.stringContaining('[REDACTED:credential]'),
    })
    if (result.succeeded) return
    expect(result.reason).toContain('[REDACTED:ssn]')
    expect(result.reason).not.toContain('legacy-promotion-secret')
    expect(result.reason).not.toContain('123-45-6789')
  })

  it('redacts PII-shaped attachment paths in server logs', async () => {
    const logs: unknown[] = []
    const raw: RawAgentFilePart = {
      type: 'file',
      filename: '123-45-6789.txt',
      url: `data:text/plain;base64,${HELLO_B64}`,
    }
    const result = await promoteAgentFilePart({
      raw,
      scopeId: 'ws',
      sessionId: 't1',
      writeAttachment: async () => {
        throw new Error('store failed')
      },
      logger: { error: (...args: unknown[]) => logs.push(args) },
      now: FIXED_CLOCK,
    })

    expect(result.succeeded).toBe(false)
    expect(JSON.stringify(logs)).not.toContain('123-45-6789')
    expect(JSON.stringify(logs)).toContain('[REDACTED:ssn]')
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
    expect(result.part.path).toMatch(/^uploads\/agent\/2026-07-23\/report-[0-9a-f]{8}\.pdf--test-1$/)
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
    const raw: RawAgentFilePart = { type: 'file', url: 'https://example.com/x.png?api_key=super-secret' }
    const result = await promoteAgentFilePart({ raw, box: fakeBox(HELLO), scopeId: 'ws', sessionId: 't1', writeAttachment: fn })
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.reason).toContain('unsupported file URL scheme')
    expect(result.reason).toContain('https')
    expect(result.reason).not.toContain('example.com')
    expect(result.reason).not.toContain('super-secret')
  })

  it('redacts sandbox execution errors before returning them', async () => {
    const { fn } = recordingWriter()
    const box: SandboxExecChannel = {
      async exec() {
        return { stdout: '', stderr: 'R2 failed X-Amz-Signature=super-secret', exitCode: 1 }
      },
    }
    const result = await promoteAgentFilePart({
      raw: { type: 'file', url: '/home/agent/out/report.pdf' },
      box,
      scopeId: 'ws',
      sessionId: 't1',
      writeAttachment: fn,
    })
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.reason).toContain('[REDACTED:credential]')
    expect(result.reason).not.toContain('super-secret')
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
    expect(result.reason).toBe('Attachment storage is temporarily unavailable. Please try again.')
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
    const logs: unknown[] = []
    const fn: AtomicWriteAttachmentFn = async () => {
      throw new Error('coordinator down X-Amz-Signature=super-secret-signature')
    }
    const raw: RawAgentFilePart = { type: 'file', filename: 'photo.png', url: `data:image/png;base64,${HELLO_B64}` }
    const result = await promoteAgentFilePart({
      raw,
      scopeId: 'ws',
      sessionId: 't1',
      writeAttachment: fn,
      logger: { error: (...args: unknown[]) => logs.push(args) },
      now: FIXED_CLOCK,
    })
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.reason).toBe('Attachment storage is temporarily unavailable. Please try again.')
    expect(JSON.stringify(result)).not.toContain('super-secret-signature')
    expect(JSON.stringify(logs)).not.toContain('super-secret-signature')
    expect(JSON.stringify(logs)).toContain('[REDACTED:credential]')
  })

  it('returns a typed failure when a hostile thrown value defeats getters and string conversion', async () => {
    const logs: unknown[] = []
    const hostile = new Proxy(Object.create(null), {
      get() {
        throw new Error('message getter failed')
      },
      getPrototypeOf() {
        throw new Error('prototype trap failed')
      },
      getOwnPropertyDescriptor() {
        throw new Error('descriptor trap failed')
      },
    })
    const fn: AtomicWriteAttachmentFn = async () => {
      throw hostile
    }
    const raw: RawAgentFilePart = { type: 'file', filename: 'photo.png', url: `data:image/png;base64,${HELLO_B64}` }
    const result = await promoteAgentFilePart({
      raw,
      scopeId: 'ws',
      sessionId: 't1',
      writeAttachment: fn,
      logger: { error: (...args: unknown[]) => logs.push(args) },
      now: FIXED_CLOCK,
    })

    expect(result).toEqual({
      succeeded: false,
      filename: 'photo.png',
      reason: 'Attachment storage is temporarily unavailable. Please try again.',
    })
    expect(JSON.stringify(logs)).toContain('unknown error')
  })

  it('fails closed when a receipt getter is hostile and aborts the attempted owner', async () => {
    const abort = vi.fn(async () => undefined)
    const hostileReceipt = new Proxy(Object.create(null), {
      get() {
        throw new Error('receipt getter failed')
      },
    }) as AttachmentWriteReceipt
    const raw: RawAgentFilePart = { type: 'file', filename: 'photo.png', url: `data:image/png;base64,${HELLO_B64}` }
    const result = await promoteAgentFilePart({
      raw,
      scopeId: 'ws',
      sessionId: 't1',
      writeAttachment: async () => ({ ok: true, receipt: hostileReceipt }),
      abortAttachment: abort,
      now: FIXED_CLOCK,
    })

    expect(result).toEqual({
      succeeded: false,
      filename: 'photo.png',
      reason: 'Attachment storage is temporarily unavailable. Please try again.',
    })
    expect(abort).toHaveBeenCalledOnce()
  })

  it('uses the ownership abort as a cleanup fallback when rollback fails', async () => {
    const abort = vi.fn(async () => undefined)
    const raw: RawAgentFilePart = { type: 'file', filename: 'photo.png', url: `data:image/png;base64,${HELLO_B64}` }
    const result = await promoteAgentFilePart({
      raw,
      scopeId: 'ws',
      sessionId: 't1',
      writeAttachment: async (_scopeId, _path, _content, opts) => ({
        ok: false,
        reason: 'store rejected after commit',
        receipt: {
          ownership: opts.ownership,
          rollback: () => {
            throw new Error('delete timed out')
          },
        },
      }),
      abortAttachment: abort,
      now: FIXED_CLOCK,
    })

    expect(result.succeeded).toBe(false)
    expect(abort).toHaveBeenCalledOnce()
  })
})

describe('promoteAgentFilePart — determinism', () => {
  it('adds a fresh immutable ownership key to each physical promotion', async () => {
    let nextId = 0
    const raw: RawAgentFilePart = { type: 'file', id: 'part-9', filename: 'photo.png', url: `data:image/png;base64,${HELLO_B64}` }
    const a = await promoteAgentFilePart({
      raw,
      scopeId: 'ws',
      sessionId: 't1',
      writeAttachment: recordingWriter().fn,
      createWriteId: () => `attempt-${++nextId}`,
      now: FIXED_CLOCK,
    })
    const b = await promoteAgentFilePart({
      raw,
      scopeId: 'ws',
      sessionId: 't2',
      writeAttachment: recordingWriter().fn,
      createWriteId: () => `attempt-${++nextId}`,
      now: FIXED_CLOCK,
    })
    expect(a.succeeded && b.succeeded).toBe(true)
    if (!a.succeeded || !b.succeeded) return
    expect(a.part.path).not.toBe(b.part.path)
    expect(a.part.path.replace(/--attempt-1$/, '')).toBe(b.part.path.replace(/--attempt-2$/, ''))
  })

  it('can reproduce the same physical path when the caller reuses an ownership id', async () => {
    const raw: RawAgentFilePart = { type: 'file', id: 'part-9', filename: 'photo.png', url: `data:image/png;base64,${HELLO_B64}` }
    const a = await promoteAgentFilePart({ raw, scopeId: 'ws', sessionId: 't1', writeAttachment: recordingWriter().fn, createWriteId: () => 'same-attempt', now: FIXED_CLOCK })
    const b = await promoteAgentFilePart({ raw, scopeId: 'ws', sessionId: 't2', writeAttachment: recordingWriter().fn, createWriteId: () => 'same-attempt', now: FIXED_CLOCK })
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
    expect(result.part.path).toMatch(/^assets\/image\/photo\.png#[0-9a-f]{8}--test-1$/)
  })

  it('does not exceed the default cap for a small file', async () => {
    // Guards the default constant against an accidental shrink.
    expect(PROMOTE_MAX_FILE_BYTES).toBe(10 * 1024 * 1024)
  })
})
