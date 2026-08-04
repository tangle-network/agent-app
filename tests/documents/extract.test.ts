/**
 * The pipeline around the format-specific readers: the size gate, media-type
 * resolution, text passthrough, and the rule that a success never carries
 * empty text.
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MAX_DOCUMENT_BYTES,
  DOCM_MEDIA_TYPE,
  DOCX_MEDIA_TYPE,
  extractDocument,
  normalizeMediaType,
  PDF_MEDIA_TYPE,
  readZipDirectory,
  readZipEntry,
  resolveMediaType,
} from '../../src/documents'
import { buildDocx, buildZip, paragraphs } from './fixtures'

describe('size gate', () => {
  it('defaults to a 25 MB cap', () => {
    expect(DEFAULT_MAX_DOCUMENT_BYTES).toBe(25 * 1024 * 1024)
  })

  it('refuses a document over the caller-set cap before reading a byte of it', async () => {
    const outcome = await extractDocument(new Uint8Array(2048), {
      mediaType: 'text/plain',
      maxBytes: 1024,
      filename: 'big.txt',
    })
    expect(outcome.succeeded).toBe(false)
    if (outcome.succeeded) return
    expect(outcome.error.code).toBe('too-large')
    expect(outcome.error.stage).toBe('size-check')
    expect(outcome.error.message).toContain('1024-byte limit')
  })

  it('accepts a document at exactly the cap', async () => {
    const bytes = new TextEncoder().encode('0123456789')
    const outcome = await extractDocument(bytes, { mediaType: 'text/plain', maxBytes: bytes.byteLength })
    expect(outcome.succeeded).toBe(true)
  })

  it('refuses zero bytes as an empty document', async () => {
    const outcome = await extractDocument(new Uint8Array(0), { mediaType: 'text/plain' })
    expect(outcome.succeeded).toBe(false)
    if (!outcome.succeeded) expect(outcome.error.code).toBe('empty-document')
  })
})

describe('media type resolution', () => {
  it('strips parameters and case', () => {
    expect(normalizeMediaType('Text/Plain; charset=UTF-8')).toBe('text/plain')
  })

  it('maps the three supported families', () => {
    expect(resolveMediaType({ mediaType: PDF_MEDIA_TYPE })).toEqual({
      succeeded: true,
      value: { format: 'pdf', mediaType: PDF_MEDIA_TYPE },
    })
    expect(resolveMediaType({ mediaType: DOCX_MEDIA_TYPE })).toEqual({
      succeeded: true,
      value: { format: 'docx', mediaType: DOCX_MEDIA_TYPE },
    })
    expect(resolveMediaType({ mediaType: DOCM_MEDIA_TYPE })).toEqual({
      succeeded: true,
      value: { format: 'docx', mediaType: DOCM_MEDIA_TYPE },
    })
    expect(resolveMediaType({ mediaType: 'text/markdown' })).toEqual({
      succeeded: true,
      value: { format: 'text', mediaType: 'text/markdown' },
    })
  })

  it('falls back to the filename when a browser declares application/octet-stream', () => {
    const outcome = resolveMediaType({ mediaType: 'application/octet-stream', filename: 'Agreement.DOCX' })
    expect(outcome).toEqual({ succeeded: true, value: { format: 'docx', mediaType: DOCX_MEDIA_TYPE } })
  })

  it('prefers a declared type over the extension', () => {
    const outcome = resolveMediaType({ mediaType: PDF_MEDIA_TYPE, filename: 'mislabelled.txt' })
    expect(outcome).toEqual({ succeeded: true, value: { format: 'pdf', mediaType: PDF_MEDIA_TYPE } })
  })

  it('rejects legacy binary .doc with an instruction, not a zip parse error', () => {
    const outcome = resolveMediaType({ mediaType: 'application/msword', filename: 'old.doc' })
    expect(outcome.succeeded).toBe(false)
    if (outcome.succeeded) return
    expect(outcome.error.code).toBe('unsupported-media-type')
    expect(outcome.error.message).toContain('.docx')
  })

  it('rejects an unsupported type by name and lists what is supported', () => {
    const outcome = resolveMediaType({ mediaType: 'image/png' })
    expect(outcome.succeeded).toBe(false)
    if (outcome.succeeded) return
    expect(outcome.error.stage).toBe('media-type')
    expect(outcome.error.message).toContain('image/png')
    expect(outcome.error.message).toContain(DOCX_MEDIA_TYPE)
  })

  it('says so when nothing identifies the document', () => {
    const outcome = resolveMediaType({ filename: 'notes' })
    expect(outcome.succeeded).toBe(false)
    if (outcome.succeeded) return
    expect(outcome.error.message).toContain('no recognized extension')
  })
})

describe('text passthrough', () => {
  it('decodes UTF-8 and reports the canonical media type', async () => {
    const outcome = await extractDocument(new TextEncoder().encode('  Hello, world.  '), { mediaType: 'text/markdown' })
    expect(outcome.succeeded).toBe(true)
    if (!outcome.succeeded) return
    expect(outcome.value.text).toBe('Hello, world.')
    expect(outcome.value.format).toBe('text')
    expect(outcome.value.mediaType).toBe('text/markdown')
    expect(outcome.value.characterCount).toBe(13)
    expect(outcome.value.byteSize).toBe(17)
  })

  it('strips a UTF-8 byte-order mark', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Clause one.')])
    const outcome = await extractDocument(bytes, { mediaType: 'text/plain' })
    expect(outcome.succeeded).toBe(true)
    if (outcome.succeeded) expect(outcome.value.text).toBe('Clause one.')
  })

  it('fails loud on bytes that are not UTF-8 instead of producing mojibake', async () => {
    // 0x80 is a continuation byte with no lead byte: invalid UTF-8.
    const outcome = await extractDocument(new Uint8Array([0x41, 0x80, 0x42]), {
      mediaType: 'text/plain',
      filename: 'latin1.txt',
    })
    expect(outcome.succeeded).toBe(false)
    if (outcome.succeeded) return
    expect(outcome.error.code).toBe('decode-failed')
    expect(outcome.error.stage).toBe('decode')
    expect(outcome.error.message).toContain('UTF-8')
  })

  it('treats whitespace-only content as empty', async () => {
    const outcome = await extractDocument(new TextEncoder().encode('   \n\t  '), { mediaType: 'text/plain' })
    expect(outcome.succeeded).toBe(false)
    if (outcome.succeeded) return
    expect(outcome.error.code).toBe('empty-document')
    expect(outcome.error.stage).toBe('decode')
  })

  it('accepts an ArrayBuffer as readily as a Uint8Array', async () => {
    const bytes = new TextEncoder().encode('From an ArrayBuffer.')
    const outcome = await extractDocument(bytes.buffer.slice(0) as ArrayBuffer, { mediaType: 'text/plain' })
    expect(outcome.succeeded).toBe(true)
    if (outcome.succeeded) expect(outcome.value.text).toBe('From an ArrayBuffer.')
  })
})

describe('routing', () => {
  it('routes a .docx filename with no declared type to the DOCX reader', async () => {
    const outcome = await extractDocument(buildDocx(paragraphs(['Routed by extension.'])), {
      filename: 'agreement.docx',
    })
    expect(outcome.succeeded).toBe(true)
    if (!outcome.succeeded) return
    expect(outcome.value.format).toBe('docx')
    expect(outcome.value.text).toBe('Routed by extension.')
  })

  it('routes a .docm package through the same reader', async () => {
    const outcome = await extractDocument(buildDocx(paragraphs(['Macro-enabled body.'])), {
      mediaType: DOCM_MEDIA_TYPE,
    })
    expect(outcome.succeeded).toBe(true)
    if (outcome.succeeded) expect(outcome.value.text).toBe('Macro-enabled body.')
  })
})

describe('zip reader', () => {
  it('reads every central-directory entry with its sizes and method', () => {
    const bytes = buildZip([
      { name: 'stored.txt', content: 'plain', stored: true },
      { name: 'deflated.txt', content: 'x'.repeat(500) },
    ])
    const outcome = readZipDirectory(bytes)
    expect(outcome.succeeded).toBe(true)
    if (!outcome.succeeded) return
    expect(outcome.value.map((entry) => entry.name)).toEqual(['stored.txt', 'deflated.txt'])
    expect(outcome.value[0]?.compressionMethod).toBe(0)
    expect(outcome.value[1]?.compressionMethod).toBe(8)
    expect(outcome.value[1]?.uncompressedSize).toBe(500)
    expect(outcome.value[1]?.compressedSize).toBeLessThan(500)
  })

  it('refuses an encrypted entry rather than inflating garbage', async () => {
    const bytes = buildZip([{ name: 'secret.xml', content: 'confidential' }])
    const directory = readZipDirectory(bytes)
    expect(directory.succeeded).toBe(true)
    if (!directory.succeeded) return
    const outcome = await readZipEntry(bytes, { ...directory.value[0]!, encrypted: true })
    expect(outcome.succeeded).toBe(false)
    if (!outcome.succeeded) expect(outcome.error).toContain('encrypted')
  })

  it('refuses a compression method it cannot decode', async () => {
    const bytes = buildZip([{ name: 'lzma.xml', content: 'body' }])
    const directory = readZipDirectory(bytes)
    expect(directory.succeeded).toBe(true)
    if (!directory.succeeded) return
    const outcome = await readZipEntry(bytes, { ...directory.value[0]!, compressionMethod: 14 })
    expect(outcome.succeeded).toBe(false)
    if (!outcome.succeeded) expect(outcome.error).toContain('compression method 14')
  })

  it('refuses an entry whose declared size disagrees with what it inflated to', async () => {
    const bytes = buildZip([{ name: 'body.xml', content: 'the real body text' }])
    const directory = readZipDirectory(bytes)
    expect(directory.succeeded).toBe(true)
    if (!directory.succeeded) return
    const outcome = await readZipEntry(bytes, { ...directory.value[0]!, uncompressedSize: 9999 })
    expect(outcome.succeeded).toBe(false)
    if (!outcome.succeeded) expect(outcome.error).toContain('9999')
  })
})
