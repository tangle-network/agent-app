/**
 * Real archive fixtures for the attachment type gate: a genuine PKZIP writer
 * (local headers, CRC-32, central directory, end-of-central-directory record)
 * plus the OOXML packages built on top of it. Nothing here is a stub — the
 * bytes these produce are readable by any zip tool and by `python3 -m zipfile`,
 * which is how the fixtures were checked before the tests were trusted.
 *
 * Test-only: `node:zlib` supplies the deflate a real Office package uses for
 * its parts, which `src/chat-routes/binary-sniff.ts` deliberately cannot
 * decompress (it ships into browser bundles and reads untrusted bytes). The
 * sniffer therefore has to identify these from the zip's own uncompressed
 * metadata, and a fixture whose parts were all stored would never exercise
 * that path.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

/**
 * Packages written by real Office toolchains, committed as bytes — the guard
 * against the failure this repo has shipped before, where a fixture and the
 * code under test share the same wrong assumption. A builder that agrees with
 * the sniffer proves only that they agree; these files were produced by
 * independent implementations (`real-word.docx` and `real-powerpoint.pptx` by
 * pandoc, `real-excel.xlsx` by LibreOffice Calc) and every one of them
 * deflates its content-types part, which is why `sniffOoxml` cannot rely on
 * reading the declared content types and identifies a package from its entry
 * names instead.
 */
export function realWorldOoxmlBytes(name: 'real-word.docx' | 'real-excel.xlsx' | 'real-powerpoint.pptx'): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURE_DIR, name)))
}

export interface ZipEntryInput {
  name: string
  content: string
  /** Store the entry uncompressed (compression method 0) instead of deflating
   *  it. Real Office packages deflate; a producer that stores the
   *  content-types part is the case that lets a reader see the declared
   *  content types without an inflater. */
  stored?: boolean
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

/** Write a real zip archive. Entry order is preserved, so a caller can put
 *  `[Content_Types].xml` first the way the OPC spec requires. */
export function buildZip(entries: ZipEntryInput[]): Uint8Array {
  const encoder = new TextEncoder()
  const chunks: number[] = []
  const directory: number[] = []
  let offset = 0
  let count = 0

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
      ...u16(20), // version needed
      ...u16(0), // general purpose flags — no data descriptor, sizes are in the header
      ...u16(method),
      ...u16(0), // modification time
      ...u16(0), // modification date
      ...u32(checksum),
      ...u32(payload.length),
      ...u32(raw.length),
      ...u16(name.length),
      ...u16(0), // extra field length
      ...name,
    ]
    chunks.push(...localHeader, ...payload)
    offset += localHeader.length + payload.length

    directory.push(
      ...u32(0x02014b50),
      ...u16(20), // version made by
      ...u16(20), // version needed
      ...u16(0),
      ...u16(method),
      ...u16(0),
      ...u16(0),
      ...u32(checksum),
      ...u32(payload.length),
      ...u32(raw.length),
      ...u16(name.length),
      ...u16(0), // extra field length
      ...u16(0), // comment length
      ...u16(0), // disk number
      ...u16(0), // internal attributes
      ...u32(0), // external attributes
      ...u32(localHeaderOffset),
      ...name,
    )
    count += 1
  }

  const directoryOffset = offset
  const endRecord = [
    ...u32(0x06054b50),
    ...u16(0), // disk number
    ...u16(0), // disk with central directory
    ...u16(count),
    ...u16(count),
    ...u32(directory.length),
    ...u32(directoryOffset),
    ...u16(0), // comment length
  ]
  return new Uint8Array([...chunks, ...directory, ...endRecord])
}

const RELATIONSHIPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="MAIN_PART"/>
</Relationships>`

function contentTypesXml(overrides: Array<[string, string]>): string {
  const lines = overrides.map(([part, type]) => `  <Override PartName="${part}" ContentType="${type}"/>`)
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>
${lines.join('\n')}
</Types>`
}

const WORD_DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>Master Services Agreement</w:t></w:r></w:p></w:body>
</w:document>`

const EXCEL_WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheets><sheet name="Schedule C" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets>
</workbook>`

