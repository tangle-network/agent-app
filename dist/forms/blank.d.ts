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
    base64: string;
    /** SHA-256 of the decoded bytes, lowercase hex. */
    sha256: string;
    /** Where the bytes came from. Provenance for a reviewer, not a fetch target. */
    sourceUrl: string;
    /** Decoded length in bytes. A cheap first check that the base64 is intact. */
    byteLength: number;
}
/**
 * Decode a blank once per isolate.
 *
 * Keyed on the blank OBJECT rather than a module-level singleton, because a
 * product carries several forms and a single cached slot would serve one
 * form's bytes for another's fill — a failure that produces a plausible PDF
 * and no error at all.
 */
export declare function decodeFormBlank(blank: FormBlank): Uint8Array;
/** Lowercase-hex SHA-256 of a byte range. */
export declare function sha256Hex(bytes: Uint8Array): Promise<string>;
/**
 * Prove the embedded bytes are the file the registry was derived from.
 *
 * Run this in a test, not on the fill path: a registry is only meaningful
 * against the exact revision it was derived from, and a blank swapped for a
 * newer revision moves every widget without changing a single field name.
 */
export declare function assertFormBlankIntegrity(blank: FormBlank): Promise<void>;
