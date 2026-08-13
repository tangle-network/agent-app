/**
 * Content-based binary/text classification, shared by the attachment upload
 * route (server) and the composer's client-side pre-validation (browser) —
 * both sides must agree on what counts as binary before a byte ever leaves
 * the client. Extension-based allowlists lie (a renamed `.docx`, a PNG saved
 * as `.txt`), so classification reads the actual bytes: a magic-byte table
 * for common binary formats first, then a UTF-8 decode attempt for
 * everything else. Three families need more than a fixed-offset signature and
 * get a reader of their own — ISO-BMFF brands (`sniffFtyp`), EBML containers
 * (`sniffEbml`), and OOXML Office packages, whose PKZIP container is shared
 * with every other `.zip` (`sniffOoxml`).
 *
 * Lifted near-verbatim from gtm-agent's `src/lib/binary-sniff.ts` (the
 * source PRs hardened this against real corruption/gate bugs: gtm#584,
 * gtm#592). Import-free by design — `/web-react` re-exports `/chat-routes`
 * modules into browser bundles (`tests/browser-safe-subpaths.test.ts` walks
 * the graph), so nothing here may reach a Node builtin or an engine package.
 */

export interface SniffResult {
  binary: boolean
  mime: string | null
}

/** Sniffed mime for a Word OOXML package (`.docx`). */
export const OOXML_WORD_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** Sniffed mime for an Excel OOXML package (`.xlsx`). */
export const OOXML_SPREADSHEET_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** Sniffed mime for a PowerPoint OOXML package (`.pptx`). */
export const OOXML_PRESENTATION_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

/** Sniffed mime for a macro-enabled Word package (`.docm`). Reported
 *  separately from {@link OOXML_WORD_MIME} so a package carrying a VBA project
 *  can never be admitted under the plain-document mime: a route that wants
 *  macro-enabled files opts in explicitly through its allowed-mime seam. */
export const OOXML_WORD_MACRO_ENABLED_MIME = 'application/vnd.ms-word.document.macroEnabled.12'

/** Sniffed mime for a macro-enabled Excel package (`.xlsm`). */
export const OOXML_SPREADSHEET_MACRO_ENABLED_MIME = 'application/vnd.ms-excel.sheet.macroEnabled.12'

/** Sniffed mime for a macro-enabled PowerPoint package (`.pptm`). */
export const OOXML_PRESENTATION_MACRO_ENABLED_MIME = 'application/vnd.ms-powerpoint.presentation.macroEnabled.12'

function bytesStartWith(bytes: Uint8Array, offset: number, signature: number[]): boolean {
  if (bytes.length < offset + signature.length) return false
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false
  }
  return true
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false
  }
  return true
}

/** RIFF containers (WebP, WAV) share the `RIFF....<TYPE>` header; the type
 *  tag at byte offset 8 distinguishes them. */
function sniffRiff(bytes: Uint8Array): string | null {
  if (!asciiAt(bytes, 0, 'RIFF')) return null
  if (asciiAt(bytes, 8, 'WEBP')) return 'image/webp'
  if (asciiAt(bytes, 8, 'WAVE')) return 'audio/wav'
  return null
}

/** MP4/MOV/AVIF/HEIC containers share an `ftyp` box at byte offset 4; the
 *  major brand at offset 8 tells them apart within the shared ISO-BMFF
 *  family. Brands outside this table (mp4, m4a, m4v, etc) fall back to
 *  `video/mp4`, the family's most common member. */
function sniffFtyp(bytes: Uint8Array): string | null {
  if (!asciiAt(bytes, 4, 'ftyp')) return null
  if (asciiAt(bytes, 8, 'qt  ')) return 'video/quicktime'
  if (asciiAt(bytes, 8, 'avif') || asciiAt(bytes, 8, 'avis')) return 'image/avif'
  if (asciiAt(bytes, 8, 'heic') || asciiAt(bytes, 8, 'heix') || asciiAt(bytes, 8, 'hevc') || asciiAt(bytes, 8, 'hevx')) return 'image/heic'
  if (asciiAt(bytes, 8, 'mif1') || asciiAt(bytes, 8, 'msf1')) return 'image/heif'
  return 'video/mp4'
}

const EBML_HEADER_ID = 0x1a45dfa3
const EBML_DOC_TYPE_ID = 0x4282
/** A normal EBML header is only a few dozen bytes. This cap keeps a crafted
 *  header from choosing how much untrusted input the DocType reader scans. */