const POWERPOINT_PRESENTATION_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst><p:sldId id="256" r:id="rId2" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></p:sldIdLst>
</p:presentation>`

export interface OoxmlFixtureOptions {
  /** Store `[Content_Types].xml` uncompressed, so its declared content types
   *  are readable without an inflater. Default `false` (deflated, as Word,
   *  Excel and PowerPoint all write it). */
  storedContentTypes?: boolean
  /** Add a VBA project part, making the package macro-enabled (`.docm`
   *  family) and declaring the macro-enabled main-part content type. */
  macroEnabled?: boolean
  /** Rename the main part, the way a repaired or converted Word file carries
   *  `word/document2.xml` instead of the canonical name. */
  mainPartSuffix?: string
  /**
   * Carry the VBA project part WITHOUT declaring the macro-enabled content
   * type — the crafted shape `macroEnabled` cannot express, because it moves
   * both at once. A sniffer that reads the declaration and never scans for the
   * part reports this package as a plain document.
   */
  vbaPartWithPlainDeclaration?: boolean
  /**
   * Extra `Override` entries in the content-types part. A second declared
   * main-part type is a decoy: the part is one string, so a reader matching on
   * substrings cannot tell which `Override` is the package's real main part.
   */
  extraContentTypeOverrides?: Array<[string, string]>
  /** Drop the OPC package-relationships part, leaving an archive that carries
   *  only the Office part NAMES. */
  omitPackageRelationships?: boolean
}

function ooxmlPackage(
  canonicalMainPart: string,
  contentType: string,
  macroContentType: string,
  vbaPart: string,
  mainXml: string,
  options: OoxmlFixtureOptions,
): Uint8Array {
  const macroEnabled = options.macroEnabled === true
  const plainlyDeclaredVba = options.vbaPartWithPlainDeclaration === true
  const mainPart = options.mainPartSuffix === undefined
    ? canonicalMainPart
    : canonicalMainPart.replace(/\.xml$/, `${options.mainPartSuffix}.xml`)
  const overrides: Array<[string, string]> = [
    [`/${mainPart}`, macroEnabled ? macroContentType : contentType],
    ...(options.extraContentTypeOverrides ?? []),
  ]
  const entries: ZipEntryInput[] = [
    { name: '[Content_Types].xml', content: contentTypesXml(overrides), stored: options.storedContentTypes === true },
  ]
  if (options.omitPackageRelationships !== true) {
    entries.push({ name: '_rels/.rels', content: RELATIONSHIPS.replace('MAIN_PART', `/${mainPart}`) })
  }
  entries.push({ name: mainPart, content: mainXml })
  if (macroEnabled || plainlyDeclaredVba) entries.push({ name: vbaPart, content: 'vba-project-bytes' })
  return buildZip(entries)
}

/** A genuine minimal Word package. */
export function docxBytes(options: OoxmlFixtureOptions = {}): Uint8Array {
  return ooxmlPackage(
    'word/document.xml',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    'application/vnd.ms-word.document.macroEnabled.main+xml',
    'word/vbaProject.bin',
    WORD_DOCUMENT_XML,
    options,
  )
}

/** A genuine minimal Excel package. */
export function xlsxBytes(options: OoxmlFixtureOptions = {}): Uint8Array {
  return ooxmlPackage(
    'xl/workbook.xml',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
    'xl/vbaProject.bin',
    EXCEL_WORKBOOK_XML,
    options,
  )
}

/** A genuine minimal PowerPoint package. */
export function pptxBytes(options: OoxmlFixtureOptions = {}): Uint8Array {
  return ooxmlPackage(
    'ppt/presentation.xml',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
    'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
    'ppt/vbaProject.bin',
    POWERPOINT_PRESENTATION_XML,
    options,
  )
}

/** An ordinary archive: the thing the gate must keep refusing. */
export function plainZipBytes(): Uint8Array {
  return buildZip([
    { name: 'notes.txt', content: 'quarterly numbers\n' },
    { name: 'data/report.csv', content: 'account,amount\nchecking,1200\n' },
  ])
}

/** An archive that borrowed the Office entry NAMES and filled them with
 *  arbitrary bytes, carrying no package-relationships part. The craft a
 *  name-only reader must still refuse. */
export function zipNamedLikeAnOfficePackage(): Uint8Array {
  return buildZip([
    { name: '[Content_Types].xml', content: 'not even xml' },
    { name: 'word/document.xml', content: 'not even xml' },
    { name: 'payload.bin', content: 'MZ  arbitrary payload' },
  ])
}

/** A package carrying both OPC parts whose STORED content-types part is not a
 *  content-types part at all — the case where the text is readable and says
 *  the archive is not what its entry names claim. */
export function zipWithUnparseableStoredContentTypes(): Uint8Array {
  return buildZip([
    { name: '[Content_Types].xml', content: 'not even xml', stored: true },
    { name: '_rels/.rels', content: RELATIONSHIPS.replace('MAIN_PART', '/word/document.xml') },
    { name: 'word/document.xml', content: WORD_DOCUMENT_XML },
  ])
}

/** An archive holding the parts of a Word package but no OPC content-types
 *  part — the near-miss that proves the content-types part, not the part
 *  names alone, is what admits a package. */
export function zipWithWordPartsButNoContentTypes(): Uint8Array {
  return buildZip([
    { name: '_rels/.rels', content: RELATIONSHIPS.replace('MAIN_PART', '/word/document.xml') },
    { name: 'word/document.xml', content: WORD_DOCUMENT_XML },
  ])
}

/** An OPC package that is not a Word/Excel/PowerPoint document — Visio,
 *  XPS and theme packages all look like this. */
export function opcPackageWithoutOfficeMainPart(): Uint8Array {
  return buildZip([
    { name: '[Content_Types].xml', content: contentTypesXml([['/visio/document.xml', 'application/vnd.ms-visio.drawing.main+xml']]) },
    { name: '_rels/.rels', content: RELATIONSHIPS.replace('MAIN_PART', '/visio/document.xml') },
    { name: 'visio/document.xml', content: '<VisioDocument/>' },
  ])
}
