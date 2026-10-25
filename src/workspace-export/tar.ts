/**
 * Reads an uncompressed tar stream in flight.
 *
 * It counts members for the manifest, overwrites the contents of known
 * credential files (see `isCredentialFile`) with `*` so the archive still shows
 * the file existed, and drops every member under an excluded directory name
 * (`node_modules`, runtime caches) with its long-name records, so the result
 * stays a valid tar. Handles ustar prefixes, GNU long names (`L`) and pax
 * `path=` records.
 */

import { isCredentialFile } from './secrets'

export interface TarStats {
  files: number
  bytes: number
  blanked: string[]
  /** Members dropped because a path segment is excluded. */
  excluded?: number
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

export function createTarInspector(stats: TarStats, exclude: readonly string[] = []): TransformStream<Uint8Array, Uint8Array> {
  const excluded = new Set(exclude)
  const header = new Uint8Array(BLOCK)
  let headerFill = 0
  // Bytes of member data (plus padding) still to pass before the next header.
  let dataRemaining = 0
  let paddingRemaining = 0
  // What happens to the current member's data: passed through, withheld until
  // the member it names is known (long-name records), or dropped.
  let mode: 'pass' | 'hold' | 'drop' = 'pass'
  let blanking = false
  let capture: { kind: 'L' | 'x'; parts: Uint8Array[]; length: number } | null = null
  let pendingName: string | undefined
  // Long-name records waiting for the header they describe.
  let held: Uint8Array[] = []
  let ended = false

  // Excluded directories and AppleDouble metadata must not cross the archive boundary.
  const isExcluded = (name: string) => excluded.size > 0 && name.split('/').some((segment) => excluded.has(segment) || segment.startsWith('._'))

  function onHeader(emit: (bytes: Uint8Array) => void): void {
    const block = header.slice()
    if (block.every((b) => b === 0)) {
      ended = true
      for (const part of held) emit(part)
      held = []
      emit(block)
      emit(block)
      return
    }
    const type = String.fromCharCode(block[156]!)
    const size = readSize(block)
    dataRemaining = size
    paddingRemaining = (BLOCK - (size % BLOCK)) % BLOCK
    blanking = false
    capture = null
    if ((type === 'L' || type === 'x') && size <= MAX_NAME_RECORD) {
      capture = { kind: type, parts: [], length: 0 }
      held.push(block)
      mode = 'hold'
      return
    }
    const prefix = block[257] === 0x75 ? readString(block, 345, 155) : ''
    const base = readString(block, 0, 100)
    const name = pendingName ?? (prefix ? `${prefix}/${base}` : base)
    pendingName = undefined
    if (isExcluded(name)) {
      held = []
      mode = 'drop'
      if (type === '0' || type === '\0' || type === '7') stats.excluded = (stats.excluded ?? 0) + 1
      return
    }
    for (const part of held) emit(part)
    held = []
    emit(block)
    mode = 'pass'
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
      const out: Uint8Array[] = []
      const emit = (bytes: Uint8Array) => out.push(bytes)
      const route = (bytes: Uint8Array) => {
        if (mode === 'pass') emit(bytes)
        else if (mode === 'hold') held.push(bytes)
      }
      let at = 0
      while (at < chunk.length) {
        if (ended) {
          emit(chunk.slice(at))
          break
        }
        if (dataRemaining > 0) {
          const take = Math.min(dataRemaining, chunk.length - at)
          const data = chunk.slice(at, at + take)
          if (blanking) data.fill(0x2a)
          if (capture) {
            capture.parts.push(data)
            capture.length += take
          }
          route(data)
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
          const take = Math.min(paddingRemaining, chunk.length - at)
          route(chunk.slice(at, at + take))
          paddingRemaining -= take
          at += take
          continue
        }
        const take = Math.min(BLOCK - headerFill, chunk.length - at)
        header.set(chunk.subarray(at, at + take), headerFill)
        headerFill += take
        at += take
        if (headerFill === BLOCK) {
          headerFill = 0
          onHeader(emit)
        }
      }
      if (out.length === 1) controller.enqueue(out[0]!)
      else if (out.length) {
        const length = out.reduce((n, part) => n + part.length, 0)
        const joined = new Uint8Array(length)
        let offset = 0
        for (const part of out) {
          joined.set(part, offset)
          offset += part.length
        }
        controller.enqueue(joined)
      }
    },
    flush(controller) {
      // A stream that ends without its end-of-archive blocks still keeps what it held.
      for (const part of held) controller.enqueue(part)
      held = []
    },
  })
}
