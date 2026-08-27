import { describe, expect, it } from 'vitest'
import { sniffBinary } from '../../src/chat-routes/binary-sniff'

// Port of gtm-agent's `tests/binary-sniff.test.ts` — byte-identical fixtures,
// same magic-byte families plus the fatal-UTF-8/SVG-text-is-binary edge cases.

function bytes(values: number[]): Uint8Array {
  return new Uint8Array(values)
}

function ascii(text: string, extra: number[] = []): Uint8Array {
  return new Uint8Array([...Array.from(text, (c) => c.charCodeAt(0)), ...extra])
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

  it('detects ZIP (and by extension OOXML docx/xlsx/pptx, which are just zip archives)', () => {
    expect(sniffBinary(bytes([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toEqual({ binary: true, mime: 'application/zip' })
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
