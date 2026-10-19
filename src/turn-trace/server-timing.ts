/** One entry of a `Server-Timing` response header. */
export interface ServerTimingEntry {
  name: string
  /** Milliseconds, when the entry carries `dur`. */
  durMs?: number
  /** `desc`, unquoted: a count or a label, never a duration. */
  desc?: string
}

/** Split on commas that sit outside a quoted `desc`. */
function splitEntries(header: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  for (const char of header) {
    if (char === '"') quoted = !quoted
    if (char === ',' && !quoted) {
      out.push(current)
      current = ''
    } else {
      current += char
    }
  }
  out.push(current)
  return out
}

/**
 * Parse a `Server-Timing` header, as the Router and the Sandbox orchestrator
 * send it. A malformed entry is skipped; the result never throws.
 */
export function parseServerTiming(header: string | null | undefined): ServerTimingEntry[] {
  if (!header) return []
  const entries: ServerTimingEntry[] = []
  for (const raw of splitEntries(header.slice(0, 4096))) {
    const [name, ...params] = raw.split(';').map((part) => part.trim())
    if (!name || !/^[\w.!#$%&'*+^`|~-]+$/.test(name)) continue
    const entry: ServerTimingEntry = { name }
    for (const param of params) {
      const eq = param.indexOf('=')
      if (eq < 0) continue
      const key = param.slice(0, eq).trim().toLowerCase()
      const value = param.slice(eq + 1).trim()
      if (key === 'dur') {
        const dur = Number(value)
        if (Number.isFinite(dur) && dur >= 0) entry.durMs = dur
      } else if (key === 'desc') {
        entry.desc = value.replace(/^"|"$/g, '').slice(0, 120)
      }
    }
    entries.push(entry)
  }
  return entries
}

/** Flat span attributes for the entries: `server_timing.<name>_ms` for a duration, `server_timing.<name>` for a `desc`. */
export function serverTimingAttrs(entries: readonly ServerTimingEntry[]): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const entry of entries.slice(0, 32)) {
    const key = entry.name.replace(/[^\w]/g, '_')
    if (entry.durMs !== undefined) out[`server_timing.${key}_ms`] = Math.round(entry.durMs * 10) / 10
    else if (entry.desc !== undefined) out[`server_timing.${key}`] = entry.desc
  }
  return out
}

/** Format entries as a `Server-Timing` header value, the inverse of {@link parseServerTiming}. Invalid names are skipped. */
export function formatServerTiming(entries: readonly ServerTimingEntry[]): string {
  return entries
    .filter((entry) => /^[\w.!#$%&'*+^`|~-]+$/.test(entry.name))
    .slice(0, 32)
    .map((entry) => [
      entry.name,
      ...(entry.durMs === undefined ? [] : [`dur=${Math.round(entry.durMs * 10) / 10}`]),
      ...(entry.desc === undefined ? [] : [`desc="${entry.desc.replace(/["\\]/g, '').slice(0, 120)}"`]),
    ].join(';'))
    .join(', ')
}