const EBML_HEADER_SCAN_BYTES = 4 * 1024

interface EbmlVint {
  length: number
  value: number
}

/** Read an EBML variable-width integer. Element IDs retain their marker bit;
 *  element sizes remove it. Values too large for exact JS integer arithmetic,
 *  unknown-size sentinels, and truncated encodings are rejected. */
function readEbmlVint(
  bytes: Uint8Array,
  offset: number,
  maxLength: number,
  stripMarker: boolean,
): EbmlVint | null {
  const first = bytes[offset]
  if (first === undefined || first === 0) return null

  let marker = 0x80
  let length = 1
  while ((first & marker) === 0) {
    marker >>= 1
    length++
  }
  if (length > maxLength || offset + length > bytes.length) return null

  if (stripMarker) {
    let unknown = (first & (marker - 1)) === marker - 1
    for (let index = 1; index < length; index++) unknown &&= bytes[offset + index] === 0xff
    if (unknown) return null
  }

  let value = stripMarker ? first & (marker - 1) : first
  for (let index = 1; index < length; index++) {
    value = value * 0x100 + bytes[offset + index]!
    if (!Number.isSafeInteger(value)) return null
  }
  return { length, value }
}

/** WebM and Matroska share the EBML magic. Their header's bounded DocType
 *  element is the distinguishing signal; other or malformed EBML containers
 *  remain recognized only as unknown binary. */
function sniffEbml(bytes: Uint8Array): string | null {
  const headerId = readEbmlVint(bytes, 0, 4, false)
  if (headerId?.value !== EBML_HEADER_ID) return null

  const headerSize = readEbmlVint(bytes, headerId.length, 8, true)
  if (!headerSize) return null
  const headerStart = headerId.length + headerSize.length
  const headerEnd = headerStart + headerSize.value
  if (!Number.isSafeInteger(headerEnd) || headerEnd > bytes.length) return null
  const scanEnd = Math.min(headerEnd, headerStart + EBML_HEADER_SCAN_BYTES)

  let cursor = headerStart
  while (cursor < scanEnd) {
    const id = readEbmlVint(bytes, cursor, 4, false)
    if (!id) return null
    const size = readEbmlVint(bytes, cursor + id.length, 8, true)
    if (!size) return null
    const valueStart = cursor + id.length + size.length
    const valueEnd = valueStart + size.value
    if (!Number.isSafeInteger(valueEnd) || valueEnd > headerEnd || valueEnd > scanEnd) return null

    if (id.value === EBML_DOC_TYPE_ID) {
      let docType = ''
      for (let index = valueStart; index < valueEnd; index++) {
        const byte = bytes[index]!
        if (byte > 0x7f) return null
        docType += String.fromCharCode(byte)
      }
      if (docType === 'webm') return 'video/webm'
      if (docType === 'matroska') return 'video/x-matroska'
      return null
    }
    cursor = valueEnd
  }
  return null
}

/** `BM` alone matches ordinary prose ("BMW…"), so require the BMP header's
 *  reserved bytes (offsets 6-9), which the format mandates to be zero. */
function sniffBmp(bytes: Uint8Array): boolean {
  return asciiAt(bytes, 0, 'BM')
    && bytes.length >= 10
    && bytes[6] === 0 && bytes[7] === 0 && bytes[8] === 0 && bytes[9] === 0
}

/** `ID3` alone matches ordinary prose ("ID3 tags…"), so require the ID3v2
 *  header shape: a plausible version byte and sync-safe size bytes. */
function sniffId3(bytes: Uint8Array): boolean {
  return asciiAt(bytes, 0, 'ID3')
    && bytes.length >= 10
    && bytes[3]! < 0x10
    && bytes[6]! < 0x80 && bytes[7]! < 0x80 && bytes[8]! < 0x80 && bytes[9]! < 0x80
}

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const ZIP_CENTRAL_FILE_HEADER_SIGNATURE = 0x02014b50
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
/** Fixed part of an end-of-central-directory record, before its comment. */
const ZIP_END_OF_CENTRAL_DIRECTORY_BYTES = 22
/** Fixed part of a central-directory file header, before name/extra/comment. */
const ZIP_CENTRAL_FILE_HEADER_BYTES = 46
/** Fixed part of a local file header, before name/extra. */
const ZIP_LOCAL_FILE_HEADER_BYTES = 30
/** A zip's trailing comment is a u16 length, so the end-of-central-directory
 *  record sits within this distance of the last byte. */
