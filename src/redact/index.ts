/**
 * PII redaction for production trace payloads.
 *
 * The chat-trace emission sites pass tool args + results — and at one
 * point the LLM span carried the system prompt + user message verbatim
 * — through the wire. Anything that lands in the ingestion store is
 * also fair game for the analyst-loop's LLM prompts, so personal
 * identifiers MUST be stripped before they leave the request path.
 *
 * Discipline:
 *   - Match cheap, deterministic patterns at the string level (SSN, EIN).
 *   - Match well-known sensitive object keys (case-insensitive) and
 *     replace the value, never the key, so the shape of the object
 *     remains debuggable.
 *   - Recurse arrays + plain objects only; pass through everything else
 *     unchanged (numbers, booleans, null, undefined, functions, etc).
 *   - NEVER throw — a redaction failure must not crash the chat handler.
 *     Unrecognized inputs round-trip as-is.
 */

const SSN_PATTERN = /\d{3}-\d{2}-\d{4}/
const EIN_PATTERN = /\d{2}-\d{7}/

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

function redactString(value: string): string {
  if (SSN_PATTERN.test(value)) return '[REDACTED:ssn]'
  if (EIN_PATTERN.test(value)) return '[REDACTED:ein]'
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function redactForIngestion(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map(redactForIngestion)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = '[REDACTED:field]'
        continue
      }
      out[k] = redactForIngestion(v)
    }
    return out
  }
  return value
}
