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
  kind: string
  pattern: RegExp
  /** Optional predicate over each match — the pattern fires only when it returns
   *  true. For matches a regex alone can't decide (e.g. a Luhn check on a
   *  card-number candidate). When set, the value is scanned globally and the
   *  first match that passes wins; when absent, a plain `pattern.test` decides. */
  validate?: (match: string) => boolean
}

/** The default deterministic patterns. Extend via the `extraPatterns` /
 *  `patterns` options rather than forking this module (the seam that lets a
 *  product add e.g. a credit-card matcher without a local copy). */
export const DEFAULT_REDACTION_PATTERNS: readonly RedactionPattern[] = [
  { kind: 'ssn', pattern: /\d{3}-\d{2}-\d{4}/ },
  { kind: 'ein', pattern: /\d{2}-\d{7}/ },
]

const SENSITIVE_KEYS = new Set([
  'ssn',
  'ein',
  'password',
  'apikey',
  'token',
  'secret',
  'authorization',
  'email',
  'phone',
])

/** Define options to customize sensitive data redaction patterns and key names for ingestion */
export interface RedactForIngestionOptions {
  /** Extra patterns appended to {@link DEFAULT_REDACTION_PATTERNS} for the
   *  string-level scrub (e.g. credit-card). Additive — defaults still apply. */
  extraPatterns?: readonly RedactionPattern[]
  /** Extra sensitive object-key names (case-insensitive) added to the built-in
   *  set, e.g. the snake_case `api_key` an intake form uses. Additive. */
  extraSensitiveKeys?: readonly string[]
  /**
   * How a matched string is rewritten:
   * - `'collapse'` (default) — the whole string becomes `[REDACTED:<kind>]` on
   *   the first matching pattern. Safest for telemetry: nothing of the original
   *   survives.
   * - `'mask-spans'` — only the matched substrings are replaced (each with
   *   `[REDACTED:<kind>]`), preserving surrounding text. Use when a downstream
   *   reader needs the non-PII context (e.g. an analyst loop reading prose).
   */
  stringMode?: 'collapse' | 'mask-spans'
}

function redactString(value: string, patterns: readonly RedactionPattern[]): string {
  for (const { kind, pattern, validate } of patterns) {
    if (!validate) {
      const testPattern = /[gy]/.test(pattern.flags)
        ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
        : pattern
      if (testPattern.test(value)) return `[REDACTED:${kind}]`
      continue
    }
    const g = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
    for (const m of value.matchAll(g)) {
      if (m[0].length > 0 && validate(m[0])) return `[REDACTED:${kind}]`
    }
  }
  return value
}

/**
 * Replace only the PII substrings in `text`, preserving everything around them
 * (the `mask-spans` string mode). Built on {@link detectSpans} so matching,
 * non-overlap, and `validate` predicates behave identically to the reversible
 * path. Each span becomes `[REDACTED:<kind>]`.
 */
export function maskSpans(
  text: string,
  patterns: readonly RedactionPattern[] = DEFAULT_REDACTION_PATTERNS,
): string {
  const spans = detectSpans(text, patterns)
  if (spans.length === 0) return text
  let out = ''
  let pos = 0
  for (const s of spans) {
    if (s.start > pos) out += text.slice(pos, s.start)
    out += `[REDACTED:${s.kind}]`
    pos = s.end
  }
  if (pos < text.length) out += text.slice(pos)
  return out
}

const ERROR_SECRET_KEY = String.raw`(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key|session[_-]?token|security[_-]?token|x-amz-(?:credential|signature|security-token)|aws[_-]?access[_-]?key[_-]?id|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token|api[_-]?key|client[_-]?secret|credential|token|secret|password|signature|sig|authorization)`