const ZIP_MAX_COMMENT_BYTES = 0xffff
/** ZIP64 stores sentinels in the 16/32-bit fields and the real values in a
 *  separate record. Nothing that large rides an attachment cap, so a sentinel
 *  leaves the archive unclassified instead of half-parsed. */
const ZIP64_SENTINEL_U16 = 0xffff
const ZIP64_SENTINEL_U32 = 0xffffffff
/** Deflate is the usual method; only method 0 (stored) can be read without an
 *  inflater, and this module has no decompression (it runs in the browser
 *  bundle and on the upload path, on untrusted bytes). */
const ZIP_METHOD_STORED = 0

/** The OPC content-types part every OOXML package carries. */
const OPC_CONTENT_TYPES_PART = '[Content_Types].xml'

/** The OPC package-relationships part. ECMA-376 Part 2 requires it in every
 *  conforming package, so an archive that borrowed the Office part NAMES
 *  without also carrying this one is not a package. Structural, like the
 *  content-types part: both are read from the zip's own uncompressed metadata,
 *  which is the only evidence available without an inflater. */
const OPC_PACKAGE_RELATIONSHIPS_PART = '_rels/.rels'

/** Namespace a genuine content-types part declares. Only checkable when that
 *  part is STORED uncompressed — Word, Excel and PowerPoint all deflate it —
 *  so this narrows the crafted-archive surface where it applies and is silent
 *  where it does not. */
const OPC_CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types'

/** Ceiling on how much of the content-types part is read when it happens to
 *  be stored uncompressed — the genuine part is a few hundred bytes, and a
 *  crafted archive must not be able to dictate how much text is scanned. */
const OPC_CONTENT_TYPES_SCAN_BYTES = 64 * 1024

interface OoxmlDeclaredMainPartType {
  /** The content type as it appears in the content-types part. */
  readonly declaredType: string
  /** Reported mime when the package carries no VBA project. */
  readonly mime: string
  /** Reported mime for the same family once a VBA project is present. */
  readonly macroEnabledMime: string
  /** True when `declaredType` is itself one of the macro-enabled types. */
  readonly macroEnabled: boolean
}

/** Content types a package DECLARES for its main part, in the content-types
 *  part itself — the authoritative signal when it is readable, because it
 *  distinguishes a document from a template or a macro-enabled sibling that
 *  share the same part layout. Each row carries its macro-enabled sibling
 *  because a declared type is only half the answer: the VBA-project scan can
 *  override it, and a package that carries one is macro-enabled whatever it
 *  declares. */
const OOXML_DECLARED_MAIN_PART_TYPES: ReadonlyArray<OoxmlDeclaredMainPartType> = [
  {
    declaredType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    mime: OOXML_WORD_MIME,
    macroEnabledMime: OOXML_WORD_MACRO_ENABLED_MIME,
    macroEnabled: false,
  },
  {
    declaredType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    mime: OOXML_SPREADSHEET_MIME,
    macroEnabledMime: OOXML_SPREADSHEET_MACRO_ENABLED_MIME,
    macroEnabled: false,
  },
  {
    declaredType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
    mime: OOXML_PRESENTATION_MIME,
    macroEnabledMime: OOXML_PRESENTATION_MACRO_ENABLED_MIME,
    macroEnabled: false,
  },
  {
    declaredType: 'application/vnd.ms-word.document.macroEnabled.main+xml',
    mime: OOXML_WORD_MACRO_ENABLED_MIME,
    macroEnabledMime: OOXML_WORD_MACRO_ENABLED_MIME,
    macroEnabled: true,
  },
  {
    declaredType: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
    mime: OOXML_SPREADSHEET_MACRO_ENABLED_MIME,
    macroEnabledMime: OOXML_SPREADSHEET_MACRO_ENABLED_MIME,
    macroEnabled: true,
  },
  {
    declaredType: 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
    mime: OOXML_PRESENTATION_MACRO_ENABLED_MIME,
    macroEnabledMime: OOXML_PRESENTATION_MACRO_ENABLED_MIME,
    macroEnabled: true,
  },
]

