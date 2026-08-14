/**
 * Tests for `createAttachmentUploadRoute`.
 *
 * Classification is content-based (`sniffBinary`), not extension-based: a
 * lying extension (PNG named .txt, an ordinary archive named .docx) must
 * still be detected and routed to the raw-bytes writer with the sniffed
 * mime. Size guards enforce the raw per-kind limit and the aggregate
 * per-batch limit against the AUTHORITATIVE (decoded) byte length, not the
 * client-reported `file.size`. A separate type gate (`checkAttachmentType`)
 * rejects content whose sniffed mime isn't an allowed attachment type, or
 * that mismatches an extension with an unambiguous magic-byte family. Ported
 * from gtm-agent's `tests/api-vault-upload.test.ts`; rate-limiting cases are
 * replaced by the `authorize` seam cases (a 429 rides `{ok:false, response}`
 * verbatim — this factory has no rate-limit opinion of its own).
 */
import { describe, expect, it, vi } from 'vitest'

import {
  createAttachmentUploadRoute as buildAttachmentUploadRoute,
} from '../../src/chat-routes/attachment-upload'
import {
  ALLOWED_ATTACHMENT_SNIFFED_MIMES,
  MACRO_ENABLED_OOXML_SNIFFED_MIMES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_BINARY_ATTACHMENT_BYTES,
} from '../../src/chat-routes/attachment-validation'
import {
  OOXML_PRESENTATION_MIME,
  OOXML_SPREADSHEET_MIME,
  OOXML_WORD_MACRO_ENABLED_MIME,
  OOXML_WORD_MIME,
} from '../../src/chat-routes/binary-sniff'
import type {
  AbortAttachmentWriteFn,
  AtomicWriteAttachmentFn,
  AttachmentWriteOwnership,
  AttachmentWriteReceipt,
  WriteAttachmentFn,
} from '../../src/chat-routes/attachment-store'
import type { ChatAttachmentInput, ChatAttachmentKind } from '../../src/chat-routes/wire'
import { docxBytes, plainZipBytes, realWorldOoxmlBytes } from './ooxml-fixtures'

const SCOPE = 'ws-1'

type TestAuthorization =
  | {
      ok: true
      scopeId: string
      writeAttachment?: AtomicWriteAttachmentFn
      abortAttachment?: AbortAttachmentWriteFn
    }
  | { ok: false; response: Response }

function okAuthorize(overrides: Partial<Extract<TestAuthorization, { ok: true }>> = {}) {
  return async (): Promise<TestAuthorization> => ({
    ok: true,
    scopeId: SCOPE,
    abortAttachment,
    ...overrides,
  })
}

type RecordingWriteResult =
  | { ok: true; receipt?: AttachmentWriteReceipt }
  | { ok: false; reason: string; receipt?: AttachmentWriteReceipt }

function ownershipReceipt(
  ownership: AttachmentWriteOwnership,
  rollback: () => void | Promise<void> = () => undefined,
): AttachmentWriteReceipt {
  return { ownership, rollback }
}

function recordingWriteAttachment(result: RecordingWriteResult = { ok: true }) {
  const writes: Array<{
    scopeId: string
    path: string
    content: Uint8Array | string
    opts: {
      mediaType?: string
      name?: string
      originalName?: string
      size?: number
      ownership: AttachmentWriteOwnership
    }
  }> = []
  const write: AtomicWriteAttachmentFn = async (scopeId, path, content, opts) => {
    writes.push({ scopeId, path, content, opts })
    const receipt = result.receipt ?? ownershipReceipt(opts.ownership)
    return result.ok ? { ok: true, receipt } : { ok: false, reason: result.reason, receipt }
  }
  return { write, writes }
}

const abortAttachment = async () => undefined

type TestRouteOptions = {
  authorize(args: { request: Request }): Promise<TestAuthorization>
  writeAttachment: AtomicWriteAttachmentFn
  limits?: {
    maxCount?: number
    maxBinaryBytes?: number
    maxBytesBySniffedMime?: ReadonlyMap<string, number>
    maxTextBytes?: number
    maxTotalBytes?: number
  }
  allowedKinds?: ChatAttachmentKind[]
  allowedSniffedMimes?: ReadonlySet<string>
  pathFor?: (name: string) => string
  validatePath?: (path: string) => { succeeded: true } | { succeeded: false; error: string }
  sniffMime?: (name: string) => string
  createWriteId?: () => string
  logger?: { error(...args: unknown[]): void }
}

function createAttachmentUploadRoute(options: TestRouteOptions) {
  let nextId = 0
  const { authorize, writeAttachment, ...routeOptions } = options
  return buildAttachmentUploadRoute({
    ...routeOptions,
    attachmentWriter: { write: writeAttachment, abort: abortAttachment },
    authorize: async (args) => {
      const auth = await authorize(args)
      if (!auth.ok) return auth
      return {
        ok: true,
        scopeId: auth.scopeId,
        attachmentWriter: {
          write: auth.writeAttachment ?? writeAttachment,
          abort: auth.abortAttachment ?? abortAttachment,
        },
      }
    },
    createWriteId: options.createWriteId ?? (() => `test-${++nextId}`),
  })
}

