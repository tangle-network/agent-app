import { describe, expect, it } from 'vitest'
import {
  ALLOWED_ATTACHMENT_SNIFFED_MIMES,
  ATTACHMENT_ACCEPT,
  MACRO_ENABLED_OOXML_SNIFFED_MIMES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  attachmentSizeErrorMessage,
  attachmentTotalSizeErrorMessage,
  checkAttachmentType,
  sanitizeAttachmentFileName,
} from '../../src/chat-routes/attachment-validation'
import {
  OOXML_PRESENTATION_MIME,
  OOXML_SPREADSHEET_MIME,
  OOXML_WORD_MACRO_ENABLED_MIME,
  OOXML_WORD_MIME,
  sniffBinary,
} from '../../src/chat-routes/binary-sniff'
import type { SniffResult } from '../../src/chat-routes/binary-sniff'
import { docxBytes, plainZipBytes, pptxBytes, realWorldOoxmlBytes, xlsxBytes } from './ooxml-fixtures'

// Port of gtm-agent's `src/lib/attachment-limits.test.ts` (checkAttachmentType
// cases) plus real magic-byte fixtures ported from `api.vault.upload.test.ts`,
// so the type gate is exercised against genuine sniffed content, not a
// hand-built SniffResult alone.

function sniff(binary: boolean, mime: string | null): SniffResult {
  return { binary, mime }
}

function ascii(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0))
}

/** Real PNG signature (magic bytes only — pixel data is irrelevant to the
 *  sniffer, which matches at a fixed offset). */
function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
}

/** Real minimal PDF header. */
function pdfBytes(): Uint8Array {
  return new TextEncoder().encode('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<< >>\nendobj\n')
}

/** Real ID3v2 MP3 header: version byte < 0x10, sync-safe size bytes each < 0x80. */
function mp3Bytes(): Uint8Array {
  return new Uint8Array([...ascii('ID3'), 0x03, 0x00, 0x00, 0x00, 0x00, 0x02, 0x01])
}

/** Real minimal ISO-BMFF ftyp box carrying the `avif` major brand. */
function avifBytes(): Uint8Array {
  return new Uint8Array([0, 0, 0, 0x1c, ...ascii('ftyp'), ...ascii('avif')])
}