/** Main part of each Office format, as it appears in the package's entry
 *  names — the structural signal used when the declared content types are
 *  compressed (the common case: Word, Excel and PowerPoint all deflate the
 *  content-types part). Entry names live in the zip's own uncompressed
 *  metadata, so reading them needs no inflater.
 *
 *  `directory` is the fallback for the packages that do not use the canonical
 *  main-part name — a repaired or converted Word file declares
 *  `word/document2.xml` — and it is only consulted for a package already
 *  confirmed to carry the OPC content-types part, where a `word/` part means
 *  a Word document and nothing else. The three directories never mix: an
 *  embedded workbook inside a `.docx` lives under `word/embeddings/`. */
const OOXML_MAIN_PARTS: ReadonlyArray<{ part: string; directory: string; mime: string; macroEnabledMime: string }> = [
  { part: 'word/document.xml', directory: 'word/', mime: OOXML_WORD_MIME, macroEnabledMime: OOXML_WORD_MACRO_ENABLED_MIME },
  { part: 'xl/workbook.xml', directory: 'xl/', mime: OOXML_SPREADSHEET_MIME, macroEnabledMime: OOXML_SPREADSHEET_MACRO_ENABLED_MIME },
  { part: 'ppt/presentation.xml', directory: 'ppt/', mime: OOXML_PRESENTATION_MIME, macroEnabledMime: OOXML_PRESENTATION_MACRO_ENABLED_MIME },
]

/** A VBA project part means the package is macro-enabled whatever its
 *  extension claims. Matched by suffix rather than by exact path: naming the
 *  macro-enabled mime is the fail-closed answer (the default allow-list
 *  refuses it), so a part this misses is the expensive direction. */
const OOXML_VBA_PROJECT_PART_SUFFIX = 'vbaProject.bin'

interface ZipEntry {
  name: string
  compressionMethod: number
  compressedBytes: number
  localHeaderOffset: number
}

function readU16Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

/** Little-endian u32 as an unsigned JS number — the high byte is multiplied
 *  rather than shifted, because `<< 24` would produce a negative value. */
function readU32Le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)) + bytes[offset + 3]! * 0x1000000
}

/** Entry names are raw bytes; only exact ASCII part names are compared here,
 *  so a non-ASCII byte becomes a character that can never match one. */
function asciiEntryName(bytes: Uint8Array, offset: number, length: number): string {
  let name = ''
  for (let i = 0; i < length; i++) {
    const byte = bytes[offset + i]!
    name += byte < 0x80 ? String.fromCharCode(byte) : '\uFFFD'
  }
  return name
}

/** Scan back from the tail for the end-of-central-directory record. The
 *  comment length must account for exactly the bytes that follow, or the
 *  "signature" is compressed data that happens to spell `PK\x05\x06`. */
