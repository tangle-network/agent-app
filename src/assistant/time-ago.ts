/** Relative time label from an epoch-ms timestamp ("just now", "5m ago", "3h
 *  ago"). Self-contained so the assistant subpath carries no design-system dep. */
export function timeAgo(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000)
  if (secs < 5) return "just now"
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ago`
}