describe('checkAttachmentType', () => {
  describe('matching extension and content', () => {
    const cases: Array<[string, string]> = [
      ['photo.png', 'image/png'],
      ['photo.jpg', 'image/jpeg'],
      ['photo.jpeg', 'image/jpeg'],
      ['photo.gif', 'image/gif'],
      ['photo.bmp', 'image/bmp'],
      ['photo.tif', 'image/tiff'],
      ['photo.tiff', 'image/tiff'],
      ['favicon.ico', 'image/x-icon'],
      ['photo.webp', 'image/webp'],
      ['diagram.svg', 'image/svg+xml'],
      ['invoice.pdf', 'application/pdf'],
    ]

    for (const [name, mime] of cases) {
      it(`accepts ${name} when content sniffs as ${mime}`, () => {
        expect(checkAttachmentType(name, sniff(true, mime))).toEqual({ succeeded: true })
      })
    }
  })

  describe('renamed-file attack: mismatched extension and content', () => {
    it('rejects real PNG bytes named .pdf', () => {
      const result = checkAttachmentType('invoice.pdf', sniffBinary(pngBytes()))
      expect(result.succeeded).toBe(false)
      if (result.succeeded) throw new Error('unreachable')
      expect(result.code).toBe('attachment_type_mismatch')
      expect(result.message).toContain('.pdf')
      expect(result.message).toContain('image/png')
    })

    it('rejects JPEG content named .png', () => {
      const result = checkAttachmentType('photo.png', sniff(true, 'image/jpeg'))
      expect(result.succeeded).toBe(false)
      if (result.succeeded) throw new Error('unreachable')
      expect(result.code).toBe('attachment_type_mismatch')
    })
  })

  describe('genuine files accepted via the real sniffer', () => {
    it('accepts a genuine PDF', () => {
      expect(checkAttachmentType('invoice.pdf', sniffBinary(pdfBytes()))).toEqual({ succeeded: true })
    })

    it('accepts a genuine AVIF (no extension-implied mime; rides the allowlist)', () => {
      expect(checkAttachmentType('photo.avif', sniffBinary(avifBytes()))).toEqual({ succeeded: true })
    })
  })

  describe('Office documents (the formats professionals actually send)', () => {
    it('accepts a Word package written by a real toolchain', () => {
      expect(checkAttachmentType('contract.docx', sniffBinary(realWorldOoxmlBytes('real-word.docx')))).toEqual({ succeeded: true })
    })

    it('accepts Excel and PowerPoint packages written by a real toolchain', () => {
      expect(checkAttachmentType('workpapers.xlsx', sniffBinary(realWorldOoxmlBytes('real-excel.xlsx')))).toEqual({ succeeded: true })
      expect(checkAttachmentType('deck.pptx', sniffBinary(realWorldOoxmlBytes('real-powerpoint.pptx')))).toEqual({ succeeded: true })
    })

    it('rejects an ordinary archive renamed .docx, naming the extension and what the content really is', () => {
      const result = checkAttachmentType('contract.docx', sniffBinary(plainZipBytes()))
      expect(result.succeeded).toBe(false)
      if (result.succeeded) throw new Error('unreachable')
      expect(result.code).toBe('attachment_type_mismatch')
      expect(result.message).toContain('.docx')
      expect(result.message).toContain('application/zip')
    })

    it('rejects a genuine Word package renamed .xlsx', () => {
      const result = checkAttachmentType('workpapers.xlsx', sniffBinary(docxBytes()))
      expect(result.succeeded).toBe(false)
      if (result.succeeded) throw new Error('unreachable')
      expect(result.code).toBe('attachment_type_mismatch')
      expect(result.message).toContain(OOXML_WORD_MIME)
    })

    it('rejects a macro-enabled package by default, under its own extension', () => {
      const result = checkAttachmentType('contract.docm', sniffBinary(docxBytes({ macroEnabled: true })))
      expect(result.succeeded).toBe(false)
      if (result.succeeded) throw new Error('unreachable')
      expect(result.code).toBe('attachment_type_not_allowed')
      expect(result.message).toContain(OOXML_WORD_MACRO_ENABLED_MIME)
    })

    it('rejects a macro-enabled package renamed .docx as a mismatch, so the VBA project cannot ride in as a plain document', () => {
      const result = checkAttachmentType('contract.docx', sniffBinary(docxBytes({ macroEnabled: true })))
      expect(result.succeeded).toBe(false)
      if (result.succeeded) throw new Error('unreachable')
      expect(result.code).toBe('attachment_type_mismatch')
    })

    it('accepts a macro-enabled package once a product widens the allow-list with MACRO_ENABLED_OOXML_SNIFFED_MIMES', () => {
      const widened = new Set([...ALLOWED_ATTACHMENT_SNIFFED_MIMES, ...MACRO_ENABLED_OOXML_SNIFFED_MIMES])
      expect(checkAttachmentType('contract.docm', sniffBinary(docxBytes({ macroEnabled: true })), widened)).toEqual({ succeeded: true })
    })

    it('rejects every Office package when a product narrows the allow-list to PDF only', () => {
      const pdfOnly = new Set(['application/pdf'])
      for (const [name, bytes] of [['contract.docx', docxBytes()], ['workpapers.xlsx', xlsxBytes()], ['deck.pptx', pptxBytes()]] as const) {
        const result = checkAttachmentType(name, sniffBinary(bytes), pdfOnly)
        expect(result.succeeded).toBe(false)
        if (result.succeeded) throw new Error('unreachable')
        expect(result.code).toBe('attachment_type_not_allowed')
      }
    })
  })

  describe('ISO-BMFF image brands (avif/heic/heif have no implied extension mime)', () => {
    it('accepts AVIF content under an extension with no implied mime', () => {
      expect(checkAttachmentType('photo.dat', sniffBinary(avifBytes()))).toEqual({ succeeded: true })
    })

    it('rejects MP4 content named .avif (no extension-implied mime to catch it early, but the allowlist still rejects video/mp4)', () => {
      const result = checkAttachmentType('movie.avif', sniff(true, 'video/mp4'))
      expect(result.succeeded).toBe(false)
      if (result.succeeded) throw new Error('unreachable')
      expect(result.code).toBe('attachment_type_not_allowed')
    })
  })

  describe('disallowed sniffed content', () => {
    it('rejects a real mp3 (disallowed sniffed mime, not just a synthetic one)', () => {
      const result = checkAttachmentType('track.mp3', sniffBinary(mp3Bytes()))
      expect(result.succeeded).toBe(false)
      if (result.succeeded) throw new Error('unreachable')
      expect(result.code).toBe('attachment_type_not_allowed')
    })

    it('rejects an ordinary archive under its own name', () => {
      const result = checkAttachmentType('archive.zip', sniffBinary(plainZipBytes()))
      expect(result.succeeded).toBe(false)
      if (result.succeeded) throw new Error('unreachable')
      expect(result.code).toBe('attachment_type_not_allowed')
      expect(result.message).toContain('application/zip')
    })

    it('rejects unrecognized binary content with no sniffed mime', () => {
      const result = checkAttachmentType('mystery.bin', sniff(true, null))
      expect(result.succeeded).toBe(false)
      if (result.succeeded) throw new Error('unreachable')
      expect(result.code).toBe('attachment_type_not_allowed')
      expect(result.message).toContain('mystery.bin')
    })
  })

  describe('text content', () => {
    it('always succeeds regardless of extension', () => {
      expect(checkAttachmentType('notes.txt', sniff(false, null))).toEqual({ succeeded: true })
      expect(checkAttachmentType('data.json', sniff(false, null))).toEqual({ succeeded: true })
      expect(checkAttachmentType('report.pdf', sniff(false, null))).toEqual({ succeeded: true })
    })
  })

  describe('custom allowed-mime override', () => {
    it('rejects a genuine PDF when the caller narrows the allowlist to images only', () => {
      const imagesOnly = new Set(['image/png', 'image/jpeg'])
      const result = checkAttachmentType('invoice.pdf', sniffBinary(pdfBytes()), imagesOnly)
      expect(result.succeeded).toBe(false)
      if (result.succeeded) throw new Error('unreachable')
      expect(result.code).toBe('attachment_type_not_allowed')
    })

    it('accepts an otherwise-disallowed mime when the caller widens the allowlist', () => {
      const withMp3 = new Set([...ALLOWED_ATTACHMENT_SNIFFED_MIMES, 'audio/mpeg'])
      expect(checkAttachmentType('track.mp3', sniffBinary(mp3Bytes()), withMp3)).toEqual({ succeeded: true })
    })

    it('defaults to ALLOWED_ATTACHMENT_SNIFFED_MIMES when no override is given', () => {
      expect(checkAttachmentType('photo.png', sniffBinary(pngBytes()))).toEqual({ succeeded: true })
    })
  })
})

