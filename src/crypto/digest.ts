/** Lowercase-hex SHA-256 of a UTF-8 string or a byte range. WebCrypto only. */
export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string'
    ? new TextEncoder().encode(value)
    : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