function findZipEndOfCentralDirectory(bytes: Uint8Array): number | null {
  const lowest = Math.max(0, bytes.length - ZIP_END_OF_CENTRAL_DIRECTORY_BYTES - ZIP_MAX_COMMENT_BYTES)
  for (let offset = bytes.length - ZIP_END_OF_CENTRAL_DIRECTORY_BYTES; offset >= lowest; offset--) {
    if (readU32Le(bytes, offset) !== ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue
    if (offset + ZIP_END_OF_CENTRAL_DIRECTORY_BYTES + readU16Le(bytes, offset + 20) === bytes.length) return offset
  }
  return null
}

/** Read the archive's central directory — the authoritative index a zip
 *  reader uses. Returns `null` for anything that is not a complete, in-bounds,
 *  non-ZIP64 directory: a truncated or crafted archive is left unclassified
 *  rather than guessed at from its first local header. */
function readZipCentralDirectory(bytes: Uint8Array): ZipEntry[] | null {
  const end = findZipEndOfCentralDirectory(bytes)
  if (end === null) return null

  const entryCount = readU16Le(bytes, end + 10)
  const directoryBytes = readU32Le(bytes, end + 12)
  const directoryOffset = readU32Le(bytes, end + 16)
  if (entryCount === ZIP64_SENTINEL_U16) return null
  if (directoryBytes === ZIP64_SENTINEL_U32 || directoryOffset === ZIP64_SENTINEL_U32) return null
  if (directoryOffset + directoryBytes > bytes.length) return null

  const entries: ZipEntry[] = []
  let cursor = directoryOffset
  for (let i = 0; i < entryCount; i++) {
    if (cursor + ZIP_CENTRAL_FILE_HEADER_BYTES > bytes.length) return null
    if (readU32Le(bytes, cursor) !== ZIP_CENTRAL_FILE_HEADER_SIGNATURE) return null
    const nameLength = readU16Le(bytes, cursor + 28)
    const extraLength = readU16Le(bytes, cursor + 30)
    const commentLength = readU16Le(bytes, cursor + 32)
    if (cursor + ZIP_CENTRAL_FILE_HEADER_BYTES + nameLength > bytes.length) return null
    entries.push({
      name: asciiEntryName(bytes, cursor + ZIP_CENTRAL_FILE_HEADER_BYTES, nameLength),
      compressionMethod: readU16Le(bytes, cursor + 10),
      compressedBytes: readU32Le(bytes, cursor + 20),
      localHeaderOffset: readU32Le(bytes, cursor + 42),
    })
    cursor += ZIP_CENTRAL_FILE_HEADER_BYTES + nameLength + extraLength + commentLength
  }
  return entries
}

/** Text of an entry stored WITHOUT compression, or `null` for anything else.
 *  The data offset is computed from the local header (its extra field may be
 *  a different length than the central directory's copy). */
function storedZipEntryText(bytes: Uint8Array, entry: ZipEntry): string | null {
  if (entry.compressionMethod !== ZIP_METHOD_STORED) return null
  const header = entry.localHeaderOffset
  if (header + ZIP_LOCAL_FILE_HEADER_BYTES > bytes.length) return null
  if (readU32Le(bytes, header) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) return null
  const start = header + ZIP_LOCAL_FILE_HEADER_BYTES + readU16Le(bytes, header + 26) + readU16Le(bytes, header + 28)
  const length = Math.min(entry.compressedBytes, OPC_CONTENT_TYPES_SCAN_BYTES)
  if (length === 0 || start + length > bytes.length) return null
  return new TextDecoder('utf-8').decode(bytes.subarray(start, start + length))
}

/**
 * Identify an OOXML (Office Open XML) package inside a PKZIP container, or
 * `null` for an archive that is not one.
 *
 * Every `.docx`/`.xlsx`/`.pptx` is a zip, so the zip signature alone says
 * nothing — matching on it would admit every `.zip` a user can produce. What
 * this reads is the archive's own uncompressed metadata: the central
 * directory's entry names, plus the content-types part's text in the one case
 * where a producer stored it uncompressed. Everything below follows from that
 * one constraint — the module ships into browser bundles and runs on untrusted
 * bytes, so it has no inflater and cannot read a deflated part.
 *
 * Structural preconditions (both required): the OPC content-types part
 * `[Content_Types].xml` AND the OPC package-relationships part `_rels/.rels`.
 * Which Office format it is comes from the content types the first part
 * DECLARES when it is readable, and otherwise from which main part the package
 * contains (`word/document.xml`, `xl/workbook.xml`, `ppt/presentation.xml`).
 * A package carrying a VBA project reports the macro-enabled mime — computed
 * BEFORE the declared lookup and applied to its answer, so a package that
 * declares the plain type and ships `vbaProject.bin` reports macro-enabled,
 * and a decoy `Override` cannot select the plainer of two declared types.
 *
 * **What this does NOT prove, and no name-only reader can.** A deflated part's
 * CONTENT is unreadable here, so an archive that names its entries like a
 * package and fills them with arbitrary bytes reports the Office mime. That is
 * the same standing as every other magic-byte family this module reports —
 * `%PDF-` followed by arbitrary bytes reports `application/pdf` — because a
 * content sniffer answers "what format does this claim to be", not "is this
 * safe". The attachment gate is a FORMAT gate; a product that needs the bytes
 * to be a real, parseable document gets that from `/documents`' extractor,
 * which fails loud on a package it cannot read.
 */
function sniffOoxml(bytes: Uint8Array): string | null {
  const entries = readZipCentralDirectory(bytes)
  if (!entries) return null

  const contentTypes = entries.find((entry) => entry.name === OPC_CONTENT_TYPES_PART)
  if (!contentTypes) return null
  const names = entries.map((entry) => entry.name)
  if (!names.includes(OPC_PACKAGE_RELATIONSHIPS_PART)) return null

  // Order is load-bearing: a VBA project part makes the package macro-enabled
  // whatever its content-types part declares, and the declared lookup below
  // RETURNS, so this has to be known before it runs.
  const macroEnabled = names.some((name) => name.endsWith(OOXML_VBA_PROJECT_PART_SUFFIX))

  const declared = storedZipEntryText(bytes, contentTypes)
  if (declared !== null) {
    if (!declared.includes(OPC_CONTENT_TYPES_NAMESPACE)) return null
    // Every match, not the first: `includes` over the whole part means a decoy
    // `Override` declaring a second main-part type is indistinguishable from
    // the real one, so the macro-enabled reading wins whenever one is present.
    const matches = OOXML_DECLARED_MAIN_PART_TYPES.filter((row) => declared.includes(row.declaredType))
    const row = matches.find((candidate) => candidate.macroEnabled) ?? matches[0]
    if (row) return macroEnabled || row.macroEnabled ? row.macroEnabledMime : row.mime
  }

  const canonical = OOXML_MAIN_PARTS.find((main) => names.includes(main.part))
  const format = canonical ?? OOXML_MAIN_PARTS.find((main) => names.some((name) => name.startsWith(main.directory)))
  if (!format) return null
  return macroEnabled ? format.macroEnabledMime : format.mime
}

function sniffMagicBytes(bytes: Uint8Array): string | null {
  if (bytesStartWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (bytesStartWith(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a')) return 'image/gif'
  if (sniffBmp(bytes)) return 'image/bmp'
  if (bytesStartWith(bytes, 0, [0x49, 0x49, 0x2a, 0x00])) return 'image/tiff' // little-endian
  if (bytesStartWith(bytes, 0, [0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff' // big-endian
  if (bytesStartWith(bytes, 0, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon'
  if (asciiAt(bytes, 0, '%PDF-')) return 'application/pdf'
  // OOXML (.docx/.xlsx/.pptx) is a PKZIP container, so the container is
  // inspected before an archive is reported as a generic one — see
  // `sniffOoxml`. An archive that is not an Office package stays
  // `application/zip`, which no default allow-list admits.
  if (bytesStartWith(bytes, 0, [0x50, 0x4b, 0x03, 0x04])) return sniffOoxml(bytes) ?? 'application/zip'
  if (bytesStartWith(bytes, 0, [0x1f, 0x8b])) return 'application/gzip'
  if (sniffId3(bytes) || bytesStartWith(bytes, 0, [0xff, 0xfb])) return 'audio/mpeg'
  if (asciiAt(bytes, 0, 'OggS')) return 'audio/ogg'

  const ebml = sniffEbml(bytes)
  if (ebml) return ebml

  const riff = sniffRiff(bytes)
  if (riff) return riff

  const ftyp = sniffFtyp(bytes)
  if (ftyp) return ftyp

  return null
}

/** SVG is valid UTF-8 but must round-trip byte-identical (image tools read
 *  it from the box as a file), so it is classified binary. Conservative
 *  match: the document's first element is `<svg`, or an `<?xml` prolog is
 *  followed by an `<svg` element within the first ~1KB (comments/doctype may
 *  sit between). Plain XML without an svg root, or prose that merely
 *  mentions "<svg", stays text. */
function sniffSvgText(decoded: string): boolean {
  let text = decoded
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  text = text.trimStart()
  if (/^<svg[\s>/]/.test(text)) return true
  if (!text.startsWith('<?xml')) return false
  return /<svg[\s>/]/.test(text.slice(0, 1024))
}

/** Decide whether uploaded bytes are binary or text, and identify the mime
 *  type when it can be determined from content. Magic bytes are checked
 *  first; anything unmatched falls back to a fatal UTF-8 decode. A NUL byte
 *  or a decode failure means binary. Valid UTF-8 that is an SVG document is
 *  binary (byte-identity matters for image tooling). Content that matches
 *  nothing and does not decode as text is binary with an unknown mime —
 *  extension-based guessing happens at the call site, not here. */
export function sniffBinary(bytes: Uint8Array): SniffResult {
  const mime = sniffMagicBytes(bytes)
  if (mime) return { binary: true, mime }

  if (bytes.includes(0x00)) return { binary: true, mime: null }

  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { binary: true, mime: null }
  }
  if (sniffSvgText(decoded)) return { binary: true, mime: 'image/svg+xml' }
  return { binary: false, mime: null }
}
