/**
 * ULID — a 26-character Crockford-base32 id: a 48-bit millisecond timestamp
 * followed by 80 bits from `crypto.getRandomValues`.
 *
 * The record store mints ids in application code rather than taking a column
 * default, because an atomic supersede stamps the REPLACEMENT's id onto the
 * outgoing head in the same write — the id has to exist before the insert.
 * Lexicographic order approximates creation order, which keeps a raw table
 * scan readable; strict fold ordering comes from `seq`, never from the id.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const MAX_TIMESTAMP = 2 ** 48 - 1

/** Mint a ULID. `now` is exposed so a caller can pin time in a test. */
export function recordUlid(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIMESTAMP) {
    throw new Error(`recordUlid: timestamp out of range: ${now}`)
  }
  let time = now
  const chars = new Array<string>(26)
  for (let i = 9; i >= 0; i--) {
    chars[i] = ENCODING[time % 32] as string
    time = Math.floor(time / 32)
  }
  const bytes = new Uint8Array(10)
  crypto.getRandomValues(bytes)
  // 80 random bits → 16 base-32 characters through a rolling bit buffer.
  let buffer = 0
  let bits = 0
  let out = 10
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      chars[out++] = ENCODING[(buffer >>> (bits - 5)) & 31] as string
      bits -= 5
    }
  }
  return chars.join('')
}