/** `new File([Uint8Array | string], name, {type})`, cast through `BlobPart` —
 *  `Uint8Array`'s `buffer` is typed `ArrayBufferLike` (which admits
 *  `SharedArrayBuffer`), narrower than the DOM lib's `BlobPart`. */
function fileOf(content: Uint8Array | string, name: string, type: string): File {
  return new File([content as BlobPart], name, { type })
}

function uploadRequest(files: File[], fieldNames?: string[]): Request {
  const form = new FormData()
  files.forEach((file, index) => {
    form.append(fieldNames?.[index] ?? 'file', file)
  })
  return new Request('http://app.test/api/attachments/upload', { method: 'POST', body: form })
}

async function json(res: Response): Promise<{ error?: { code: string; message: string; path?: string } }> {
  return res.json() as Promise<{ error?: { code: string; message: string; path?: string } }>
}

// --- real magic-byte fixtures (ported from gtm's api-vault-upload.test.ts) ---

function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
}

/** PNG signature followed by zero-padding out to `totalBytes` — the sniffer
 *  matches magic bytes at a fixed offset, so the padding never has to be
 *  meaningful pixel data. */
function pngBytesOfSize(totalBytes: number): Uint8Array {
  const bytes = new Uint8Array(totalBytes)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  return bytes
}

function pdfBytes(): Uint8Array {
  return new TextEncoder().encode('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<< >>\nendobj\n')
}

function id3Mp3Bytes(): Uint8Array {
  return new Uint8Array([...'ID3'.split('').map((c) => c.charCodeAt(0)), 0x03, 0x00, 0x00, 0x00, 0x00, 0x02, 0x01])
}

function zipBytes(): Uint8Array {
  return new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 1, 2, 3, 4, 5])
}

function avifBytes(): Uint8Array {
  return new Uint8Array([0, 0, 0, 0x1c, ...'ftyp'.split('').map((c) => c.charCodeAt(0)), ...'avif'.split('').map((c) => c.charCodeAt(0))])
}

function mp4BytesOfSize(totalBytes: number): Uint8Array {
  const bytes = new Uint8Array(totalBytes)
  bytes.set([0, 0, 0, 0x18, ...'ftyp'.split('').map((c) => c.charCodeAt(0)), ...'isom'.split('').map((c) => c.charCodeAt(0))], 0)
  return bytes
}

