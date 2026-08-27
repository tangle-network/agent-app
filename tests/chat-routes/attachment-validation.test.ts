import { describe, expect, it } from 'vitest'
import {
  ALLOWED_ATTACHMENT_SNIFFED_MIMES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  attachmentSizeErrorMessage,
  attachmentTotalSizeErrorMessage,
  checkAttachmentType,
  sanitizeAttachmentFileName,
} from '../../src/chat-routes/attachment-validation'
import { sniffBinary } from '../../src/chat-routes/binary-sniff'
import type { SniffResult } from '../../src/chat-routes/binary-sniff'

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

    it('rejects a zip-magic file (e.g. a renamed .docx)', () => {
      const result = checkAttachmentType('report.docx', sniff(true, 'application/zip'))
      expect(result.succeeded).toBe(false)
      if (result.succeeded) throw new Error('unreachable')
      expect(result.code).toBe('attachment_type_not_allowed')
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

describe('ALLOWED_ATTACHMENT_SNIFFED_MIMES', () => {
  it('contains every mime that checkAttachmentType treats as a valid extension match', () => {
    const impliedMimes = [
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/bmp',
      'image/tiff',
      'image/x-icon',
      'image/webp',
      'image/svg+xml',
      'application/pdf',
    ]
    for (const mime of impliedMimes) {
      expect(ALLOWED_ATTACHMENT_SNIFFED_MIMES.has(mime)).toBe(true)
    }
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