const ERROR_SECRET_PATTERNS: readonly RedactionPattern[] = [
  ...DEFAULT_REDACTION_PATTERNS,
  { kind: 'email', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { kind: 'bearer', pattern: /Bearer\s+[^\s]+/i },
  { kind: 'credential', pattern: /\b(?:sk|pk|tc|ghp|xoxb)[_-][A-Za-z0-9_-]{8,}\b/i },
  {
    kind: 'credential',
    pattern: /["']?\b(?:cookie|set-cookie)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n}]*)/i,
  },
  {
    kind: 'credential',
    pattern: new RegExp(
      String.raw`["']?\b${ERROR_SECRET_KEY}\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|(?:Bearer|Basic)\s+[^\s,;&}"']+|[^\r\n,;&}]+?)(?=\s+(?:["']?\b[A-Za-z][A-Za-z0-9_-]*["']?\s*[:=]|(?:Bearer|Basic)\b)|\s*,\s*["']?\b[A-Za-z][A-Za-z0-9_-]*["']?\s*[:=]|\s*[,;&}]|\s*[\r\n]|$)`,
      'i',
    ),
  },
]

/** Sanitize an untrusted backend error for server logs. This is deliberately
 * separate from public response text: callers should return an opaque message
 * and log this bounded, redacted value for operators. */
function safeString(value: unknown): string | undefined {
  try {
    return typeof value === 'string' ? value : String(value)
  } catch {
    return undefined
  }
}

function safeErrorText(input: unknown): string {
  if (input !== null && (typeof input === 'object' || typeof input === 'function')) {
    try {
      const message = Reflect.get(input, 'message')
      const messageText = safeString(message)
      if (messageText !== undefined) return messageText
    } catch {
      // Hostile getters and proxies are still untrusted error values.
    }
  }
  return safeString(input) ?? ''
}

export function redactErrorMessage(input: unknown, fallback = 'unknown error'): string {
  const fallbackText = safeString(fallback)?.trim() || 'unknown error'
  const raw = safeErrorText(input)
  const message = raw.trim() || fallbackText
  try {
    const redacted = maskSpans(message, ERROR_SECRET_PATTERNS).trim()
    return redacted.length > 240 ? `${redacted.slice(0, 240)}…` : redacted || fallbackText
  } catch {
    return fallbackText
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * One-way PII scrub for telemetry/ingestion. Backward-compatible: called with no
 * options it behaves exactly as before (SSN/EIN strings + sensitive object keys
 * → sentinels). `extraPatterns` lets a product add matchers (e.g. credit-card)
 * without forking this module.
 */
export function redactForIngestion(value: unknown, options: RedactForIngestionOptions = {}): unknown {
  const patterns = options.extraPatterns
    ? [...DEFAULT_REDACTION_PATTERNS, ...options.extraPatterns]
    : DEFAULT_REDACTION_PATTERNS
  const sensitiveKeys = options.extraSensitiveKeys
    ? new Set([...SENSITIVE_KEYS, ...options.extraSensitiveKeys.map((k) => k.toLowerCase())])
    : SENSITIVE_KEYS
  const maskString =
    options.stringMode === 'mask-spans'
      ? (s: string) => maskSpans(s, patterns)
      : (s: string) => redactString(s, patterns)
  // Cycle guard: a payload with a circular reference would otherwise recurse
  // forever. On re-encountering an object/array, return it untouched to break
  // the cycle (the same value was already redacted on its first visit).
  const seen = new WeakSet<object>()
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return maskString(v)
    if (Array.isArray(v)) {
      if (seen.has(v)) return v
      seen.add(v)
      return v.map(walk)
    }
    if (isPlainObject(v)) {
      if (seen.has(v)) return v
      seen.add(v)
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v)) {
        out[k] = sensitiveKeys.has(k.toLowerCase()) ? '[REDACTED:field]' : walk(val)
      }
      return out
    }
    return v
  }
  return walk(value)
}

// ── Reversible document redaction (the UI path) ─────────────────────────────

/** A detected PII span in a source string. */
export interface RedactionSpan {
  /** Stable within a document (index-derived) — used for reveal + audit. */
  id: string
  kind: string
  start: number
  end: number
  text: string
}

/**
 * Find non-overlapping PII spans in `text`. Matches every pattern, sorts by
 * position, and drops overlaps (first match wins). Deterministic — no ids that
 * vary per call.
 */
export function detectSpans(
  text: string,
  patterns: readonly RedactionPattern[] = DEFAULT_REDACTION_PATTERNS,
): RedactionSpan[] {
  const raw: Array<{ kind: string; start: number; end: number; text: string }> = []
  for (const { kind, pattern, validate } of patterns) {
    const g = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
    for (const m of text.matchAll(g)) {
      if (m.index === undefined || m[0].length === 0) continue
      if (validate && !validate(m[0])) continue
      raw.push({ kind, start: m.index, end: m.index + m[0].length, text: m[0] })
    }
  }
  raw.sort((a, b) => a.start - b.start || b.end - a.end)
  const spans: RedactionSpan[] = []
  let cursor = -1
  let i = 0
  for (const s of raw) {
    if (s.start < cursor) continue // overlaps an earlier (higher-priority) span
    spans.push({ id: `span-${i++}`, ...s })
    cursor = s.end
  }
  return spans
}

/** A redacted document segment: literal text, or a masked span with the
 *  original kept ENCRYPTED for an authorized reveal. */
export type RedactedDocSegment =
  | { type: 'text'; text: string }
  | { type: 'redacted'; id: string; kind: string; cipher: string }

/** Define a document composed of multiple redacted content segments */
export interface RedactedDocument {
  segments: RedactedDocSegment[]
}

/** Define options to encrypt text and specify patterns for redacting sensitive document content */
export interface BuildRedactedDocumentOptions {
  /** Encrypt one original span value. Wire it to `agent-app/crypto`
   *  (`encryptWithKey` / `createFieldCrypto`). The cipher is what's stored. */
  encrypt: (plaintext: string) => string | Promise<string>
  /** Patterns to detect (default: {@link DEFAULT_REDACTION_PATTERNS}). */
  patterns?: readonly RedactionPattern[]
}

/**
 * Split `text` into text + redacted segments, encrypting each redacted span's
 * original. The result carries NO plaintext PII — only the masked structure and
 * ciphertext — so it is safe to ship to a client; reveal happens server-side via
 * {@link revealSpan}.
 */
export async function buildRedactedDocument(
  text: string,
  options: BuildRedactedDocumentOptions,
): Promise<RedactedDocument> {
  const spans = detectSpans(text, options.patterns)
  const segments: RedactedDocSegment[] = []
  let pos = 0
  for (const span of spans) {
    if (span.start > pos) segments.push({ type: 'text', text: text.slice(pos, span.start) })
    segments.push({ type: 'redacted', id: span.id, kind: span.kind, cipher: await options.encrypt(span.text) })
    pos = span.end
  }
  if (pos < text.length) segments.push({ type: 'text', text: text.slice(pos) })
  return { segments }
}

/** Define options to decrypt, authorize, and audit the reveal of a span segment */
export interface RevealSpanOptions {
  /** Decrypt a span cipher. Wire to `agent-app/crypto` (`decryptWithKey`). */
  decrypt: (cipher: string) => string | Promise<string>
  /** Authorization gate — return false to deny the reveal (fail-closed). */
  canReveal: (segment: { id: string; kind: string }) => boolean | Promise<boolean>
  /** Audit hook — invoked only on a granted reveal (the caller records who/when). */
  onReveal?: (segment: { id: string; kind: string }) => void | Promise<void>
}

/** Describe the outcome of a reveal operation including success status, value, and failure reason */
export interface RevealResult {
  ok: boolean
  value?: string
  /** `not_found` | `forbidden` when `ok` is false. */
  reason?: string
}

/**
 * Reveal one redacted span's original, gated + audited. Fail-closed: an unknown
 * id or a denied `canReveal` returns `{ ok: false }` and never decrypts; a
 * granted reveal decrypts, fires `onReveal` for the audit trail, and returns the
 * value.
 */
export async function revealSpan(
  doc: RedactedDocument,
  spanId: string,
  options: RevealSpanOptions,
): Promise<RevealResult> {
  const seg = doc.segments.find((s): s is Extract<RedactedDocSegment, { type: 'redacted' }> =>
    s.type === 'redacted' && s.id === spanId,
  )
  if (!seg) return { ok: false, reason: 'not_found' }
  const allowed = await options.canReveal({ id: seg.id, kind: seg.kind })
  if (!allowed) return { ok: false, reason: 'forbidden' }
  const value = await options.decrypt(seg.cipher)
  if (options.onReveal) await options.onReveal({ id: seg.id, kind: seg.kind })
  return { ok: true, value }
}