describe('createAttachmentUploadRoute', () => {
  it('writes raw PNG bytes with the correct opts (mediaType/name/originalName/size)', async () => {
    const { write, writes } = recordingWriteAttachment()
    const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })
    const bytes = pngBytes()
    const res = await route(uploadRequest([fileOf(bytes, 'photo.png', 'image/png')]))

    expect(res.status).toBe(200)
    const body = await res.json() as { files: ChatAttachmentInput[] }
    expect(body.files).toEqual([{ path: 'photo.png--test-1', name: 'photo.png', size: bytes.length, mediaType: 'image/png', kind: 'image' }])

    expect(writes).toHaveLength(1)
    expect(writes[0]!.scopeId).toBe(SCOPE)
    expect(writes[0]!.path).toBe('photo.png--test-1')
    expect(writes[0]!.content).toBeInstanceOf(Uint8Array)
    expect(Array.from(writes[0]!.content as Uint8Array)).toEqual(Array.from(bytes))
    expect(writes[0]!.opts).toMatchObject({ mediaType: 'image/png', name: 'photo.png', originalName: 'photo.png', size: bytes.length })
    expect(writes[0]!.opts.ownership).toEqual({ id: 'test-1', path: 'photo.png--test-1' })
  })

  it('writes raw text bytes verbatim with the correct opts', async () => {
    const { write, writes } = recordingWriteAttachment()
    const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })
    const text = '# Notes\n\nSome plain text.'
    const res = await route(uploadRequest([fileOf(text, 'notes.md', 'text/markdown')]))

    expect(res.status).toBe(200)
    const body = await res.json() as { files: ChatAttachmentInput[] }
    expect(body.files).toEqual([{ path: 'notes.md--test-1', name: 'notes.md', size: text.length, mediaType: 'text/markdown', kind: 'file' }])

    expect(writes[0]!.content).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(writes[0]!.content as Uint8Array)).toBe(text)
    expect(writes[0]!.opts).toMatchObject({ mediaType: 'text/markdown', name: 'notes.md', originalName: 'notes.md', size: text.length })
  })

  it('sanitizes filenames into the store charset and preserves the original in originalName', async () => {
    const { write, writes } = recordingWriteAttachment()
    const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })
    const bytes = pngBytes()
    const res = await route(uploadRequest([fileOf(bytes, 'CleanShot 2026-07-14 at 18.46.28@2x.png', 'image/png')]))

    expect(res.status).toBe(200)
    const body = await res.json() as { files: ChatAttachmentInput[] }
    expect(body.files).toEqual([{
      path: 'CleanShot-2026-07-14-at-18.46.28-2x.png--test-1',
      name: 'CleanShot-2026-07-14-at-18.46.28-2x.png',
      size: bytes.length,
      mediaType: 'image/png',
      kind: 'image',
    }])
    expect(writes[0]!.opts.originalName).toBe('CleanShot 2026-07-14 at 18.46.28@2x.png')
  })

  it('detects binary content even when the extension lies (PNG bytes named .txt), writing the sniffed mime', async () => {
    // ".txt" has no unambiguous magic-byte family in the extension-implies-mime
    // table, so this isn't a *mismatch* — the sniffed mime (image/png) is
    // simply allowed, and the content is stored as such under the .txt name.
    const { write, writes } = recordingWriteAttachment()
    const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })
    const res = await route(uploadRequest([fileOf(pngBytes(), 'photo.txt', 'text/plain')]))

    expect(res.status).toBe(200)
    const body = await res.json() as { files: ChatAttachmentInput[] }
    expect(body.files[0]).toMatchObject({ mediaType: 'image/png', kind: 'image' })
    expect(writes[0]!.opts.mediaType).toBe('image/png')
  })

  it('rejects the renamed-file attack (PNG content named .pdf) as a mismatch, naming the extension and sniffed mime', async () => {
    const { write, writes } = recordingWriteAttachment()
    const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })
    const res = await route(uploadRequest([fileOf(pngBytes(), 'invoice.pdf', 'application/pdf')]))

    expect(res.status).toBe(400)
    const body = await json(res)
    expect(body.error?.code).toBe('attachment_type_mismatch')
    expect(body.error?.message).toContain('.pdf')
    expect(body.error?.message).toContain('image/png')
    expect(writes).toHaveLength(0)
  })

  it('rejects a bare zip signature named .docx as a mismatch (400), writing nothing', async () => {
    const { write, writes } = recordingWriteAttachment()
    const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })
    const file = fileOf(zipBytes(), 'report.docx', OOXML_WORD_MIME)
    const res = await route(uploadRequest([file]))

    expect(res.status).toBe(400)
    const body = await json(res)
    expect(body.error?.code).toBe('attachment_type_mismatch')
    expect(body.error?.message).toContain('application/zip')
    expect(writes).toHaveLength(0)
  })

  describe('Office documents', () => {
    it('accepts a Word package written by a real toolchain, writing the bytes verbatim under the sniffed mime', async () => {
      const { write, writes } = recordingWriteAttachment()
      const route = createAttachmentUploadRoute({
        authorize: okAuthorize(),
        writeAttachment: write,
      })
      const bytes = realWorldOoxmlBytes('real-word.docx')
      // The browser reports nothing useful for an Office file on many
      // platforms, so the empty type is the realistic case, not a convenience.
      const res = await route(uploadRequest([fileOf(bytes, 'Master Services Agreement.docx', '')]))

      expect(res.status).toBe(200)
      const body = await res.json() as { files: ChatAttachmentInput[] }
      expect(body.files).toEqual([{
        path: 'Master-Services-Agreement.docx--test-1',
        name: 'Master-Services-Agreement.docx',
        size: bytes.length,
        mediaType: OOXML_WORD_MIME,
        kind: 'file',
      }])
      expect(Array.from(writes[0]!.content as Uint8Array)).toEqual(Array.from(bytes))
      expect(writes[0]!.opts.originalName).toBe('Master Services Agreement.docx')
    })

    it('accepts Excel and PowerPoint packages written by a real toolchain', async () => {
      const { write } = recordingWriteAttachment()
      const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })
      const res = await route(uploadRequest([
        fileOf(realWorldOoxmlBytes('real-excel.xlsx'), 'workpapers.xlsx', ''),
        fileOf(realWorldOoxmlBytes('real-powerpoint.pptx'), 'deck.pptx', ''),
      ]))

      expect(res.status).toBe(200)
      const body = await res.json() as { files: ChatAttachmentInput[] }
      expect(body.files.map((f) => f.mediaType)).toEqual([OOXML_SPREADSHEET_MIME, OOXML_PRESENTATION_MIME])
      expect(body.files.every((f) => f.kind === 'file')).toBe(true)
    })

    it('rejects an ordinary archive with 415, writing nothing', async () => {
      const { write, writes } = recordingWriteAttachment()
      const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })
      const res = await route(uploadRequest([fileOf(plainZipBytes(), 'archive.zip', 'application/zip')]))

      expect(res.status).toBe(415)
      const body = await json(res)
      expect(body.error?.code).toBe('attachment_type_not_allowed')
      expect(writes).toHaveLength(0)
    })

    it('rejects an ordinary archive renamed .docx with 400, writing nothing', async () => {
      const { write, writes } = recordingWriteAttachment()
      const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })
      const res = await route(uploadRequest([fileOf(plainZipBytes(), 'contract.docx', OOXML_WORD_MIME)]))

      expect(res.status).toBe(400)
      const body = await json(res)
      expect(body.error?.code).toBe('attachment_type_mismatch')
      expect(writes).toHaveLength(0)
    })

    it('rejects a macro-enabled package by default and accepts it when the route widens allowedSniffedMimes', async () => {
      const bytes = docxBytes({ macroEnabled: true })
      const { write, writes } = recordingWriteAttachment()
      const strict = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })
      const strictRes = await strict(uploadRequest([fileOf(bytes, 'macro.docm', '')]))
      expect(strictRes.status).toBe(415)
      expect((await json(strictRes)).error?.code).toBe('attachment_type_not_allowed')
      expect(writes).toHaveLength(0)

      const widened = createAttachmentUploadRoute({
        authorize: okAuthorize(),
        writeAttachment: write,
        allowedSniffedMimes: new Set([...ALLOWED_ATTACHMENT_SNIFFED_MIMES, ...MACRO_ENABLED_OOXML_SNIFFED_MIMES]),
      })
      const res = await widened(uploadRequest([fileOf(bytes, 'macro.docm', '')]))
      expect(res.status).toBe(200)
      const body = await res.json() as { files: ChatAttachmentInput[] }
      expect(body.files[0]).toMatchObject({ mediaType: OOXML_WORD_MACRO_ENABLED_MIME, kind: 'file' })
    })

    it('still rejects a Word package when the route narrows allowedSniffedMimes to PDF only', async () => {
      const { write, writes } = recordingWriteAttachment()
      const route = createAttachmentUploadRoute({
        authorize: okAuthorize(),
        writeAttachment: write,
        allowedSniffedMimes: new Set(['application/pdf']),
      })
      const res = await route(uploadRequest([fileOf(realWorldOoxmlBytes('real-word.docx'), 'contract.docx', '')]))

      expect(res.status).toBe(415)
      const body = await json(res)
      expect(body.error?.code).toBe('attachment_type_not_allowed')
      expect(writes).toHaveLength(0)
    })
  })

  it('rejects ID3/mp3-magic bytes as a disallowed attachment type (415)', async () => {
    const { write, writes } = recordingWriteAttachment()
    const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })
    const res = await route(uploadRequest([fileOf(id3Mp3Bytes(), 'track.mp3', 'audio/mpeg')]))

    expect(res.status).toBe(415)
    const body = await json(res)
    expect(body.error?.code).toBe('attachment_type_not_allowed')
    expect(writes).toHaveLength(0)
  })

  it('accepts real minimal PDF content named .pdf', async () => {
    const { write } = recordingWriteAttachment()
    const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })
    const res = await route(uploadRequest([fileOf(pdfBytes(), 'doc.pdf', 'application/pdf')]))

    expect(res.status).toBe(200)
    const body = await res.json() as { files: ChatAttachmentInput[] }
    expect(body.files[0]).toMatchObject({ mediaType: 'application/pdf', kind: 'file' })
  })

  it('accepts a genuine minimal AVIF (ftyp box with the avif brand)', async () => {
    const { write } = recordingWriteAttachment()
    const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })
    const res = await route(uploadRequest([fileOf(avifBytes(), 'photo.avif', 'image/avif')]))

    expect(res.status).toBe(200)
    const body = await res.json() as { files: ChatAttachmentInput[] }
    expect(body.files[0]).toMatchObject({ mediaType: 'image/avif', kind: 'image' })
  })

  it('stores an SVG as a binary "image" kind (byte-identity matters for image tooling)', async () => {
    const { write, writes } = recordingWriteAttachment()
    const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
    const res = await route(uploadRequest([fileOf(svg, 'logo.svg', 'image/svg+xml')]))

    expect(res.status).toBe(200)
    const body = await res.json() as { files: ChatAttachmentInput[] }
    expect(body.files[0]).toMatchObject({ mediaType: 'image/svg+xml', kind: 'image' })
    expect(new TextDecoder().decode(writes[0]!.content as Uint8Array)).toBe(svg)
  })

  describe('phase ordering: validate every file before writing any', () => {
    it('rejects a batch with a valid PNG followed by a disallowed mp3, writing neither', async () => {
      const { write, writes } = recordingWriteAttachment()
      const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })
      const files = [
        fileOf(pngBytes(), 'photo.png', 'image/png'),
        fileOf(id3Mp3Bytes(), 'track.mp3', 'audio/mpeg'),
      ]
      const res = await route(uploadRequest(files))

      expect(res.status).toBe(415)
      const body = await json(res)
      expect(body.error?.code).toBe('attachment_type_not_allowed')
      expect(writes).toHaveLength(0)
    })
  })

  describe('aggregate size cap', () => {
    it('rejects attachments whose combined authoritative size exceeds the aggregate cap, writing nothing', async () => {
      const chunk = 9 * 1024 * 1024
      const { write, writes } = recordingWriteAttachment()
      const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })
      const files = [
        fileOf(new Uint8Array(chunk).fill(0x41), 'a.txt', 'text/plain'),
        fileOf(new Uint8Array(chunk).fill(0x42), 'b.txt', 'text/plain'),
        fileOf(new Uint8Array(chunk).fill(0x43), 'c.txt', 'text/plain'),
      ]
      const res = await route(uploadRequest(files))

      expect(res.status).toBe(413)
      const body = await json(res)
      expect(body.error?.code).toBe('attachments_total_too_large')
      expect(writes).toHaveLength(0)
    })

    it('accepts attachments totaling exactly the aggregate cap', async () => {
      const { write } = recordingWriteAttachment()
      const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })
      const remainder = MAX_ATTACHMENT_TOTAL_BYTES - 2 * MAX_BINARY_ATTACHMENT_BYTES
      const files = [
        fileOf(pngBytesOfSize(MAX_BINARY_ATTACHMENT_BYTES), 'a.png', 'image/png'),
        fileOf(pngBytesOfSize(MAX_BINARY_ATTACHMENT_BYTES), 'b.png', 'image/png'),
        fileOf(pngBytesOfSize(remainder), 'c.png', 'image/png'),
      ]
      const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
      expect(totalBytes).toBe(MAX_ATTACHMENT_TOTAL_BYTES)

      const res = await route(uploadRequest(files))
      expect(res.status).toBe(200)
    })
  })

  describe('file count cap', () => {
    it('rejects more than the file-count cap with a typed error, writing nothing', async () => {
      const { write, writes } = recordingWriteAttachment()
      const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write, limits: { maxCount: 3 } })
      const files = Array.from({ length: 4 }, (_, i) => fileOf('x', `f${i}.txt`, 'text/plain'))
      const res = await route(uploadRequest(files))

      expect(res.status).toBe(400)
      const body = await json(res)
      expect(body.error?.code).toBe('attachment_count_exceeded')
      expect(writes).toHaveLength(0)
    })
  })

  it('rejects an oversized binary attachment with 413 and a machine-readable code', async () => {
    const big = new Uint8Array(MAX_BINARY_ATTACHMENT_BYTES + 1)
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    const { write, writes } = recordingWriteAttachment()
    const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })
    const res = await route(uploadRequest([fileOf(big, 'huge.png', 'image/png')]))

    expect(res.status).toBe(413)
    const body = await json(res)
    expect(body.error?.code).toBe('attachment_too_large')
    expect(body.error?.message).toContain('huge.png')
    expect(writes).toHaveLength(0)
  })

  it('applies a sniffed-mime size override while retaining the binary fallback cap', async () => {
    const fiftyMiB = 50 * 1024 * 1024
    const tenMiB = 10 * 1024 * 1024
    const { write, writes } = recordingWriteAttachment()
    const route = createAttachmentUploadRoute({
      authorize: okAuthorize(),
      writeAttachment: write,
      allowedSniffedMimes: new Set([...ALLOWED_ATTACHMENT_SNIFFED_MIMES, 'video/mp4']),
      limits: {
        maxBinaryBytes: tenMiB,
        maxBytesBySniffedMime: new Map([['video/mp4', 100 * 1024 * 1024]]),
        maxTotalBytes: 100 * 1024 * 1024,
      },
    })

    const video = await route(uploadRequest([fileOf(mp4BytesOfSize(fiftyMiB), 'clip.mp4', 'video/mp4')]))
    expect(video.status).toBe(200)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.opts.mediaType).toBe('video/mp4')

    const image = await route(uploadRequest([fileOf(pngBytesOfSize(fiftyMiB), 'still.png', 'image/png')]))
    expect(image.status).toBe(413)
    expect(await json(image)).toEqual({
      error: {
        code: 'attachment_too_large',
        message: 'still.png is 50MB; attachments are limited to 10MB',
      },
    })
    expect(writes).toHaveLength(1)
  })

  describe('allowedKinds override', () => {
    it("rejects a PNG with 415 attachment_kind_not_allowed when allowedKinds is ['file']", async () => {
      const { write, writes } = recordingWriteAttachment()
      const allowedKinds: ChatAttachmentKind[] = ['file']
      const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write, allowedKinds })
      const res = await route(uploadRequest([fileOf(pngBytes(), 'photo.png', 'image/png')]))

      expect(res.status).toBe(415)
      const body = await json(res)
      expect(body.error?.code).toBe('attachment_kind_not_allowed')
      expect(writes).toHaveLength(0)
    })
  })

  describe('duplicate path within a batch', () => {
    it('rejects two files that sanitize to the same store path with 400 attachment_duplicate_path', async () => {
      const { write, writes } = recordingWriteAttachment()
      const route = createAttachmentUploadRoute({
        authorize: okAuthorize(),
        writeAttachment: write,
      })
      const files = [
        fileOf('hello', 'notes.txt', 'text/plain'),
        fileOf('world', 'notes.txt', 'text/plain'),
      ]
      const res = await route(uploadRequest(files))

      expect(res.status).toBe(400)
      const body = await json(res)
      expect(body.error?.code).toBe('attachment_duplicate_path')
      expect(body.error?.path).toBe('notes.txt--test-2')
      expect(writes).toHaveLength(0)
    })
  })

  describe('response shape', () => {
    it('returns a full ChatAttachmentInput[] with every field present', async () => {
      const { write } = recordingWriteAttachment()
      const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })
      const bytes = pdfBytes()
      const res = await route(uploadRequest([fileOf(bytes, 'doc.pdf', 'application/pdf')]))

      expect(res.status).toBe(200)
      const body = await res.json() as { files: ChatAttachmentInput[] }
      expect(body.files).toHaveLength(1)
      const file = body.files[0]!
      expect(Object.keys(file).sort()).toEqual(['kind', 'mediaType', 'name', 'path', 'size'].sort())
      expect(file).toEqual({ path: 'doc.pdf--test-1', name: 'doc.pdf', size: bytes.length, mediaType: 'application/pdf', kind: 'file' })
    })
  })

  describe('authorize seam', () => {
    it('preserves the legacy writer contract without an ownership abort seam', async () => {
      const writes: string[] = []
      const write: WriteAttachmentFn = async (_scopeId, path) => {
        writes.push(path)
        return { ok: true }
      }
      const route = buildAttachmentUploadRoute({
        authorize: async () => ({ ok: true as const, scopeId: SCOPE }),
        writeAttachment: write,
      })

      const res = await route(uploadRequest([fileOf(pngBytes(), 'photo.png', 'image/png')]))

      expect(res.status).toBe(200)
      expect(writes).toEqual(['photo.png'])
    })

    it('returns a 401 auth.response verbatim', async () => {
      const denied = Response.json({ error: 'unauthorized' }, { status: 401 })
      const { write, writes } = recordingWriteAttachment()
      const route = createAttachmentUploadRoute({
        authorize: async () => ({ ok: false, response: denied }),
        writeAttachment: write,
      })
      const res = await route(uploadRequest([fileOf(pngBytes(), 'photo.png', 'image/png')]))

      expect(res).toBe(denied)
      expect(res.status).toBe(401)
      expect(writes).toHaveLength(0)
    })

    it('returns a 429 rate-limit auth.response verbatim, including Retry-After', async () => {
      const limited = Response.json(
        { error: 'rate limited' },
        { status: 429, headers: { 'Retry-After': '30' } },
      )
      const { write, writes } = recordingWriteAttachment()
      const route = createAttachmentUploadRoute({
        authorize: async () => ({ ok: false, response: limited }),
        writeAttachment: write,
      })
      const res = await route(uploadRequest([fileOf(pngBytes(), 'photo.png', 'image/png')]))

      expect(res).toBe(limited)
      expect(res.status).toBe(429)
      expect(res.headers.get('Retry-After')).toBe('30')
      expect(writes).toHaveLength(0)
    })

    it('routes writes through the scopeId authorize resolved', async () => {
      const { write, writes } = recordingWriteAttachment()
      const route = createAttachmentUploadRoute({ authorize: okAuthorize({ scopeId: 'tenant-42' }), writeAttachment: write })
      await route(uploadRequest([fileOf(pngBytes(), 'photo.png', 'image/png')]))

      expect(writes[0]!.scopeId).toBe('tenant-42')
    })

    it('prefers a per-request writeAttachment override from authorize over the option-level default', async () => {
      const { write: optionWrite, writes: optionWrites } = recordingWriteAttachment()
      const { write: authWrite, writes: authWrites } = recordingWriteAttachment()
      const route = createAttachmentUploadRoute({
        authorize: okAuthorize({ writeAttachment: authWrite }),
        writeAttachment: optionWrite,
      })
      await route(uploadRequest([fileOf(pngBytes(), 'photo.png', 'image/png')]))

      expect(authWrites).toHaveLength(1)
      expect(optionWrites).toHaveLength(0)
    })
  })

  describe('malformed request body', () => {
    it('rejects a non-multipart body with 400 invalid_upload', async () => {
      const { write } = recordingWriteAttachment()
      const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })
      const res = await route(new Request('http://app.test/api/attachments/upload', { method: 'POST', body: 'not a form' }))

      expect(res.status).toBe(400)
      const body = await json(res)
      expect(body.error?.code).toBe('invalid_upload')
    })

    it('rejects an empty multipart body with 400 invalid_upload', async () => {
      const { write } = recordingWriteAttachment()
      const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })
      const res = await route(new Request('http://app.test/api/attachments/upload', { method: 'POST', body: new FormData() }))

      expect(res.status).toBe(400)
      const body = await json(res)
      expect(body.error?.code).toBe('invalid_upload')
    })

    it('collects File entries regardless of field name', async () => {
      const { write, writes } = recordingWriteAttachment()
      const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })
      const res = await route(uploadRequest(
        [fileOf(pngBytes(), 'a.png', 'image/png'), fileOf(pdfBytes(), 'b.pdf', 'application/pdf')],
        ['image', 'document'],
      ))

      expect(res.status).toBe(200)
      expect(writes).toHaveLength(2)
    })
  })

  describe('write failure', () => {
    it('returns an opaque 503 for a storage rejection', async () => {
      const { write } = recordingWriteAttachment({ ok: false, reason: 'store quota exceeded' })
      const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })
      const res = await route(uploadRequest([fileOf(pngBytes(), 'photo.png', 'image/png')]))

      expect(res.status).toBe(503)
      const body = await json(res)
      expect(body.error?.code).toBe('attachment_store_unavailable')
      expect(body.error?.message).toBe('Attachment storage is temporarily unavailable. Please try again.')
      expect(body.error?.message).not.toContain('store quota')
    })

    it('compensates successful writes in reverse order after a later partial failure', async () => {
      const rollbackOrder: string[] = []
      const write: AtomicWriteAttachmentFn = async (_scopeId, path, _content, opts) => {
        const receipt = ownershipReceipt(opts.ownership, () => {
          rollbackOrder.push(path.split('--')[0]!)
        })
        if (path.startsWith('notes.txt--')) return { ok: false, reason: 'store quota exceeded', receipt }
        return {
          ok: true,
          receipt,
        }
      }
      const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })

      const res = await route(uploadRequest([
        fileOf(pngBytes(), 'photo.png', 'image/png'),
        fileOf(pdfBytes(), 'brief.pdf', 'application/pdf'),
        fileOf('notes', 'notes.txt', 'text/plain'),
      ]))

      expect(res.status).toBe(503)
      expect((await json(res)).error?.message).toBe('Attachment storage is temporarily unavailable. Please try again.')
      expect(rollbackOrder).toEqual(['notes.txt', 'brief.pdf', 'photo.png'])
    })

    it('compensates when a later write throws and redacts its credential-shaped message', async () => {
      const rollbackOrder: string[] = []
      const write: AtomicWriteAttachmentFn = async (_scopeId, path, _content, opts) => {
        if (path.startsWith('brief.pdf--')) throw new Error('upstream rejected Bearer super-secret-token')
        return {
          ok: true,
          receipt: ownershipReceipt(opts.ownership, () => {
            rollbackOrder.push(path.split('--')[0]!)
          }),
        }
      }
      const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })

      const res = await route(uploadRequest([
        fileOf(pngBytes(), 'photo.png', 'image/png'),
        fileOf(pdfBytes(), 'brief.pdf', 'application/pdf'),
      ]))

      expect(res.status).toBe(503)
      const message = (await json(res)).error?.message ?? ''
      expect(message).toBe('Attachment storage is temporarily unavailable. Please try again.')
      expect(message).not.toContain('super-secret-token')
      expect(rollbackOrder).toEqual(['photo.png'])
    })

    it('returns 503 when a writer throws a hostile value', async () => {
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
      const write: AtomicWriteAttachmentFn = async () => {
        throw hostile
      }
      const route = createAttachmentUploadRoute({
        authorize: okAuthorize(),
        writeAttachment: write,
        logger: { error: (...args: unknown[]) => logs.push(args) },
      })

      const res = await route(uploadRequest([fileOf(pngBytes(), 'photo.png', 'image/png')]))

      expect(res.status).toBe(503)
      expect(await json(res)).toEqual({
        error: {
          code: 'attachment_store_unavailable',
          message: 'Attachment storage is temporarily unavailable. Please try again.',
          path: 'photo.png--test-1',
        },
      })
      expect(JSON.stringify(logs)).toContain('unknown error')
    })

    it('fails closed when a writer returns a receipt for a different owner', async () => {
      let aborted: AttachmentWriteOwnership | undefined
      const write: AtomicWriteAttachmentFn = async (_scopeId, path, _content, opts) => {
        const wrongOwnership: AttachmentWriteOwnership = { id: 'wrong-owner', path: 'wrong-path' }
        const receipt: AttachmentWriteReceipt = {
          ownership: wrongOwnership,
          rollback: vi.fn(),
        }
        expect(path).toBe(opts.ownership.path)
        return { ok: true, receipt }
      }
      const route = createAttachmentUploadRoute({
        authorize: async () => ({
          ok: true as const,
          scopeId: SCOPE,
          abortAttachment: async (_scopeId, ownership) => {
            aborted = ownership
          },
        }),
        writeAttachment: write,
      })

      const res = await route(uploadRequest([fileOf(pngBytes(), 'photo.png', 'image/png')]))

      expect(res.status).toBe(503)
      expect((await json(res)).error?.message).toBe('Attachment storage is temporarily unavailable. Please try again.')
      expect(aborted).toEqual({ id: 'test-1', path: 'photo.png--test-1' })
    })

    it('cleans the current ambiguous object and prior objects with a stateful object-store adapter', async () => {
      const objects = new Map<string, { owner: string; bytes: Uint8Array }>()
      const logs: unknown[] = []
      const write: AtomicWriteAttachmentFn = async (_scopeId, path, content, opts) => {
        objects.set(path, { owner: opts.ownership.id, bytes: content as Uint8Array })
        const receipt = ownershipReceipt(opts.ownership, () => {
          const current = objects.get(path)
          if (current?.owner === opts.ownership.id) objects.delete(path)
        })
        if (path.startsWith('brief.pdf--')) throw new Error('R2 failed X-Amz-Signature=super-secret-signature')
        return { ok: true, receipt }
      }
      const abort: AbortAttachmentWriteFn = async (_scopeId, ownership) => {
        const current = objects.get(ownership.path)
        if (current?.owner === ownership.id) objects.delete(ownership.path)
      }
      const route = createAttachmentUploadRoute({
        authorize: async () => ({ ok: true as const, scopeId: SCOPE, abortAttachment: abort }),
        writeAttachment: write,
        logger: { error: (...args: unknown[]) => logs.push(args) },
      })

      const res = await route(uploadRequest([
        fileOf(pngBytes(), 'photo.png', 'image/png'),
        fileOf(pdfBytes(), 'brief.pdf', 'application/pdf'),
      ]))

      // Regression: a backend can commit before throwing; both object keys must
      // be gone, and the credential must exist only in sanitized server logs.
      expect(res.status).toBe(503)
      expect(objects.size).toBe(0)
      expect(JSON.stringify(logs)).not.toContain('super-secret-signature')
      expect(JSON.stringify(logs)).toContain('[REDACTED:credential]')
    })

    it('does not delete a newer overwrite during an older receipt rollback', async () => {
      const objects = new Map<string, { owner: string }>()
      const older: AttachmentWriteOwnership = { id: 'older', path: 'shared' }
      const newer: AttachmentWriteOwnership = { id: 'newer', path: 'shared' }
      objects.set(older.path, { owner: older.id })
      let rollbackReady!: () => void
      let allowRollbackCheck!: () => void
      const rollbackStarted = new Promise<void>((resolve) => {
        rollbackReady = resolve
      })
      const allowCheck = new Promise<void>((resolve) => {
        allowRollbackCheck = resolve
      })
      const olderReceipt = ownershipReceipt(older, async () => {
        rollbackReady()
        await allowCheck
        if (objects.get(older.path)?.owner === older.id) objects.delete(older.path)
      })

      const rollback = olderReceipt.rollback()
      await rollbackStarted
      objects.set(newer.path, { owner: newer.id })
      allowRollbackCheck()
      await rollback

      // Regression: rollback is compare-and-delete, not unconditional delete.
      expect(objects.get('shared')).toEqual({ owner: 'newer' })
    })

    it('aggregates all rollback failures, exposes only their count, and redacts their messages', async () => {
      const rollbackOrder: string[] = []
      const write: AtomicWriteAttachmentFn = async (_scopeId, path, _content, opts) => {
        if (path.startsWith('notes.txt--')) {
          return {
            ok: false,
            reason: 'secret=primary-token',
            receipt: ownershipReceipt(opts.ownership),
          }
        }
        return {
          ok: true,
          receipt: ownershipReceipt(opts.ownership, () => {
            rollbackOrder.push(path.split('--')[0]!)
            throw new Error(path.startsWith('brief.pdf--') ? 'apiKey=rollback-pdf-token' : 'Bearer rollback-png-token')
          }),
        }
      }
      const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })

      const res = await route(uploadRequest([
        fileOf(pngBytes(), 'photo.png', 'image/png'),
        fileOf(pdfBytes(), 'brief.pdf', 'application/pdf'),
        fileOf('notes', 'notes.txt', 'text/plain'),
      ]))

      expect(res.status).toBe(503)
      const message = (await json(res)).error?.message ?? ''
      expect(message).toBe('Attachment storage is temporarily unavailable. Please try again.')
      expect(message).not.toContain('primary-token')
      expect(message).not.toContain('rollback-pdf-token')
      expect(message).not.toContain('rollback-png-token')
      expect(rollbackOrder).toEqual(['brief.pdf', 'photo.png'])
    })

    it('does not compensate a successful batch', async () => {
      const rollback = vi.fn()
      const write: AtomicWriteAttachmentFn = async (_scopeId, _path, _content, opts) => ({
        ok: true,
        receipt: ownershipReceipt(opts.ownership, rollback),
      })
      const route = createAttachmentUploadRoute({ authorize: okAuthorize(), writeAttachment: write })

      const res = await route(uploadRequest([
        fileOf(pngBytes(), 'photo.png', 'image/png'),
        fileOf(pdfBytes(), 'brief.pdf', 'application/pdf'),
      ]))

      expect(res.status).toBe(200)
      expect(rollback).not.toHaveBeenCalled()
      expect((await res.json() as { files: ChatAttachmentInput[] }).files).toHaveLength(2)
    })
  })

  describe('pathFor / validatePath overrides', () => {
    it('prefixes the store path via pathFor', async () => {
      const { write, writes } = recordingWriteAttachment()
      const route = createAttachmentUploadRoute({
        authorize: okAuthorize(),
        writeAttachment: write,
        pathFor: (name) => `tenant-1/${name}`,
      })
      const res = await route(uploadRequest([fileOf(pngBytes(), 'photo.png', 'image/png')]))

      expect(res.status).toBe(200)
      const body = await res.json() as { files: ChatAttachmentInput[] }
      expect(body.files[0]!.path).toBe('tenant-1/photo.png--test-1')
      expect(writes[0]!.path).toBe('tenant-1/photo.png--test-1')
    })

    it('rejects with 400 invalid_attachment_path using the injected validator\'s message', async () => {
      const { write, writes } = recordingWriteAttachment()
      const route = createAttachmentUploadRoute({
        authorize: okAuthorize(),
        writeAttachment: write,
        validatePath: () => ({ succeeded: false, error: 'nope, not this path' }),
      })
      const res = await route(uploadRequest([fileOf(pngBytes(), 'photo.png', 'image/png')]))

      expect(res.status).toBe(400)
      const body = await json(res)
      expect(body.error?.code).toBe('invalid_attachment_path')
      expect(body.error?.message).toBe('nope, not this path')
      expect(writes).toHaveLength(0)
    })
  })
})
