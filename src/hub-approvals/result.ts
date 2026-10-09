/**
 * Hub results, read the same way by every receipt: unwrapped from Hub's
 * envelope and bounded before a host persists them.
 */

const MAX_DEPTH = 4
const MAX_KEYS = 24
const MAX_ITEMS = 50
const MAX_STRING = 600

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * The provider's own result inside Hub's envelopes. `tools.invoke` answers
 * `{ result: … }` and a connector may wrap its body in `data`; a JSON string,
 * as an older host stored it, is parsed first.
 */
export function unwrapHubResult(value: unknown): unknown {
  let current: unknown = value
  if (typeof current === 'string') {
    const start = current.indexOf('{')
    if (start < 0) return current
    try {
      current = JSON.parse(current.slice(start))
    } catch {
      return value
    }
  }
  for (let depth = 0; depth < 3; depth++) {
    const record = asRecord(current)
    const keys = Object.keys(record)
    const inner = keys.find((key) => key === 'result' || key === 'data')
    // Only a thin envelope is unwrapped; a body that happens to carry a `data`
    // field among its own fields is the result itself.
    if (!inner || keys.length > 3 || record[inner] === null || typeof record[inner] !== 'object') break
    current = record[inner]
  }
  return current
}

function bounded(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING - 1)}…` : value
  if (depth >= MAX_DEPTH) return undefined
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((item) => bounded(item, depth + 1)).filter((item) => item !== undefined)
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
      const kept = bounded(entry, depth + 1)
      if (kept !== undefined) out[key] = kept
    }
    return out
  }
  return undefined
}

/**
 * A bounded copy of a Hub result for a host to store with the decision: the
 * envelope removed, strings, arrays and nesting capped. Receipts read it in
 * place of the full result.
 */
export function summarizeHubResult(result: unknown): unknown {
  return bounded(unwrapHubResult(result), 0)
}

/** The first non-empty string among `keys`, searched one level into nested records. */
export function readText(value: unknown, ...keys: string[]): string | undefined {
  const record = asRecord(value)
  for (const key of keys) {
    const found = record[key]
    if (typeof found === 'string' && found.trim()) return found.trim()
    if (typeof found === 'number' && Number.isFinite(found)) return String(found)
  }
  return undefined
}

export function readNumber(value: unknown, ...keys: string[]): number | undefined {
  const record = asRecord(value)
  for (const key of keys) {
    const found = record[key]
    if (typeof found === 'number' && Number.isFinite(found)) return found
  }
  return undefined
}

/** A link a result names for itself, in the order providers use them. */
export function resultLink(value: unknown): string | undefined {
  const url = readText(value, 'html_url', 'htmlLink', 'webLink', 'web_url', 'permalink', 'hosted_invoice_url', 'url', 'link')
  return url && /^https:\/\//.test(url) ? url : undefined
}
