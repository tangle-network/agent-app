/**
 * Reads an uncompressed tar stream in flight without changing its length.
 *
 * It counts members for the manifest and overwrites the contents of known
 * credential files (see `isCredentialFile`) with `*`, so the archive stays a
 * valid tar that still shows the file existed. Handles ustar prefixes, GNU long
 * names (`L`) and pax `path=` records.
 */

import { isCredentialFile } from './secrets'

export interface TarStats {
  files: number
  bytes: number
  blanked: string[]
}

const BLOCK = 512
const MAX_NAME_RECORD = 1 << 20

function readString(block: Uint8Array, start: number, length: number): string {
  let end = start
  while (end < start + length && block[end] !== 0) end += 1
  return new TextDecoder().decode(block.subarray(start, end))
}

function readSize(block: Uint8Array): number {
  // GNU base-256 for sizes over 8 GiB.
  if (block[124]! & 0x80) {
    let size = 0
    for (let i = 125; i < 136; i += 1) size = size * 256 + block[i]!
    return size
  }
  const octal = readString(block, 124, 12).trim()
  return octal ? Number.parseInt(octal, 8) : 0
}

function paxPath(record: string): string | undefined {
  for (const line of record.split('\n')) {
    const space = line.indexOf(' ')
    if (space < 0) continue
    const field = line.slice(space + 1)
    if (field.startsWith('path=')) return field.slice(5)
  }
  return undefined
}

export function createTarInspector(stats: TarStats): TransformStream<Uint8Array, Uint8Array> {
  const header = new Uint8Array(BLOCK)
  let headerFill = 0
  // Bytes of member data (plus padding) still to pass before the next header.
  let dataRemaining = 0
  let paddingRemaining = 0
  let blanking = false
  let capture: { kind: 'L' | 'x'; parts: Uint8Array[]; length: number } | null = null
  let pendingName: string | undefined
  let ended = false

  function onHeader(): void {
    if (header.every((b) => b === 0)) {
      ended = true
      return
    }
    const type = String.fromCharCode(header[156]!)
    const size = readSize(header)
    dataRemaining = size
    paddingRemaining = (BLOCK - (size % BLOCK)) % BLOCK
    blanking = false
    capture = null
    if ((type === 'L' || type === 'x') && size <= MAX_NAME_RECORD) {
      capture = { kind: type, parts: [], length: 0 }
      return
    }
    const prefix = header[257] === 0x75 ? readString(header, 345, 155) : ''
    const base = readString(header, 0, 100)
    const name = pendingName ?? (prefix ? `${prefix}/${base}` : base)
    pendingName = undefined
    if (type === '0' || type === '\0' || type === '7') {
      stats.files += 1
      stats.bytes += size
      if (isCredentialFile(name)) {
        blanking = true
        stats.blanked.push(name)
      }
    }
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const out = chunk.slice()
      let at = 0
      while (at < out.length && !ended) {
        if (dataRemaining > 0) {
          const take = Math.min(dataRemaining, out.length - at)
          if (blanking) out.fill(0x2a, at, at + take)
          if (capture) {
            capture.parts.push(out.slice(at, at + take))
            capture.length += take
          }
          dataRemaining -= take
          at += take
          if (dataRemaining === 0 && capture) {
            const joined = new Uint8Array(capture.length)
            let offset = 0
            for (const part of capture.parts) {
              joined.set(part, offset)
              offset += part.length
            }
            const text = new TextDecoder().decode(joined)
            pendingName = capture.kind === 'L' ? text.replace(/\0+$/, '') : (paxPath(text) ?? pendingName)
            capture = null
          }
          continue
        }
        if (paddingRemaining > 0) {
          const take = Math.min(paddingRemaining, out.length - at)
          paddingRemaining -= take
          at += take
          continue
        }
        const take = Math.min(BLOCK - headerFill, out.length - at)
        header.set(out.subarray(at, at + take), headerFill)
        headerFill += take
        at += take
        if (headerFill === BLOCK) {
          headerFill = 0
          onHeader()
        }
      }
      controller.enqueue(out)
    },
  })
}
