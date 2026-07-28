/**
 * The blank a form is filled from — embedded, pinned, and never fetched at
 * fill time.
 *
 * A renderer that downloads its own blank works on a developer laptop and
 * fails in both places these products actually run: a Cloudflare Worker has no
 * business making an outbound call mid-request, and a sandbox container's
 * egress proxy refuses the agencies' own hosts (measured on tax-agent:
 * `www.irs.gov` CONNECT tunnel 403 while pypi and npm returned 200). A
 * form-filler that cannot reach its blank does not fail loudly — it degrades
 * into an agent describing the form in prose, which is the exact behaviour
 * this module exists to end.
 *
 * Pinning the bytes by digest also pins the artifact: a filing made against
 * the 2025 revision is reproducible from the committed bytes, and an agency
 * revision shows up as a diff of the recorded checksum instead of silently
 * changing under a live URL.
 */

/** A blank form's bytes, base64-encoded, with the provenance to check them. */
export interface FormBlank {
  /** Base64 of the PDF exactly as the agency published it. */
  base64: string
  /** SHA-256 of the decoded bytes, lowercase hex. */
  sha256: string
  /** Where the bytes came from. Provenance for a reviewer, not a fetch target. */
  sourceUrl: string
  /** Decoded length in bytes. A cheap first check that the base64 is intact. */
  byteLength: number
}

const decoded = new WeakMap<FormBlank, Uint8Array>()

/**
 * Decode a blank once per isolate.
 *
 * Keyed on the blank OBJECT rather than a module-level singleton, because a
 * product carries several forms and a single cached slot would serve one
 * form's bytes for another's fill — a failure that produces a plausible PDF
 * and no error at all.
 */
export function decodeFormBlank(blank: FormBlank): Uint8Array {
  const cached = decoded.get(blank)
  if (cached) return cached
  const binary = atob(blank.base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  if (bytes.length !== blank.byteLength) {
    throw new Error(
      `blank form is ${bytes.length} bytes but declares ${blank.byteLength} — the embedded base64 is truncated`,
    )
  }
  decoded.set(blank, bytes)
  return bytes
}

/** Lowercase-hex SHA-256 of a byte range. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const digest = await crypto.subtle.digest('SHA-256', view as ArrayBuffer)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Prove the embedded bytes are the file the registry was derived from.
 *
 * Run this in a test, not on the fill path: a registry is only meaningful
 * against the exact revision it was derived from, and a blank swapped for a
 * newer revision moves every widget without changing a single field name.
 */
export async function assertFormBlankIntegrity(blank: FormBlank): Promise<void> {
  const bytes = decodeFormBlank(blank)
  const digest = await sha256Hex(bytes)
  if (digest !== blank.sha256) {
    throw new Error(
      `blank form digest is ${digest} but the registry was derived against ${blank.sha256} (${blank.sourceUrl})`,
    )
  }
}
