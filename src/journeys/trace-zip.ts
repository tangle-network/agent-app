/**
 * The slice of PKZIP a Playwright trace needs: read every entry of an archive
 * on disk one at a time, and write a new archive entry by entry.
 *
 * Why not `documents/zip`: that reader holds the archive in memory and refuses
 * zip64, and a recorded hour-long journey's trace is 6.6 GB with 49,117
 * entries (measured on 2026-10-11), so offsets pass 4 GiB. This reader keeps
 * one entry in memory at a time and reads the zip64 records; the writer emits
 * zip64 fields only when a size, an offset or the entry count needs them.
 */
import { closeSync, fstatSync, openSync, readSync, writeSync } from 'node:fs'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { crc32Update } from '../workspace-export/checksum.js'

const EOCD = 0x06054b50
const ZIP64_EOCD = 0x06064b50
const ZIP64_LOCATOR = 0x07064b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const U16 = 0xffff
const U32 = 0xffffffff

interface ZipEntryInfo {
  readonly name: string
  readonly method: number
  readonly crc32: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly localOffset: number
  readonly dosTime: number
  readonly dosDate: number
}

function readAt(fd: number, position: number, length: number): Buffer {
  const out = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const n = readSync(fd, out, done, length - done, position + done)
    if (n === 0) throw new Error(`zip: unexpected end of file at ${position + done}`)
    done += n
  }
  return out
}

const u64 = (b: Buffer, at: number) => Number(b.readBigUInt64LE(at))

/** Every entry in the central directory, sizes and offsets resolved through zip64 extras. */
export function readCentralDirectory(fd: number): ZipEntryInfo[] {
  const size = fstatSync(fd).size
  const tailLength = Math.min(size, 22 + U16 + 20)
  const tail = readAt(fd, size - tailLength, tailLength)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === EOCD && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip: no end-of-central-directory record')
  let count = tail.readUInt16LE(eocd + 10)
  let cdSize = tail.readUInt32LE(eocd + 12)
  let cdOffset = tail.readUInt32LE(eocd + 16)
  if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === ZIP64_LOCATOR) {
    const record = readAt(fd, u64(tail, eocd - 20 + 8), 56)
    if (record.readUInt32LE(0) !== ZIP64_EOCD) throw new Error('zip: zip64 locator points at no zip64 record')
    count = u64(record, 32)
    cdSize = u64(record, 40)
    cdOffset = u64(record, 48)
  }
  const cd = readAt(fd, cdOffset, cdSize)
  const entries: ZipEntryInfo[] = []
  let at = 0
  for (let i = 0; i < count; i += 1) {
    if (cd.readUInt32LE(at) !== CENTRAL) throw new Error(`zip: central directory is broken at entry ${i + 1} of ${count}`)
    const nameLength = cd.readUInt16LE(at + 28)
    const extraLength = cd.readUInt16LE(at + 30)
    const commentLength = cd.readUInt16LE(at + 32)
    let compressedSize = cd.readUInt32LE(at + 20)
    let uncompressedSize = cd.readUInt32LE(at + 24)
    let localOffset = cd.readUInt32LE(at + 42)
    const extra = cd.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength)
    for (let e = 0; e + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(e)
      const len = extra.readUInt16LE(e + 2)
      if (id === 0x0001) {
        // Present in this order, and only for the fields set to 0xffffffff.
        let p = e + 4
        if (uncompressedSize === U32) { uncompressedSize = u64(extra, p); p += 8 }
        if (compressedSize === U32) { compressedSize = u64(extra, p); p += 8 }
        if (localOffset === U32) { localOffset = u64(extra, p); p += 8 }
      }
      e += 4 + len
    }
    entries.push({
      name: cd.toString('utf8', at + 46, at + 46 + nameLength),
      method: cd.readUInt16LE(at + 10),
      crc32: cd.readUInt32LE(at + 16),
      compressedSize,
      uncompressedSize,
      localOffset,
      dosTime: cd.readUInt16LE(at + 12),
      dosDate: cd.readUInt16LE(at + 14),
    })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** One entry's stored bytes, still compressed. */
export function readRaw(fd: number, entry: ZipEntryInfo): Buffer {
  const local = readAt(fd, entry.localOffset, 30)
  if (local.readUInt32LE(0) !== LOCAL) throw new Error(`zip: '${entry.name}' has no local header`)
  const start = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
  return readAt(fd, start, entry.compressedSize)
}

/** One entry's content. */
export function inflateEntry(entry: ZipEntryInfo, raw: Buffer): Buffer {
  if (entry.method === 0) return raw
  if (entry.method === 8) return inflateRawSync(raw)
  throw new Error(`zip: '${entry.name}' uses unsupported compression method ${entry.method}`)
}

interface ZipWriter {
  /** Add an entry from its content (deflated here). */
  add(name: string, content: Buffer, from?: Pick<ZipEntryInfo, 'dosTime' | 'dosDate'>): void
  /** Add an entry exactly as another archive stored it. */
  copy(entry: ZipEntryInfo, raw: Buffer): void
  close(): void
}

interface Written {
  name: Buffer
  method: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  offset: number
  dosTime: number
  dosDate: number
}

