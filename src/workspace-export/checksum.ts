/**
 * Incremental CRC-32 (the zip checksum) and SHA-256 (the manifest checksum).
 *
 * Both run over a stream one chunk at a time so an export never buffers a whole
 * file. SHA-256 uses the Workers-native `crypto.DigestStream` when present and a
 * small pure implementation otherwise (Node, tests); both produce identical hex.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** Continue a CRC-32 over `bytes`. Start with `0`; the result is the finished CRC. */
export function crc32Update(crc: number, bytes: Uint8Array): number {
  let c = (crc ^ 0xffffffff) >>> 0
  for (let i = 0; i < bytes.length; i += 1) c = (CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)) >>> 0
  return (c ^ 0xffffffff) >>> 0
}

export interface Sha256Hasher {
  update(bytes: Uint8Array): Promise<void>
  digestHex(): Promise<string>
}

interface DigestStreamLike extends WritableStream<Uint8Array> {
  digest: Promise<ArrayBuffer>
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** A streaming SHA-256. Prefers the runtime's native digest stream. */
export function createSha256(): Sha256Hasher {
  const DigestStream = (globalThis.crypto as unknown as {
    DigestStream?: new (algorithm: string) => DigestStreamLike
  }).DigestStream
  if (DigestStream) {
    const stream = new DigestStream('SHA-256')
    const writer = stream.getWriter()
    return {
      update: (bytes) => writer.write(bytes),
      async digestHex() {
        await writer.close()
        return toHex(new Uint8Array(await stream.digest))
      },
    }
  }
  const pure = new PureSha256()
  return {
    async update(bytes) {
      pure.update(bytes)
    },
    async digestHex() {
      return toHex(pure.digest())
    },
  }
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

class PureSha256 {
  private h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  private block = new Uint8Array(64)
  private blockLength = 0
  private totalLength = 0
  private w = new Uint32Array(64)

  update(bytes: Uint8Array): void {
    this.totalLength += bytes.length
    let offset = 0
    while (offset < bytes.length) {
      const take = Math.min(64 - this.blockLength, bytes.length - offset)
      this.block.set(bytes.subarray(offset, offset + take), this.blockLength)
      this.blockLength += take
      offset += take
      if (this.blockLength === 64) {
        this.compress(this.block)
        this.blockLength = 0
      }
    }
  }

  digest(): Uint8Array {
    const bitLength = this.totalLength * 8
    const padLength = this.blockLength < 56 ? 56 - this.blockLength : 120 - this.blockLength
    const pad = new Uint8Array(padLength + 8)
    pad[0] = 0x80
    const view = new DataView(pad.buffer)
    view.setUint32(padLength, Math.floor(bitLength / 0x100000000))
    view.setUint32(padLength + 4, bitLength >>> 0)
    const total = this.totalLength
    this.update(pad)
    this.totalLength = total
    const out = new Uint8Array(32)
    const outView = new DataView(out.buffer)
    for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, this.h[i]!)
    return out
  }

  private compress(chunk: Uint8Array): void {
    const w = this.w
    const view = new DataView(chunk.buffer, chunk.byteOffset, 64)
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(i * 4)
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15]!
      const b = w[i - 2]!
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = this.h as unknown as number[]
    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e! >>> 6) | (e! << 26)) ^ ((e! >>> 11) | (e! << 21)) ^ ((e! >>> 25) | (e! << 7))
      const ch = (e! & f!) ^ (~e! & g!)
      const t1 = (h! + S1 + ch + K[i]! + w[i]!) >>> 0
      const S0 = ((a! >>> 2) | (a! << 30)) ^ ((a! >>> 13) | (a! << 19)) ^ ((a! >>> 22) | (a! << 10))
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!)
      const t2 = (S0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d! + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    this.h[0] = (this.h[0]! + a!) >>> 0
    this.h[1] = (this.h[1]! + b!) >>> 0
    this.h[2] = (this.h[2]! + c!) >>> 0
    this.h[3] = (this.h[3]! + d!) >>> 0
    this.h[4] = (this.h[4]! + e!) >>> 0
    this.h[5] = (this.h[5]! + f!) >>> 0
    this.h[6] = (this.h[6]! + g!) >>> 0
    this.h[7] = (this.h[7]! + h!) >>> 0
  }
}