/**
 * The invariant the allow-list's own doc comment states: its values must match
 * `sniffBinary`'s output strings verbatim, or every upload of that format
 * fails the gate — a typo in a mime string is invisible until a customer's
 * file is rejected. Locking it needs real bytes of every listed format, so
 * this table IS the lock: one entry per allowed mime, sniffed for real.
 */
const ALLOWED_MIME_FIXTURES: ReadonlyArray<{ mime: string; fileName: string; bytes: Uint8Array }> = [
  { mime: 'image/png', fileName: 'photo.png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]) },
  { mime: 'image/jpeg', fileName: 'photo.jpg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]) },
  { mime: 'image/gif', fileName: 'photo.gif', bytes: new Uint8Array([...ascii('GIF89a'), 0, 0]) },
  { mime: 'image/bmp', fileName: 'photo.bmp', bytes: new Uint8Array([...ascii('BM'), 0x46, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0]) },
  { mime: 'image/tiff', fileName: 'scan.tiff', bytes: new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0, 0]) },
  { mime: 'image/x-icon', fileName: 'favicon.ico', bytes: new Uint8Array([0x00, 0x00, 0x01, 0x00, 0, 0]) },
  { mime: 'image/webp', fileName: 'photo.webp', bytes: new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), 0, 0]) },
  { mime: 'image/svg+xml', fileName: 'logo.svg', bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>') },
  { mime: 'image/avif', fileName: 'photo.avif', bytes: avifBytes() },
  { mime: 'image/heic', fileName: 'photo.heic', bytes: new Uint8Array([0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii('heic')]) },
  { mime: 'image/heif', fileName: 'photo.heif', bytes: new Uint8Array([0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii('mif1')]) },
  { mime: 'application/pdf', fileName: 'invoice.pdf', bytes: pdfBytes() },
  { mime: OOXML_WORD_MIME, fileName: 'contract.docx', bytes: realWorldOoxmlBytes('real-word.docx') },
  { mime: OOXML_SPREADSHEET_MIME, fileName: 'workpapers.xlsx', bytes: realWorldOoxmlBytes('real-excel.xlsx') },
  { mime: OOXML_PRESENTATION_MIME, fileName: 'deck.pptx', bytes: realWorldOoxmlBytes('real-powerpoint.pptx') },
]

