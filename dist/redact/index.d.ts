/**
 * PII redaction — two complementary modes.
 *
 * 1. ONE-WAY scrub (`redactForIngestion`): for production trace payloads. Tool
 *    args + results (and once, the LLM span's prompt) cross the wire into the
 *    ingestion store, which also feeds the analyst-loop's LLM prompts, so
 *    personal identifiers MUST be stripped before they leave the request path.
 *    Destructive — the original is gone, replaced by a sentinel.
 *
 * 2. REVERSIBLE redaction (`buildRedactedDocument` / `revealSpan`): for the UI.
 *    A document is split into text + redacted segments; each redacted original
 *    is kept ENCRYPTED (via a caller-supplied `encrypt` seam → `agent-app/crypto`)
 *    so a viewer can reveal a single span on demand, gated by an authorization
 *    callback and an audit hook. The mask is presentation; the original is
 *    recoverable by an authorized reveal, not lost.
 *
 * Discipline: cheap deterministic string patterns + well-known sensitive object
 * keys (value replaced, key kept, so the shape stays debuggable); recurse arrays
 * + plain objects only; NEVER throw on the one-way path.
 */
/** A named PII pattern. `pattern` is matched case-insensitively at the string
 *  level; keep it non-global (global instances are derived where needed). */
export interface RedactionPattern {
    kind: string;
    pattern: RegExp;
    /** Optional predicate over each match — the pattern fires only when it returns
     *  true. For matches a regex alone can't decide (e.g. a Luhn check on a
     *  card-number candidate). When set, the value is scanned globally and the
     *  first match that passes wins; when absent, a plain `pattern.test` decides. */
    validate?: (match: string) => boolean;
}
/** The default deterministic patterns. Extend via the `extraPatterns` /
 *  `patterns` options rather than forking this module (the seam that lets a
 *  product add e.g. a credit-card matcher without a local copy). */
export declare const DEFAULT_REDACTION_PATTERNS: readonly RedactionPattern[];
/** Define options to customize sensitive data redaction patterns and key names for ingestion */
export interface RedactForIngestionOptions {
    /** Extra patterns appended to {@link DEFAULT_REDACTION_PATTERNS} for the
     *  string-level scrub (e.g. credit-card). Additive — defaults still apply. */
    extraPatterns?: readonly RedactionPattern[];
    /** Extra sensitive object-key names (case-insensitive) added to the built-in
     *  set, e.g. the snake_case `api_key` an intake form uses. Additive. */
    extraSensitiveKeys?: readonly string[];
    /**
     * How a matched string is rewritten:
     * - `'collapse'` (default) — the whole string becomes `[REDACTED:<kind>]` on
     *   the first matching pattern. Safest for telemetry: nothing of the original
     *   survives.
     * - `'mask-spans'` — only the matched substrings are replaced (each with
     *   `[REDACTED:<kind>]`), preserving surrounding text. Use when a downstream
     *   reader needs the non-PII context (e.g. an analyst loop reading prose).
     */
    stringMode?: 'collapse' | 'mask-spans';
}
/**
 * Replace only the PII substrings in `text`, preserving everything around them
 * (the `mask-spans` string mode). Built on {@link detectSpans} so matching,
 * non-overlap, and `validate` predicates behave identically to the reversible
 * path. Each span becomes `[REDACTED:<kind>]`.
 */
export declare function maskSpans(text: string, patterns?: readonly RedactionPattern[]): string;
export declare function redactErrorMessage(input: unknown, fallback?: string): string;
/**
 * One-way PII scrub for telemetry/ingestion. Backward-compatible: called with no
 * options it behaves exactly as before (SSN/EIN strings + sensitive object keys
 * → sentinels). `extraPatterns` lets a product add matchers (e.g. credit-card)
 * without forking this module.
 */
export declare function redactForIngestion(value: unknown, options?: RedactForIngestionOptions): unknown;
/** A detected PII span in a source string. */
export interface RedactionSpan {
    /** Stable within a document (index-derived) — used for reveal + audit. */
    id: string;
    kind: string;
    start: number;
    end: number;
    text: string;
}
/**
 * Find non-overlapping PII spans in `text`. Matches every pattern, sorts by
 * position, and drops overlaps (first match wins). Deterministic — no ids that
 * vary per call.
 */
export declare function detectSpans(text: string, patterns?: readonly RedactionPattern[]): RedactionSpan[];
/** A redacted document segment: literal text, or a masked span with the
 *  original kept ENCRYPTED for an authorized reveal. */
export type RedactedDocSegment = {
    type: 'text';
    text: string;
} | {
    type: 'redacted';
    id: string;
    kind: string;
    cipher: string;
};
/** Define a document composed of multiple redacted content segments */
export interface RedactedDocument {
    segments: RedactedDocSegment[];
}
/** Define options to encrypt text and specify patterns for redacting sensitive document content */
export interface BuildRedactedDocumentOptions {
    /** Encrypt one original span value. Wire it to `agent-app/crypto`
     *  (`encryptWithKey` / `createFieldCrypto`). The cipher is what's stored. */
    encrypt: (plaintext: string) => string | Promise<string>;
    /** Patterns to detect (default: {@link DEFAULT_REDACTION_PATTERNS}). */
    patterns?: readonly RedactionPattern[];
}
/**
 * Split `text` into text + redacted segments, encrypting each redacted span's
 * original. The result carries NO plaintext PII — only the masked structure and
 * ciphertext — so it is safe to ship to a client; reveal happens server-side via
 * {@link revealSpan}.
 */
export declare function buildRedactedDocument(text: string, options: BuildRedactedDocumentOptions): Promise<RedactedDocument>;
/** Define options to decrypt, authorize, and audit the reveal of a span segment */
export interface RevealSpanOptions {
    /** Decrypt a span cipher. Wire to `agent-app/crypto` (`decryptWithKey`). */
    decrypt: (cipher: string) => string | Promise<string>;
    /** Authorization gate — return false to deny the reveal (fail-closed). */
    canReveal: (segment: {
        id: string;
        kind: string;
    }) => boolean | Promise<boolean>;
    /** Audit hook — invoked only on a granted reveal (the caller records who/when). */
    onReveal?: (segment: {
        id: string;
        kind: string;
    }) => void | Promise<void>;
}
/** Describe the outcome of a reveal operation including success status, value, and failure reason */
export interface RevealResult {
    ok: boolean;
    value?: string;
    /** `not_found` | `forbidden` when `ok` is false. */
    reason?: string;
}
/**
 * Reveal one redacted span's original, gated + audited. Fail-closed: an unknown
 * id or a denied `canReveal` returns `{ ok: false }` and never decrypts; a
 * granted reveal decrypts, fires `onReveal` for the audit trail, and returns the
 * value.
 */
export declare function revealSpan(doc: RedactedDocument, spanId: string, options: RevealSpanOptions): Promise<RevealResult>;
