import type { ServerTimingEntry } from '@tangle-network/agent-core/server-timing'

export { formatServerTiming, parseServerTiming, type ServerTimingEntry } from '@tangle-network/agent-core/server-timing'

/** Flat span attributes for the entries: `server_timing.<name>_ms` for a duration, `server_timing.<name>` for a `desc`. */
export function serverTimingAttrs(entries: readonly ServerTimingEntry[]): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const entry of entries.slice(0, 32)) {
    const key = entry.name.replace(/[^\w]/g, '_')
    if (entry.dur !== undefined && entry.dur >= 0) out[`server_timing.${key}_ms`] = Math.round(entry.dur * 10) / 10
    else if (entry.desc !== undefined) out[`server_timing.${key}`] = entry.desc.slice(0, 120)
  }
  return out
}
