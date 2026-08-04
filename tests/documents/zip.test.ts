/**
 * The zip reader's own guarantees, on real archives.
 *
 * Two of them exist because this reader shares its input with the upload
 * gate's reader (`src/chat-routes/binary-sniff.ts`) and runs on untrusted
 * bytes: the two must resolve the SAME archive, and neither may be talked into
 * an allocation the caller never budgeted for.
 */

import { describe, expect, it } from 'vitest'

import { sniffBinary, OOXML_WORD_MIME } from '../../src/chat-routes/binary-sniff'
import {
  DEFAULT_MAX_ZIP_ENTRY_BYTES,
  DOCX_MEDIA_TYPE,
  extractDocument,
  readZipDirectory,
  readZipEntry,
} from '../../src/documents'
import { buildDocx, buildZip, documentXml, paragraphs } from './fixtures'

/** Append a zip comment holding a decoy end-of-central-directory signature and
 *  extend the real record's comment length to cover it — the shape that splits
 *  a reader checking the comment length from one that does not. */
function withDecoyEndRecordInComment(archive: Uint8Array, commentBytes: number): Uint8Array {
  const comment = new Uint8Array(commentBytes)
  comment.set([0x50, 0x4b, 0x05, 0x06], 4)
  const out = new Uint8Array(archive.length + comment.length)
  out.set(archive, 0)
  out.set(comment, archive.length)
  out[archive.length - 2] = comment.length & 0xff
  out[archive.length - 1] = (comment.length >>> 8) & 0xff
  return out
}

/** Rewrite one central-directory entry's declared uncompressed size. The
 *  directory is the archive's own claim about itself, and a crafted archive
 *  lies in exactly this field. */
function withDeclaredUncompressedSize(archive: Uint8Array, entryName: string, size: number): Uint8Array {
  const out = new Uint8Array(archive)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  const encoded = new TextEncoder().encode(entryName)
  for (let cursor = 0; cursor + 46 <= out.byteLength; cursor++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) continue
    const nameLength = view.getUint16(cursor + 28, true)
    if (nameLength !== encoded.length) continue
    const name = new TextDecoder().decode(out.subarray(cursor + 46, cursor + 46 + nameLength))
    if (name !== entryName) continue
    view.setUint32(cursor + 24, size, true)
    return out
  }
  throw new Error(`no central-directory entry named '${entryName}'`)
}

describe('end-of-central-directory resolution', () => {
  it('resolves the same record the upload gate resolved, not a decoy in the comment', async () => {
    const genuine = buildDocx(paragraphs(['Master Services Agreement']))
    const crafted = withDecoyEndRecordInComment(genuine, 40)

    // The gate reads the archive and admits it as a Word package…
    expect(sniffBinary(crafted)).toEqual({ binary: true, mime: OOXML_WORD_MIME })

    // …so the extractor has to read the SAME archive. Resolving the decoy
    // record instead reports an empty package, and a comment filled with a
    // second central directory turns that into entries the gate never saw.
    const straight = readZipDirectory(genuine)
    const directory = readZipDirectory(crafted)
    expect(straight.succeeded && directory.succeeded).toBe(true)
    if (!straight.succeeded || !directory.succeeded) return
    expect(directory.value.map((entry) => entry.name)).toEqual(straight.value.map((entry) => entry.name))
    expect(directory.value.length).toBeGreaterThan(0)

    const extracted = await extractDocument(crafted, { mediaType: DOCX_MEDIA_TYPE, filename: 'contract.docx' })
    expect(extracted.succeeded).toBe(true)
    if (!extracted.succeeded) return
    expect(extracted.value.text).toContain('Master Services Agreement')
  })

  it('refuses an archive whose only end record does not account for its trailing bytes', () => {
    const genuine = buildDocx(paragraphs(['x']))
    // Bytes appended WITHOUT extending the comment length: the record no longer
    // describes the file, and guessing past that is what admits a crafted tail.
    const trailing = new Uint8Array(genuine.length + 8)
    trailing.set(genuine, 0)
    expect(readZipDirectory(trailing).succeeded).toBe(false)
  })
})

