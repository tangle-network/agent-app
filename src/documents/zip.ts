/**
 * The slice of PKZIP an OOXML package needs: read the central directory, then
 * inflate one named entry.
 *
 * Why not a zip library: DOCX text extraction is the only reason this module
 * needs a zip, and the runtime already supplies the hard part —
 * `DecompressionStream('deflate-raw')` is a standard API present in workerd
 * and in Node, so the whole reader is header arithmetic plus a stream. Pulling
 * a zip package in would put ten transitive Node-shaped dependencies into every
 * consumer's Worker bundle to avoid ~120 lines.
 *
 * The CENTRAL DIRECTORY is the source of truth, not the local headers: an
 * archive written with data descriptors (streamed output) carries zeros for
 * the sizes in its local headers, and reading those is the classic way a
 * hand-rolled zip reader silently returns nothing.
 */

const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_FILE_HEADER = 0x02014b50
const LOCAL_FILE_HEADER = 0x04034b50
const ZIP64_SENTINEL_32 = 0xffffffff
const ZIP64_SENTINEL_16 = 0xffff
const MAX_COMMENT_LENGTH = 0xffff
const END_OF_CENTRAL_DIRECTORY_SIZE = 22
const STORED = 0
const DEFLATED = 8

export type ZipOutcome<T> = { succeeded: true; value: T } | { succeeded: false; error: string }

export interface ZipEntry {
  readonly name: string
  readonly compressionMethod: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly localHeaderOffset: number
  readonly encrypted: boolean
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/**
 * Scan back from the tail for the end-of-central-directory record.
 *
 * The record's own comment length must account for exactly the bytes that
 * follow it, or the "signature" is compressed data (or an appended decoy) that
 * happens to spell `PK\x05\x06`. Without that check this reader and the upload
 * gate's reader resolve DIFFERENT records on the same bytes — the gate approves
 * one archive and the extractor reads another.
 */
function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const dv = view(bytes)
  const earliest = Math.max(0, bytes.byteLength - END_OF_CENTRAL_DIRECTORY_SIZE - MAX_COMMENT_LENGTH)
  for (let offset = bytes.byteLength - END_OF_CENTRAL_DIRECTORY_SIZE; offset >= earliest; offset--) {
    if (dv.getUint32(offset, true) !== END_OF_CENTRAL_DIRECTORY) continue
    if (offset + END_OF_CENTRAL_DIRECTORY_SIZE + dv.getUint16(offset + 20, true) === bytes.byteLength) return offset
  }
  return -1
}

/** Read every central-directory entry. Names are decoded as UTF-8, which is
 *  what OOXML producers write (general-purpose bit 11). */
export function readZipDirectory(bytes: Uint8Array): ZipOutcome<ZipEntry[]> {
  if (bytes.byteLength < END_OF_CENTRAL_DIRECTORY_SIZE) {
    return { succeeded: false, error: `not a zip archive — ${bytes.byteLength} bytes is shorter than an empty archive` }
  }
  const eocd = findEndOfCentralDirectory(bytes)
  if (eocd < 0) {
    return { succeeded: false, error: 'not a zip archive — no end-of-central-directory record found' }
  }
  const dv = view(bytes)
  const entryCount = dv.getUint16(eocd + 10, true)
  const directoryOffset = dv.getUint32(eocd + 16, true)
  if (entryCount === ZIP64_SENTINEL_16 || directoryOffset === ZIP64_SENTINEL_32) {
    return { succeeded: false, error: 'zip64 archives are not supported' }
  }

  const decoder = new TextDecoder('utf-8', { fatal: false })
  const entries: ZipEntry[] = []
  let cursor = directoryOffset
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > bytes.byteLength || dv.getUint32(cursor, true) !== CENTRAL_FILE_HEADER) {
      return { succeeded: false, error: `central directory is truncated at entry ${i + 1} of ${entryCount}` }
    }
    const flags = dv.getUint16(cursor + 8, true)
    const nameLength = dv.getUint16(cursor + 28, true)
    const extraLength = dv.getUint16(cursor + 30, true)
    const commentLength = dv.getUint16(cursor + 32, true)
    entries.push({
      name: decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)),
      compressionMethod: dv.getUint16(cursor + 10, true),
      compressedSize: dv.getUint32(cursor + 20, true),
      uncompressedSize: dv.getUint32(cursor + 24, true),
      localHeaderOffset: dv.getUint32(cursor + 42, true),
      encrypted: (flags & 0x0001) !== 0,
    })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return { succeeded: true, value: entries }
}

