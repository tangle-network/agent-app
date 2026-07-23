/**
 * Content-based binary/text classification, shared by the attachment upload
 * route (server) and the composer's client-side pre-validation (browser) —
 * both sides must agree on what counts as binary before a byte ever leaves
 * the client. Extension-based allowlists lie (a renamed `.docx`, a PNG saved
 * as `.txt`), so classification reads the actual bytes: a magic-byte table
 * for common binary formats first, then a UTF-8 decode attempt for
 * everything else.
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

function sniffMagicBytes(bytes: Uint8Array): string | null {
  if (bytesStartWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (bytesStartWith(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a')) return 'image/gif'
  if (sniffBmp(bytes)) return 'image/bmp'
  if (bytesStartWith(bytes, 0, [0x49, 0x49, 0x2a, 0x00])) return 'image/tiff' // little-endian
  if (bytesStartWith(bytes, 0, [0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff' // big-endian
  if (bytesStartWith(bytes, 0, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon'
  if (asciiAt(bytes, 0, '%PDF-')) return 'application/pdf'
  // OOXML (.docx/.xlsx/.pptx) is a zip archive; the container format is all
  // that matters here, so no attempt is made to distinguish the payload.
  if (bytesStartWith(bytes, 0, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip'
  if (bytesStartWith(bytes, 0, [0x1f, 0x8b])) return 'application/gzip'
  if (sniffId3(bytes) || bytesStartWith(bytes, 0, [0xff, 0xfb])) return 'audio/mpeg'
  if (asciiAt(bytes, 0, 'OggS')) return 'audio/ogg'

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
