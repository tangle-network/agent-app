/**
 * Redaction by value: a product registers the secret values one turn could expose (a credential its box holds in its
 * environment), and every string the turn streams or stores has each occurrence replaced. By value, never by pattern, so
 * nothing that merely looks like a secret is touched and nothing registered slips through under another shape.
 * workspace-export/secrets.ts's scanner also masks credential-shaped patterns and secret-named keys, which would change
 * a live event's structure; a turn's stream takes values only, with the same `[redacted]` marker.
 */
import { REDACTED } from '../workspace-export/secrets'
import { WITHHELD_FAILURE } from './turn-event-stream'

/** Values shorter than this are never registered: a short value would redact ordinary text. */
const MIN_SECRET_LENGTH = 8

export type ValueRedactor = <T>(value: T) => T

/** A redactor for these values, or undefined when none qualifies: object keys and string values alike. Longest first, so
 *  a value that contains another wins. */
export function valueRedactor(values: readonly string[] | undefined): ValueRedactor | undefined {
  const secrets = [...new Set((values ?? []).filter((v) => typeof v === 'string' && v.length >= MIN_SECRET_LENGTH))]
    .sort((a, b) => b.length - a.length)
  if (secrets.length === 0) return undefined
  const text = (s: string) => secrets.some((v) => s.includes(v)) ? secrets.reduce((acc, v) => acc.split(v).join(REDACTED), s) : s
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return text(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v === null || typeof v !== 'object') return v
    const out = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [text(k), walk(x)]))
    // A withheld failure's original, for the route's hooks only, is redacted too and kept under its Symbol key.
    const withheld = (v as { [WITHHELD_FAILURE]?: unknown })[WITHHELD_FAILURE]
    return withheld === undefined ? out : Object.assign(out, { [WITHHELD_FAILURE]: walk(withheld) })
  }
  return walk as ValueRedactor
}

/** Every event of a stream, redacted. A value split across two text deltas is caught where the turn is stored, not live. */
export async function* redactEvents<T>(source: AsyncIterable<T>, redact: ValueRedactor): AsyncGenerator<T> {
  for await (const event of source) yield redact(event)
}