/**
 * Ceiling on what ONE entry may expand to. A deflate stream reaches ~1000:1 on
 * repetitive input, so an archive small enough to pass any upload gate can ask
 * for gigabytes: measured here, a 305,893-byte archive declared a single entry
 * expanding to 314,572,800 bytes. A Cloudflare Worker isolate has 128 MB, so
 * that is an out-of-memory crash, not a slow path — and a crash is not a typed
 * error a product can report. 32 MB is far past any real Office part (the main
 * document of a 400-page contract is single-digit MB) and far under the
 * isolate's budget.
 */
export const DEFAULT_MAX_ZIP_ENTRY_BYTES = 32 * 1024 * 1024

/** How an inflate finished. `limit-exceeded` carries the byte count reached so
 *  the caller can name it, and the stream is cancelled at that point rather
 *  than drained. */
type InflateResult =
  | { readonly kind: 'ok'; readonly value: Uint8Array }
  | { readonly kind: 'limit-exceeded'; readonly bytes: number }

/**
 * Inflate a deflate-raw payload, bounded AS IT STREAMS.
 *
 * The bound cannot come from the declared `uncompressedSize` alone: that number
 * is attacker-supplied and the check that compares it to the real output can
 * only run once the output exists. Counting chunks and cancelling mid-stream is
 * what makes the ceiling real — the allocation never happens.
 */
async function inflateRaw(payload: Uint8Array, limit: number): Promise<InflateResult> {
  const body = new Response(payload as BodyInit).body
  if (!body) throw new Error('payload produced no readable stream')
  const reader = body.pipeThrough(new DecompressionStream('deflate-raw')).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      return { kind: 'limit-exceeded', bytes: total }
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { kind: 'ok', value: out }
}

/** Options for {@link readZipEntry}. */
export interface ReadZipEntryOptions {
  /** Ceiling on the entry's UNCOMPRESSED size. Defaults to
   *  {@link DEFAULT_MAX_ZIP_ENTRY_BYTES}. Checked against the directory's
   *  declared size before any inflate runs, and again against the real output
   *  as it streams, because the declared size is the archive's claim. */
  readonly maxUncompressedBytes?: number
}

/** Inflate one entry's bytes. The local header supplies only the variable-length
 *  field sizes needed to find the payload; sizes come from the directory. */
export async function readZipEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
  options: ReadZipEntryOptions = {},
): Promise<ZipOutcome<Uint8Array>> {
  if (entry.encrypted) {
    return { succeeded: false, error: `'${entry.name}' is encrypted — password-protected archives are not supported` }
  }
  const limit = options.maxUncompressedBytes ?? DEFAULT_MAX_ZIP_ENTRY_BYTES
  if (entry.uncompressedSize > limit) {
    return {
      succeeded: false,
      error: `'${entry.name}' declares ${entry.uncompressedSize} uncompressed bytes, over the ${limit}-byte per-entry limit`,
    }
  }
  const dv = view(bytes)
  if (entry.localHeaderOffset + 30 > bytes.byteLength || dv.getUint32(entry.localHeaderOffset, true) !== LOCAL_FILE_HEADER) {
    return { succeeded: false, error: `'${entry.name}' has no local file header at offset ${entry.localHeaderOffset}` }
  }
  const nameLength = dv.getUint16(entry.localHeaderOffset + 26, true)
  const extraLength = dv.getUint16(entry.localHeaderOffset + 28, true)
  const start = entry.localHeaderOffset + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (end > bytes.byteLength) {
    return { succeeded: false, error: `'${entry.name}' payload runs past the end of the archive` }
  }
  const payload = bytes.subarray(start, end)

  if (entry.compressionMethod === STORED) return { succeeded: true, value: payload }
  if (entry.compressionMethod !== DEFLATED) {
    return { succeeded: false, error: `'${entry.name}' uses unsupported compression method ${entry.compressionMethod}` }
  }
  try {
    const inflated = await inflateRaw(payload, limit)
    if (inflated.kind === 'limit-exceeded') {
      // The directory under-declared the size. Reported as the limit breach it
      // is, not as the size mismatch below — the mismatch check runs on bytes
      // that were allocated, and these deliberately never were.
      return {
        succeeded: false,
        error: `'${entry.name}' expands past the ${limit}-byte per-entry limit (declared ${entry.uncompressedSize})`,
      }
    }
    if (inflated.value.byteLength !== entry.uncompressedSize) {
      return {
        succeeded: false,
        error: `'${entry.name}' inflated to ${inflated.value.byteLength} bytes but the directory declares ${entry.uncompressedSize}`,
      }
    }
    return { succeeded: true, value: inflated.value }
  } catch (error) {
    return { succeeded: false, error: `'${entry.name}' failed to inflate — ${error instanceof Error ? error.message : String(error)}` }
  }
}