/** Accept-list extensions that carry no magic bytes and ride the plain-UTF-8
 *  gate instead (the allow-list's doc comment calls these out by name). */
const TEXT_ACCEPT_EXTENSIONS = new Set(['txt', 'md', 'csv', 'json', 'yaml', 'yml', 'html'])

describe('ATTACHMENT_ACCEPT / sniffBinary / ALLOWED_ATTACHMENT_SNIFFED_MIMES stay in sync', () => {
  it('lists exactly the mimes real content can produce — no unreachable entry, no missing fixture', () => {
    expect(new Set(ALLOWED_MIME_FIXTURES.map((f) => f.mime))).toEqual(new Set(ALLOWED_ATTACHMENT_SNIFFED_MIMES))
  })

  for (const fixture of ALLOWED_MIME_FIXTURES) {
    it(`sniffs real ${fixture.mime} content to that exact string, and the gate accepts it`, () => {
      expect(sniffBinary(fixture.bytes)).toEqual({ binary: true, mime: fixture.mime })
      expect(checkAttachmentType(fixture.fileName, sniffBinary(fixture.bytes))).toEqual({ succeeded: true })
    })
  }

  it('offers no file-picker extension the gate would then reject', () => {
    const textBytes = new TextEncoder().encode('plain content, no magic bytes\n')
    const patterns = ATTACHMENT_ACCEPT.split(',').map((p) => p.trim()).filter((p) => p.length > 0)
    expect(patterns).toContain('image/*')
    for (const pattern of patterns) {
      if (!pattern.startsWith('.')) continue
      const extension = pattern.slice(1)
      if (TEXT_ACCEPT_EXTENSIONS.has(extension)) {
        expect(checkAttachmentType(`file.${extension}`, sniffBinary(textBytes))).toEqual({ succeeded: true })
        continue
      }
      const fixture = ALLOWED_MIME_FIXTURES.find((f) => f.fileName.endsWith(`.${extension}`))
      expect(fixture, `ATTACHMENT_ACCEPT offers .${extension} with no fixture proving it uploads`).toBeDefined()
      expect(ALLOWED_ATTACHMENT_SNIFFED_MIMES.has(sniffBinary(fixture!.bytes).mime ?? '')).toBe(true)
      expect(checkAttachmentType(`file.${extension}`, sniffBinary(fixture!.bytes))).toEqual({ succeeded: true })
    }
  })

  it('offers a picker extension for every non-image format the gate admits', () => {
    // Images ride the `image/*` pattern, so only the document formats need an
    // extension of their own — a format the gate accepts but the picker never
    // offers is reachable by drag-and-drop and invisible in the file dialog.
    for (const fixture of ALLOWED_MIME_FIXTURES) {
      if (fixture.mime.startsWith('image/')) continue
      const extension = fixture.fileName.split('.').pop()
      expect(ATTACHMENT_ACCEPT.split(',').map((p) => p.trim()), `${fixture.mime} is admitted but .${extension} is not offered`)
        .toContain(`.${extension}`)
    }
  })

  it('keeps the macro-enabled Office mimes OUT of the default allow-list', () => {
    for (const mime of MACRO_ENABLED_OOXML_SNIFFED_MIMES) {
      expect(ALLOWED_ATTACHMENT_SNIFFED_MIMES.has(mime)).toBe(false)
    }
    expect(ATTACHMENT_ACCEPT).not.toContain('.docm')
  })
})