/** Write a zip to `path`, entries in the order added. `forceZip64` exercises the large-archive records in tests. */
export function createZipWriter(path: string, opts: { forceZip64?: boolean } = {}): ZipWriter {
  const fd = openSync(path, 'w', 0o600)
  let position = 0
  const written: Written[] = []
  const put = (b: Buffer) => {
    let done = 0
    while (done < b.length) done += writeSync(fd, b, done, b.length - done)
    position += b.length
  }
  const big = (n: number) => opts.forceZip64 === true || n >= U32
  const writeEntry = (w: Omit<Written, 'offset'>, data: Buffer) => {
    const zip64 = big(w.compressedSize) || big(w.uncompressedSize)
    const header = Buffer.alloc(30 + w.name.length + (zip64 ? 20 : 0))
    header.writeUInt32LE(LOCAL, 0)
    header.writeUInt16LE(zip64 ? 45 : 20, 4)
    header.writeUInt16LE(0x0800, 6)
    header.writeUInt16LE(w.method, 8)
    header.writeUInt16LE(w.dosTime, 10)
    header.writeUInt16LE(w.dosDate, 12)
    header.writeUInt32LE(w.crc32, 14)
    header.writeUInt32LE(zip64 ? U32 : w.compressedSize, 18)
    header.writeUInt32LE(zip64 ? U32 : w.uncompressedSize, 22)
    header.writeUInt16LE(w.name.length, 26)
    header.writeUInt16LE(zip64 ? 20 : 0, 28)
    w.name.copy(header, 30)
    if (zip64) {
      const e = 30 + w.name.length
      header.writeUInt16LE(0x0001, e)
      header.writeUInt16LE(16, e + 2)
      header.writeBigUInt64LE(BigInt(w.uncompressedSize), e + 4)
      header.writeBigUInt64LE(BigInt(w.compressedSize), e + 12)
    }
    const offset = position
    put(header)
    put(data)
    written.push({ ...w, offset })
  }
  return {
    add(name, content, from) {
      const data = deflateRawSync(content)
      writeEntry({
        name: Buffer.from(name, 'utf8'),
        method: 8,
        crc32: crc32Update(0, content),
        compressedSize: data.length,
        uncompressedSize: content.length,
        dosTime: from?.dosTime ?? 0,
        dosDate: from?.dosDate ?? 0x21,
      }, data)
    },
    copy(entry, raw) {
      writeEntry({
        name: Buffer.from(entry.name, 'utf8'),
        method: entry.method,
        crc32: entry.crc32,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
        dosTime: entry.dosTime,
        dosDate: entry.dosDate,
      }, raw)
    },
    close() {
      const cdOffset = position
      for (const w of written) {
        const fields: bigint[] = []
        if (big(w.uncompressedSize)) fields.push(BigInt(w.uncompressedSize))
        if (big(w.compressedSize)) fields.push(BigInt(w.compressedSize))
        if (big(w.offset)) fields.push(BigInt(w.offset))
        const extraLength = fields.length ? 4 + 8 * fields.length : 0
        const h = Buffer.alloc(46 + w.name.length + extraLength)
        h.writeUInt32LE(CENTRAL, 0)
        h.writeUInt16LE(45, 4)
        h.writeUInt16LE(fields.length ? 45 : 20, 6)
        h.writeUInt16LE(0x0800, 8)
        h.writeUInt16LE(w.method, 10)
        h.writeUInt16LE(w.dosTime, 12)
        h.writeUInt16LE(w.dosDate, 14)
        h.writeUInt32LE(w.crc32, 16)
        h.writeUInt32LE(big(w.compressedSize) ? U32 : w.compressedSize, 20)
        h.writeUInt32LE(big(w.uncompressedSize) ? U32 : w.uncompressedSize, 24)
        h.writeUInt16LE(w.name.length, 28)
        h.writeUInt16LE(extraLength, 30)
        h.writeUInt32LE(big(w.offset) ? U32 : w.offset, 42)
        w.name.copy(h, 46)
        if (fields.length) {
          const e = 46 + w.name.length
          h.writeUInt16LE(0x0001, e)
          h.writeUInt16LE(8 * fields.length, e + 2)
          fields.forEach((v, i) => h.writeBigUInt64LE(v, e + 4 + 8 * i))
        }
        put(h)
      }
      const cdSize = position - cdOffset
      const count = written.length
      const zip64 = opts.forceZip64 === true || count >= U16 || cdOffset >= U32 || cdSize >= U32
      if (zip64) {
        const recordOffset = position
        const r = Buffer.alloc(56)
        r.writeUInt32LE(ZIP64_EOCD, 0)
        r.writeBigUInt64LE(44n, 4)
        r.writeUInt16LE(45, 12)
        r.writeUInt16LE(45, 14)
        r.writeBigUInt64LE(BigInt(count), 24)
        r.writeBigUInt64LE(BigInt(count), 32)
        r.writeBigUInt64LE(BigInt(cdSize), 40)
        r.writeBigUInt64LE(BigInt(cdOffset), 48)
        put(r)
        const l = Buffer.alloc(20)
        l.writeUInt32LE(ZIP64_LOCATOR, 0)
        l.writeBigUInt64LE(BigInt(recordOffset), 8)
        l.writeUInt32LE(1, 16)
        put(l)
      }
      const end = Buffer.alloc(22)
      end.writeUInt32LE(EOCD, 0)
      end.writeUInt16LE(zip64 ? U16 : count, 8)
      end.writeUInt16LE(zip64 ? U16 : count, 10)
      end.writeUInt32LE(zip64 ? U32 : cdSize, 12)
      end.writeUInt32LE(zip64 ? U32 : cdOffset, 16)
      put(end)
      closeSync(fd)
    },
  }
}