describe('decompression bounds', () => {
  const bombPart = 'word/document.xml'

  it('refuses an entry the directory declares over the per-entry limit, before inflating', async () => {
    const archive = withDeclaredUncompressedSize(
      buildDocx(paragraphs(['small'])),
      bombPart,
      DEFAULT_MAX_ZIP_ENTRY_BYTES + 1,
    )
    const directory = readZipDirectory(archive)
    expect(directory.succeeded).toBe(true)
    if (!directory.succeeded) return
    const entry = directory.value.find((candidate) => candidate.name === bombPart)
    expect(entry).toBeDefined()
    if (!entry) return

    const read = await readZipEntry(archive, entry)
    expect(read.succeeded).toBe(false)
    if (read.succeeded) return
    expect(read.error).toContain('over the')
    expect(read.error).toContain('per-entry limit')
  })

  it('stops a directory that UNDER-declares, mid-stream, rather than after the allocation', async () => {
    // 1 MiB of one repeated byte deflates to a few hundred bytes. The directory
    // declares the truth here — the cap is what refuses it — and the refusal
    // has to come from the streaming counter, since the declared size is only
    // as trustworthy as the archive.
    const payload = 'A'.repeat(1024 * 1024)
    const archive = buildZip([{ name: 'bomb.bin', content: payload }])
    const directory = readZipDirectory(archive)
    expect(directory.succeeded).toBe(true)
    if (!directory.succeeded) return
    const entry = directory.value[0]
    expect(entry).toBeDefined()
    if (!entry) return
    expect(archive.byteLength).toBeLessThan(8 * 1024)

    const capped = await readZipEntry(archive, entry, { maxUncompressedBytes: 64 * 1024 })
    expect(capped.succeeded).toBe(false)
    if (capped.succeeded) return
    expect(capped.error).toContain('per-entry limit')

    // A lying directory takes the same path: the declared size passes the
    // pre-check and the stream is cut anyway.
    const lying = withDeclaredUncompressedSize(archive, 'bomb.bin', 32 * 1024)
    const lyingEntry = (readZipDirectory(lying) as { succeeded: true; value: Array<typeof entry> }).value[0]
    expect(lyingEntry).toBeDefined()
    if (!lyingEntry) return
    const cut = await readZipEntry(lying, lyingEntry, { maxUncompressedBytes: 64 * 1024 })
    expect(cut.succeeded).toBe(false)
    if (cut.succeeded) return
    expect(cut.error).toContain('expands past')

    // …and the honest path still reads the whole entry.
    const full = await readZipEntry(archive, entry, { maxUncompressedBytes: 2 * 1024 * 1024 })
    expect(full.succeeded).toBe(true)
    if (!full.succeeded) return
    expect(full.value.byteLength).toBe(payload.length)
  })

  it('carries the cap into DOCX extraction, so a bomb is a typed error and not a crash', async () => {
    const big = 'B'.repeat(512 * 1024)
    const archive = buildZip([
      {
        name: '[Content_Types].xml',
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
        stored: true,
      },
      {
        name: '_rels/.rels',
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      },
      { name: bombPart, content: documentXml(paragraphs([big])) },
    ])

    const refused = await extractDocument(archive, {
      mediaType: DOCX_MEDIA_TYPE,
      filename: 'bomb.docx',
      maxUncompressedPartBytes: 64 * 1024,
    })
    expect(refused.succeeded).toBe(false)
    if (refused.succeeded) return
    expect(refused.error.code).toBe('malformed-archive')
    expect(refused.error.stage).toBe('extract')
    expect(refused.error.message).toContain('per-entry limit')

    // The same package under a cap that fits reads normally — the gate is the
    // size, not the shape.
    const allowed = await extractDocument(archive, { mediaType: DOCX_MEDIA_TYPE, filename: 'bomb.docx' })
    expect(allowed.succeeded).toBe(true)
    if (!allowed.succeeded) return
    expect(allowed.value.text).toContain('BBB')
  })
})