describe('sanitizeAttachmentFileName', () => {
  it('preserves an already-safe name', () => {
    expect(sanitizeAttachmentFileName('report_v2.final-draft.pdf')).toBe('report_v2.final-draft.pdf')
  })

  it('collapses unsupported characters (spaces, punctuation, unicode) to a single dash', () => {
    expect(sanitizeAttachmentFileName('my report (final)!.pdf')).toBe('my-report-final-.pdf')
    expect(sanitizeAttachmentFileName('café résumé.pdf')).toBe('caf-r-sum-.pdf')
  })

  it('strips leading dots and dashes so the name cannot read as a hidden segment', () => {
    expect(sanitizeAttachmentFileName('.hidden')).toBe('hidden')
    expect(sanitizeAttachmentFileName('-leading-dash.txt')).toBe('leading-dash.txt')
    expect(sanitizeAttachmentFileName('..--report.txt')).toBe('report.txt')
  })

  it('trims surrounding whitespace before sanitizing', () => {
    expect(sanitizeAttachmentFileName('  report.pdf  ')).toBe('report.pdf')
  })

  it('falls back to "file" when sanitization empties the name', () => {
    expect(sanitizeAttachmentFileName('...')).toBe('file')
    expect(sanitizeAttachmentFileName('')).toBe('file')
    expect(sanitizeAttachmentFileName('   ')).toBe('file')
  })
})

describe('error message wording (byte-identical to gtm)', () => {
  it('attachmentSizeErrorMessage matches gtm wording exactly', () => {
    expect(attachmentSizeErrorMessage('photo.png', 12 * 1024 * 1024, 10 * 1024 * 1024)).toBe(
      'photo.png is 12MB; attachments are limited to 10MB',
    )
    expect(attachmentSizeErrorMessage('notes.txt', 512, 1024)).toBe(
      'notes.txt is 512B; attachments are limited to 1KB',
    )
  })

  it('attachmentTotalSizeErrorMessage matches gtm wording exactly', () => {
    expect(attachmentTotalSizeErrorMessage(25 * 1024 * 1024, 25 * 1024 * 1024)).toBe(
      'Attachments total 25MB; each message is limited to 25MB',
    )
    expect(attachmentTotalSizeErrorMessage(512, 1024)).toBe(
      'Attachments total 512B; each message is limited to 1KB',
    )
    expect(attachmentTotalSizeErrorMessage(MAX_ATTACHMENT_TOTAL_BYTES + 1, MAX_ATTACHMENT_TOTAL_BYTES)).toBe(
      'Attachments total 25MB 1B; each message is limited to 25MB',
    )
  })
})
