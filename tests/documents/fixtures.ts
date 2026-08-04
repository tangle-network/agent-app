/**
 * Real document bytes for the extraction tests — nothing here is a stub.
 *
 * PDFs are built with `pdf-lib`, so the wasm engine parses genuine PDF
 * structure rather than a string that looks like one. DOCX packages are
 * written by a real PKZIP writer whose deflate comes from `node:zlib` — a
 * different implementation from the `DecompressionStream` the reader under
 * test uses, so a fixture and the reader cannot agree on a shared mistake.
 * `fixtures/contract-pandoc.docx` is stronger still: bytes from an independent
 * Office toolchain, which is the only fixture that can catch an assumption
 * both this file and `src/documents` happen to share.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

import { PDFDocument, StandardFonts } from 'pdf-lib'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

/** The engine's wasm as raw bytes. A Worker passes a compiled
 *  `WebAssembly.Module` here instead; `initSync` accepts either. */
export function pdfInspectorWasmBytes(): Uint8Array {
  const require = createRequire(import.meta.url)
  const wasmPath = join(dirname(require.resolve('@firecrawl/pdf-inspector-wasm')), 'pdf_inspector_wasm_bg.wasm')
  return new Uint8Array(readFileSync(wasmPath))
}

/** A `.docx` written by pandoc — an independent Office toolchain. */
export function pandocContractDocx(): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURE_DIR, 'contract-pandoc.docx')))
}

/** One drawn text line per input line, one page per input page. */
export async function textPdf(pages: readonly (readonly string[])[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const lines of pages) {
    const page = doc.addPage([612, 792])
    let y = 750
    for (const line of lines) {
      page.drawText(line, { x: 40, y, size: 11, font })
      y -= 18
    }
  }
  return doc.save()
}

// A valid 1x1 red PNG. Scaled to the full page it produces a page with image
// content and no text runs — the shape of a scan.
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** A PDF with `imagePages` text-free pages followed by `textPages` pages of
 *  dense prose. All-image = a scan; a mix = a partially scanned document. */
export async function imageAndTextPdf(imagePages: number, textPages: readonly (readonly string[])[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const png = await doc.embedPng(Uint8Array.from(atob(PNG_1PX), (c) => c.charCodeAt(0)))
  for (const lines of textPages) {
    const page = doc.addPage([612, 792])
    let y = 760
    for (const line of lines) {
      page.drawText(line, { x: 30, y, size: 9, font })
      y -= 16
      if (y < 30) break
    }
  }
  for (let i = 0; i < imagePages; i++) {
    doc.addPage([612, 792]).drawImage(png, { x: 0, y: 0, width: 612, height: 792 })
  }
  return doc.save()
}

/** Enough prose that the engine sees a real text layer on the page. */
export function densePage(prefix: string): string[] {
  return Array.from(
    { length: 38 },
    (_, i) => `${prefix} clause ${i + 1}. The parties agree that every obligation is performed in good faith.`,
  )
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let value = i
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[i] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff]
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
}

export interface ZipEntryInput {
  readonly name: string
  readonly content: string
  /** Compression method 0. Real Office packages deflate; a stored entry is the
   *  other branch the reader has to handle. */
  readonly stored?: boolean
}

/** A real PKZIP archive: local headers, CRC-32, central directory, EOCD. */
export function buildZip(entries: readonly ZipEntryInput[]): Uint8Array {
  const encoder = new TextEncoder()
  const chunks: number[] = []
  const directory: number[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Array.from(encoder.encode(entry.name))
    const raw = encoder.encode(entry.content)
    const stored = entry.stored === true
    const payload = stored ? Array.from(raw) : Array.from(deflateRawSync(raw))
    const method = stored ? 0 : 8
    const checksum = crc32(raw)
    const localHeaderOffset = offset

    const localHeader = [
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(method),
      ...u16(0),
      ...u16(0),
      ...u32(checksum),
      ...u32(payload.length),
      ...u32(raw.length),
      ...u16(name.length),
      ...u16(0),
      ...name,
    ]
    chunks.push(...localHeader, ...payload)
    offset += localHeader.length + payload.length

    directory.push(
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(0),
      ...u16(method),
      ...u16(0),
      ...u16(0),
      ...u32(checksum),
      ...u32(payload.length),
      ...u32(raw.length),
      ...u16(name.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(localHeaderOffset),
      ...name,
    )
  }

  const directoryOffset = offset
  const eocd = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(directory.length),
    ...u32(directoryOffset),
    ...u16(0),
  ]
  return new Uint8Array([...chunks, ...directory, ...eocd])
}

const RELS_XML = (target: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`

/** Wrap WordprocessingML body markup in a document part. */
export function documentXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
}

/** `<w:p><w:r><w:t xml:space="preserve">…</w:t></w:r></w:p>` for each line. */
export function paragraphs(lines: readonly string[]): string {
  return lines.map((line) => `<w:p><w:r><w:t xml:space="preserve">${line}</w:t></w:r></w:p>`).join('')
}

export interface DocxFixtureOptions {
  /** OPC part name for the main document. Default `word/document.xml`. */
  readonly part?: string
  readonly stored?: boolean
  /** Replace `_rels/.rels` entirely (to test a malformed package). */
  readonly relsXml?: string
  /** Omit `_rels/.rels`. */
  readonly omitRels?: boolean
}

/** A minimal but structurally valid `.docx` package. */
export function buildDocx(body: string, options: DocxFixtureOptions = {}): Uint8Array {
  const part = options.part ?? 'word/document.xml'
  const entries: ZipEntryInput[] = [
    {
      name: '[Content_Types].xml',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
      stored: true,
    },
  ]
  if (!options.omitRels) {
    entries.push({ name: '_rels/.rels', content: options.relsXml ?? RELS_XML(part) })
  }
  entries.push({ name: part, content: documentXml(body), stored: options.stored })
  return buildZip(entries)
}
