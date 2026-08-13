import { describe, expect, it } from 'vitest'
import {
  OOXML_PRESENTATION_MACRO_ENABLED_MIME,
  OOXML_PRESENTATION_MIME,
  OOXML_SPREADSHEET_MACRO_ENABLED_MIME,
  OOXML_SPREADSHEET_MIME,
  OOXML_WORD_MACRO_ENABLED_MIME,
  OOXML_WORD_MIME,
  sniffBinary,
} from '../../src/chat-routes/binary-sniff'
import {
  buildZip,
  docxBytes,
  opcPackageWithoutOfficeMainPart,
  plainZipBytes,
  pptxBytes,
  realWorldOoxmlBytes,
  xlsxBytes,
  zipNamedLikeAnOfficePackage,
  zipWithUnparseableStoredContentTypes,
  zipWithWordPartsButNoContentTypes,
} from './ooxml-fixtures'

// Port of gtm-agent's `tests/binary-sniff.test.ts` — byte-identical fixtures,
// same magic-byte families plus the fatal-UTF-8/SVG-text-is-binary edge cases.

function bytes(values: number[]): Uint8Array {
  return new Uint8Array(values)
}

function ascii(text: string, extra: number[] = []): Uint8Array {
  return new Uint8Array([...Array.from(text, (c) => c.charCodeAt(0)), ...extra])
}

/** Minimal EBML header with a version element before DocType, matching the
 *  structure real WebM/Matroska files put at the start of the container. */
function ebmlBytes(docType: string): Uint8Array {
  const docTypeBytes = Array.from(docType, (character) => character.charCodeAt(0))
  const payload = [0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x80 | docTypeBytes.length, ...docTypeBytes]
  return bytes([0x1a, 0x45, 0xdf, 0xa3, 0x80 | payload.length, ...payload])
}

