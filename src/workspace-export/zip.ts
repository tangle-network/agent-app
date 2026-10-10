/**
 * Streams a zip whose every entry was already written and measured.
 *
 * Because each entry's CRC-32 and sizes are known before the first byte goes
 * out, local headers carry real values (no data descriptors) and the total
 * length is exact, so the download response can send `Content-Length`. Zip64
 * records are added only when a size, offset or entry count needs them, which
 * keeps small archives readable by every unzip tool.
 */

export interface ZipEntrySpec {
  /** Path inside the archive, `/`-separated, no leading slash. */
  name: string
  /** 0 = stored, 8 = deflate. */
  method: 0 | 8
  crc32: number
  /** Bytes `open()` yields (after compression for method 8). */
  compressedSize: number
  uncompressedSize: number
  modifiedAt: Date
  open(): Promise<ReadableStream<Uint8Array>>
}

const U32_MAX = 0xffffffff
const U16_MAX = 0xffff

interface Layout {
  name: Uint8Array
  localHeader: Uint8Array
  offset: number
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getUTCFullYear())
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  }
}

function setU64(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value % 0x100000000, true)
  view.setUint32(offset + 4, Math.floor(value / 0x100000000), true)
}

function localHeader(entry: ZipEntrySpec, name: Uint8Array): Uint8Array {
  const zip64 = entry.compressedSize >= U32_MAX || entry.uncompressedSize >= U32_MAX
  const extraLength = zip64 ? 20 : 0
  const out = new Uint8Array(30 + name.length + extraLength)
  const view = new DataView(out.buffer)
  const { time, date } = dosDateTime(entry.modifiedAt)
  view.setUint32(0, 0x04034b50, true)
  view.setUint16(4, zip64 ? 45 : 20, true)
  view.setUint16(6, 0x0800, true)
  view.setUint16(8, entry.method, true)
  view.setUint16(10, time, true)
  view.setUint16(12, date, true)
  view.setUint32(14, entry.crc32, true)
  view.setUint32(18, zip64 ? U32_MAX : entry.compressedSize, true)
  view.setUint32(22, zip64 ? U32_MAX : entry.uncompressedSize, true)
  view.setUint16(26, name.length, true)
  view.setUint16(28, extraLength, true)
  out.set(name, 30)
  if (zip64) {
    const at = 30 + name.length
    view.setUint16(at, 0x0001, true)
    view.setUint16(at + 2, 16, true)
    setU64(view, at + 4, entry.uncompressedSize)
    setU64(view, at + 12, entry.compressedSize)
  }
  return out
}

function centralHeader(entry: ZipEntrySpec, layout: Layout): Uint8Array {
  const bigU = entry.uncompressedSize >= U32_MAX
  const bigC = entry.compressedSize >= U32_MAX
  const bigO = layout.offset >= U32_MAX
  const extraFields = (bigU ? 1 : 0) + (bigC ? 1 : 0) + (bigO ? 1 : 0)
  const extraLength = extraFields ? 4 + extraFields * 8 : 0
  const name = layout.name
  const out = new Uint8Array(46 + name.length + extraLength)
  const view = new DataView(out.buffer)
  const { time, date } = dosDateTime(entry.modifiedAt)
  const version = extraFields ? 45 : 20
  view.setUint32(0, 0x02014b50, true)
  view.setUint16(4, (3 << 8) | version, true)
  view.setUint16(6, version, true)
  view.setUint16(8, 0x0800, true)
  view.setUint16(10, entry.method, true)
  view.setUint16(12, time, true)
  view.setUint16(14, date, true)
  view.setUint32(16, entry.crc32, true)
  view.setUint32(20, bigC ? U32_MAX : entry.compressedSize, true)
  view.setUint32(24, bigU ? U32_MAX : entry.uncompressedSize, true)
  view.setUint16(28, name.length, true)
  view.setUint16(30, extraLength, true)
  view.setUint32(38, (0o100644 << 16) >>> 0, true)
  view.setUint32(42, bigO ? U32_MAX : layout.offset, true)
  out.set(name, 46)
  if (extraFields) {
    let at = 46 + name.length
    view.setUint16(at, 0x0001, true)
    view.setUint16(at + 2, extraFields * 8, true)
    at += 4
    if (bigU) {
      setU64(view, at, entry.uncompressedSize)
      at += 8
    }
    if (bigC) {
      setU64(view, at, entry.compressedSize)
      at += 8
    }
    if (bigO) setU64(view, at, layout.offset)
  }
  return out
}

function endRecords(count: number, cdOffset: number, cdSize: number): Uint8Array {
  const zip64 = count >= U16_MAX || cdOffset >= U32_MAX || cdSize >= U32_MAX
  const out = new Uint8Array((zip64 ? 56 + 20 : 0) + 22)
  const view = new DataView(out.buffer)
  let at = 0
  if (zip64) {
    view.setUint32(0, 0x06064b50, true)
    setU64(view, 4, 44)
    view.setUint16(12, (3 << 8) | 45, true)
    view.setUint16(14, 45, true)
    setU64(view, 24, count)
    setU64(view, 32, count)
    setU64(view, 40, cdSize)
    setU64(view, 48, cdOffset)
    view.setUint32(56, 0x07064b50, true)
    setU64(view, 64, cdOffset + cdSize)
    view.setUint32(72, 1, true)
    at = 76
  }
  view.setUint32(at, 0x06054b50, true)
  view.setUint16(at + 8, zip64 ? U16_MAX : count, true)
  view.setUint16(at + 10, zip64 ? U16_MAX : count, true)
  view.setUint32(at + 12, zip64 ? U32_MAX : cdSize, true)
  view.setUint32(at + 16, zip64 ? U32_MAX : cdOffset, true)
  return out
}

/** Lay out the archive and return its exact byte length and body stream. */
export function createZipStream(entries: ZipEntrySpec[]): { length: number; stream: ReadableStream<Uint8Array> } {
  const encoder = new TextEncoder()
  const layouts: Layout[] = []
  let offset = 0
  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const header = localHeader(entry, name)
    layouts.push({ name, localHeader: header, offset })
    offset += header.length + entry.compressedSize
  }
  const central = entries.map((entry, i) => centralHeader(entry, layouts[i]!))
  const cdSize = central.reduce((sum, part) => sum + part.length, 0)
  const end = endRecords(entries.length, offset, cdSize)
  const length = offset + cdSize + end.length

  let index = 0
  let phase: 'entries' | 'tail' | 'done' = 'entries'
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let written = 0

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (phase === 'entries') {
        if (reader) {
          const { done, value } = await reader.read()
          if (!done) {
            written += value.length
            controller.enqueue(value)
            return
          }
          reader = null
          const expected = entries[index]!.compressedSize
          if (written !== expected) {
            controller.error(new Error(`zip entry ${entries[index]!.name} produced ${written} bytes, expected ${expected}`))
            return
          }
          index += 1
        }
        if (index < entries.length) {
          controller.enqueue(layouts[index]!.localHeader)
          written = 0
          reader = (await entries[index]!.open()).getReader()
          return
        }
        phase = 'tail'
      }
      if (phase === 'tail') {
        for (const part of central) controller.enqueue(part)
        controller.enqueue(end)
        phase = 'done'
        controller.close()
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason)
    },
  })
  return { length, stream }
}
