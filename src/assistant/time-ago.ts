/** Relative time label from an epoch-ms timestamp ("just now", "5m ago", "3h
 *  ago", "6d ago", "Mar 3"). Self-contained so the assistant subpath carries no
 *  design-system dep. Buckets stop at weeks; past ~a month the short locale date
 *  is more useful than "11w ago" — the year rides along only when it isn't the
 *  current one. */
export function timeAgo(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000)
  if (secs < 5) return "just now"
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w ago`
  const date = new Date(ts)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" as const }),
  })
}