describe('sniffBinary', () => {
  it('detects PNG', () => {
    expect(sniffBinary(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toEqual({
      binary: true,
      mime: 'image/png',
    })
  })

  it('detects JPEG', () => {
    expect(sniffBinary(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toEqual({ binary: true, mime: 'image/jpeg' })
  })

  it('detects GIF', () => {
    expect(sniffBinary(ascii('GIF89a', [0, 0]))).toEqual({ binary: true, mime: 'image/gif' })
  })

  it('detects WebP via RIFF container', () => {
    const riff = new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), 0, 0])
    expect(sniffBinary(riff)).toEqual({ binary: true, mime: 'image/webp' })
  })

  it('detects WAV via RIFF container', () => {
    const riff = new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE'), 0, 0])
    expect(sniffBinary(riff)).toEqual({ binary: true, mime: 'audio/wav' })
  })

  it('detects BMP', () => {
    // BM + file size (4 bytes) + reserved bytes 6-9 (must be zero) + pixel offset
    expect(sniffBinary(ascii('BM', [0x46, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0x36, 0x00, 0x00, 0x00]))).toEqual({
      binary: true,
      mime: 'image/bmp',
    })
  })

  it('does not classify prose starting with BM as BMP', () => {
    expect(sniffBinary(ascii('BMW annual report, 2026 edition'))).toEqual({ binary: false, mime: null })
  })

  it('detects TIFF little-endian', () => {
    expect(sniffBinary(bytes([0x49, 0x49, 0x2a, 0x00, 0, 0]))).toEqual({ binary: true, mime: 'image/tiff' })
  })

  it('detects TIFF big-endian', () => {
    expect(sniffBinary(bytes([0x4d, 0x4d, 0x00, 0x2a, 0, 0]))).toEqual({ binary: true, mime: 'image/tiff' })
  })

  it('detects ICO', () => {
    expect(sniffBinary(bytes([0x00, 0x00, 0x01, 0x00, 0, 0]))).toEqual({ binary: true, mime: 'image/x-icon' })
  })

  it('detects PDF', () => {
    expect(sniffBinary(ascii('%PDF-1.7'))).toEqual({ binary: true, mime: 'application/pdf' })
  })

  it('reports a bare zip signature with no central directory as application/zip', () => {
    expect(sniffBinary(bytes([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toEqual({ binary: true, mime: 'application/zip' })
  })

  describe('OOXML packages (every one is a PKZIP container, so the zip signature decides nothing)', () => {
    it('identifies a Word package written by a real toolchain (pandoc)', () => {
      expect(sniffBinary(realWorldOoxmlBytes('real-word.docx'))).toEqual({ binary: true, mime: OOXML_WORD_MIME })
    })

    it('identifies an Excel package written by a real toolchain (LibreOffice Calc)', () => {
      expect(sniffBinary(realWorldOoxmlBytes('real-excel.xlsx'))).toEqual({ binary: true, mime: OOXML_SPREADSHEET_MIME })
    })

    it('identifies a PowerPoint package written by a real toolchain (pandoc)', () => {
      expect(sniffBinary(realWorldOoxmlBytes('real-powerpoint.pptx'))).toEqual({ binary: true, mime: OOXML_PRESENTATION_MIME })
    })

    it('identifies a Word package whose content-types part is deflated, from its part names', () => {
      expect(sniffBinary(docxBytes())).toEqual({ binary: true, mime: OOXML_WORD_MIME })
    })

    it('identifies a Word package whose content-types part is stored, from its declared content types', () => {
      expect(sniffBinary(docxBytes({ storedContentTypes: true }))).toEqual({ binary: true, mime: OOXML_WORD_MIME })
    })

    it('identifies Excel and PowerPoint packages', () => {
      expect(sniffBinary(xlsxBytes())).toEqual({ binary: true, mime: OOXML_SPREADSHEET_MIME })
      expect(sniffBinary(pptxBytes())).toEqual({ binary: true, mime: OOXML_PRESENTATION_MIME })
    })

    it('reports a macro-enabled package under its own mime, never the plain document one', () => {
      expect(sniffBinary(docxBytes({ macroEnabled: true }))).toEqual({ binary: true, mime: OOXML_WORD_MACRO_ENABLED_MIME })
      expect(sniffBinary(xlsxBytes({ macroEnabled: true }))).toEqual({ binary: true, mime: OOXML_SPREADSHEET_MACRO_ENABLED_MIME })
      expect(sniffBinary(pptxBytes({ macroEnabled: true }))).toEqual({ binary: true, mime: OOXML_PRESENTATION_MACRO_ENABLED_MIME })
    })

    it('reports a macro-enabled package from its declared content types when they are readable', () => {
      expect(sniffBinary(docxBytes({ macroEnabled: true, storedContentTypes: true }))).toEqual({
        binary: true,
        mime: OOXML_WORD_MACRO_ENABLED_MIME,
      })
    })

    it('reports the macro-enabled mime for a VBA project a readable declaration calls a plain document', () => {
      // The package DECLARES the plain main-part type and ships
      // `word/vbaProject.bin`. A reader that returns on the declaration before
      // scanning for the part admits this under the plain mime, which the
      // default allow-list accepts — the invariant this module states.
      for (const stored of [true, false]) {
        expect(sniffBinary(docxBytes({ vbaPartWithPlainDeclaration: true, storedContentTypes: stored }))).toEqual({
          binary: true,
          mime: OOXML_WORD_MACRO_ENABLED_MIME,
        })
        expect(sniffBinary(xlsxBytes({ vbaPartWithPlainDeclaration: true, storedContentTypes: stored }))).toEqual({
          binary: true,
          mime: OOXML_SPREADSHEET_MACRO_ENABLED_MIME,
        })
        expect(sniffBinary(pptxBytes({ vbaPartWithPlainDeclaration: true, storedContentTypes: stored }))).toEqual({
          binary: true,
          mime: OOXML_PRESENTATION_MACRO_ENABLED_MIME,
        })
      }
    })

    it('is not steered off the macro-enabled reading by a decoy plain-document Override', () => {
      // The content-types part is matched as one string, so a second Override
      // declaring the plain main-part type is indistinguishable from the real
      // one. The macro-enabled reading has to win regardless of which order
      // the types are compared in.
      const decoyed = docxBytes({
        macroEnabled: true,
        storedContentTypes: true,
        extraContentTypeOverrides: [
          ['/word/decoy.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
        ],
      })
      expect(sniffBinary(decoyed)).toEqual({ binary: true, mime: OOXML_WORD_MACRO_ENABLED_MIME })
    })

    it('identifies a Word package whose main part was renamed by a repair or a converter', () => {
      // `word/document2.xml` is what a repaired Word file carries; the package
      // is still a Word document and must not be refused over a part name.
      const renamed = docxBytes({ mainPartSuffix: '2' })
      expect(sniffBinary(renamed)).toEqual({ binary: true, mime: OOXML_WORD_MIME })
    })

    it('keeps an ordinary archive as application/zip', () => {
      expect(sniffBinary(plainZipBytes())).toEqual({ binary: true, mime: 'application/zip' })
    })

    it('keeps an archive carrying Word parts but no OPC content-types part as application/zip', () => {
      expect(sniffBinary(zipWithWordPartsButNoContentTypes())).toEqual({ binary: true, mime: 'application/zip' })
    })

    it('keeps an OPC package that is not a Word/Excel/PowerPoint document as application/zip', () => {
      expect(sniffBinary(opcPackageWithoutOfficeMainPart())).toEqual({ binary: true, mime: 'application/zip' })
    })

    it('keeps an archive that only borrowed the Office entry NAMES as application/zip', () => {
      // Two zero-cost named entries plus an arbitrary payload. The OPC
      // package-relationships part is the structural evidence this craft does
      // not carry.
      expect(sniffBinary(zipNamedLikeAnOfficePackage())).toEqual({ binary: true, mime: 'application/zip' })
      expect(sniffBinary(docxBytes({ omitPackageRelationships: true }))).toEqual({
        binary: true,
        mime: 'application/zip',
      })
    })

    it('keeps a package whose readable content-types part is not one as application/zip', () => {
      // When the part is stored its text is evidence, and this text says the
      // archive is not what its entry names claim.
      expect(sniffBinary(zipWithUnparseableStoredContentTypes())).toEqual({ binary: true, mime: 'application/zip' })
    })

    it('keeps an archive that merely NAMES an Office part inside a text entry as application/zip', () => {
      // Entry CONTENT can say anything; only the package's own index counts.
      const decoy = buildZip([{ name: 'readme.txt', content: 'contains [Content_Types].xml and word/document.xml' }])
      expect(sniffBinary(decoy)).toEqual({ binary: true, mime: 'application/zip' })
    })

    it('keeps a truncated package as application/zip (no central directory, nothing to trust)', () => {
      const full = docxBytes()
      expect(sniffBinary(full.subarray(0, full.length - 8))).toEqual({ binary: true, mime: 'application/zip' })
    })

    it('keeps a package whose central-directory offset points out of bounds as application/zip', () => {
      const corrupt = docxBytes()
      // Last 22 bytes are the end-of-central-directory record; bytes 16-19 of
      // it are the directory offset.
      const end = corrupt.length - 22
      corrupt.set([0xf0, 0xff, 0xff, 0x0f], end + 16)
      expect(sniffBinary(corrupt)).toEqual({ binary: true, mime: 'application/zip' })
    })
  })

  it('detects gzip', () => {
    expect(sniffBinary(bytes([0x1f, 0x8b, 0x08, 0, 0]))).toEqual({ binary: true, mime: 'application/gzip' })
  })

  it('detects MP3 via ID3 tag', () => {
    // ID3 + version 2.3.0 + flags + sync-safe size bytes
    expect(sniffBinary(ascii('ID3', [0x03, 0x00, 0x00, 0x00, 0x00, 0x02, 0x01]))).toEqual({
      binary: true,
      mime: 'audio/mpeg',
    })
  })

  it('does not classify prose starting with ID3 as MP3', () => {
    expect(sniffBinary(ascii('ID3 tags describe audio metadata'))).toEqual({ binary: false, mime: null })
  })

  it('detects MP3 via 0xFFFB frame sync', () => {
    expect(sniffBinary(bytes([0xff, 0xfb, 0x90, 0, 0]))).toEqual({ binary: true, mime: 'audio/mpeg' })
  })

  it('detects OGG', () => {
    expect(sniffBinary(ascii('OggS', [0, 0]))).toEqual({ binary: true, mime: 'audio/ogg' })
  })

  describe('EBML containers', () => {
    it('detects WebM from the EBML DocType', () => {
      expect(sniffBinary(ebmlBytes('webm'))).toEqual({ binary: true, mime: 'video/webm' })
    })

    it('reports Matroska under a distinct mime', () => {
      expect(sniffBinary(ebmlBytes('matroska'))).toEqual({ binary: true, mime: 'video/x-matroska' })
    })

    it('does not call an EBML container WebM when its DocType is different', () => {
      expect(sniffBinary(ebmlBytes('not-webm'))).toEqual({ binary: true, mime: null })
    })

    it('does not call MP4 bytes WebM merely because a caller renamed the file', () => {
      const renamedMp4 = new Uint8Array([0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii('isom')])
      expect(sniffBinary(renamedMp4)).toEqual({ binary: true, mime: 'video/mp4' })
    })

    it('does not scan a truncated or unknown-sized EBML header', () => {
      expect(sniffBinary(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x8b, 0x42, 0x82, 0x84, ...ascii('webm')]))).toEqual({ binary: true, mime: null })
      expect(sniffBinary(bytes([0x1a, 0x45, 0xdf, 0xa3, 0xff, 0x42, 0x82, 0x84, ...ascii('webm')]))).toEqual({ binary: true, mime: null })
    })
  })

  it('detects MP4 via ftyp box', () => {
    const mp4 = new Uint8Array([0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii('isom')])
    expect(sniffBinary(mp4)).toEqual({ binary: true, mime: 'video/mp4' })
  })

  it('detects MOV via ftyp box with the qt brand', () => {
    const mov = new Uint8Array([0, 0, 0, 0x14, ...ascii('ftyp'), ...ascii('qt  ')])
    expect(sniffBinary(mov)).toEqual({ binary: true, mime: 'video/quicktime' })
  })

  it('detects a plain MP4 via ftyp box with the mp42 brand', () => {
    const mp4 = new Uint8Array([0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii('mp42')])
    expect(sniffBinary(mp4)).toEqual({ binary: true, mime: 'video/mp4' })
  })

  it('detects AVIF via ftyp box with the avif brand', () => {
    const avif = new Uint8Array([0, 0, 0, 0x1c, ...ascii('ftyp'), ...ascii('avif')])
    expect(sniffBinary(avif)).toEqual({ binary: true, mime: 'image/avif' })
  })

  it('detects an AVIF image sequence via ftyp box with the avis brand', () => {
    const avis = new Uint8Array([0, 0, 0, 0x1c, ...ascii('ftyp'), ...ascii('avis')])
    expect(sniffBinary(avis)).toEqual({ binary: true, mime: 'image/avif' })
  })

  it('detects HEIC via ftyp box with the heic brand', () => {
    const heic = new Uint8Array([0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii('heic')])
    expect(sniffBinary(heic)).toEqual({ binary: true, mime: 'image/heic' })
  })

  it('detects HEIC via ftyp box with the heix brand', () => {
    const heix = new Uint8Array([0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii('heix')])
    expect(sniffBinary(heix)).toEqual({ binary: true, mime: 'image/heic' })
  })

  it('detects HEIF via ftyp box with the mif1 brand', () => {
    const heif = new Uint8Array([0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii('mif1')])
    expect(sniffBinary(heif)).toEqual({ binary: true, mime: 'image/heif' })
  })

  it('classifies SVG with <svg> as the first element as binary image/svg+xml', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>')
    expect(sniffBinary(svg)).toEqual({ binary: true, mime: 'image/svg+xml' })
  })

  it('classifies SVG with an xml prolog, doctype, and comment before the root as binary', () => {
    const svg = new TextEncoder().encode(
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<!-- exported -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    )
    expect(sniffBinary(svg)).toEqual({ binary: true, mime: 'image/svg+xml' })
  })

  it('classifies BOM-prefixed SVG as binary', () => {
    const svg = new TextEncoder().encode('﻿  <svg xmlns="http://www.w3.org/2000/svg"/>')
    expect(sniffBinary(svg)).toEqual({ binary: true, mime: 'image/svg+xml' })
  })

  it('keeps non-svg XML as text', () => {
    const xml = new TextEncoder().encode('<?xml version="1.0"?>\n<config>\n  <item name="a"/>\n</config>')
    expect(sniffBinary(xml)).toEqual({ binary: false, mime: null })
  })

  it('keeps prose mentioning <svg mid-text as text', () => {
    const prose = new TextEncoder().encode('This document explains how the <svg> element is used in HTML pages.')
    expect(sniffBinary(prose)).toEqual({ binary: false, mime: null })
  })

  it('classifies plain UTF-8 text as text with no mime', () => {
    const text = new TextEncoder().encode('# Hello\n\nThis is a normal markdown file.')
    expect(sniffBinary(text)).toEqual({ binary: false, mime: null })
  })

  it('classifies UTF-8 with multi-byte characters as text', () => {
    const text = new TextEncoder().encode('Café résumé — naïve 日本語')
    expect(sniffBinary(text)).toEqual({ binary: false, mime: null })
  })

  it('treats a NUL byte as binary even when the rest decodes as UTF-8', () => {
    const withNul = new Uint8Array([...new TextEncoder().encode('hello'), 0x00, ...new TextEncoder().encode('world')])
    expect(sniffBinary(withNul)).toEqual({ binary: true, mime: null })
  })

  it('treats invalid UTF-8 as binary (unknown mime)', () => {
    // 0xFF is not a valid UTF-8 leading byte and matches no magic table entry.
    expect(sniffBinary(bytes([0xff, 0x01, 0x02, 0x03]))).toEqual({ binary: true, mime: null })
  })

  it('treats a truncated multi-byte UTF-8 sequence as binary', () => {
    // 0xE2 0x82 starts a 3-byte sequence but is cut short.
    expect(sniffBinary(bytes([0xe2, 0x82]))).toEqual({ binary: true, mime: null })
  })

  it('defaults empty content to text', () => {
    expect(sniffBinary(new Uint8Array(0))).toEqual({ binary: false, mime: null })
  })
})
