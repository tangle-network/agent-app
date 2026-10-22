import type { FlowSpan, FlowTrace } from '../trace/flow-types'

export interface WaterfallRow {
  id: string
  parentId?: string
  name: string
  kind: FlowSpan['kind']
  offsetPct: number
  widthPct: number
  durationLabel: string
  approx: boolean
  ok: boolean
  depth: number
  hasChildren: boolean
  span: FlowSpan
}

export function spanFailed(span: FlowSpan): boolean {
  return span.status === 'failed' || span.meta?.ok === false ||
    ['failed', 'error', 'cancelled', 'aborted', 'down'].includes(String(span.meta?.status ?? '').toLowerCase())
}

export function spanRunning(span: FlowSpan): boolean {
  return span.status === 'running' ||
    (span.status === undefined && ['pending', 'running'].includes(String(span.meta?.status ?? '').toLowerCase()))
}

/** One geometry owner for the web surface and its established public helper.
 * Orphaned parents become roots; cycles are broken without dropping any span. */
export function waterfallLayout(trace: FlowTrace): WaterfallRow[] {
  const total = trace.totalMs > 0 ? trace.totalMs : 1
  const ids = new Set<string>()
  const rows: WaterfallRow[] = [...trace.spans]
    .map((span, i) => ({ span, key: span.id ?? `span-${i}` }))
    .sort((a, b) => a.span.startMs - b.span.startMs)
    .map(({ span, key }, index) => {
      const id = ids.has(key) ? `${key}:${index}` : key
      ids.add(id)
      const start = Math.max(0, Math.min(total, span.startMs))
      const end = Math.max(start, Math.min(total, span.endMs))
      const offsetPct = start / total * 100
      return {
        id, parentId: span.parentId, name: span.name, kind: span.kind,
        offsetPct,
        widthPct: Math.min(100 - offsetPct, Math.max(0.5, (end - start) / total * 100)),
        durationLabel: `${(Math.max(0, span.endMs - span.startMs) / 1000).toFixed(1)}s${span.approx ? '~' : ''}`,
        approx: span.approx === true, ok: !spanFailed(span), depth: 0, hasChildren: false, span,
      }
    })
  const byId = new Map(rows.map(row => [row.id, row]))
  const children = new Map<string, WaterfallRow[]>()
  for (const row of rows) {
    const seen = new Set([row.id])
    let parent = row.parentId
    while (parent && byId.has(parent)) {
      if (seen.has(parent)) { row.parentId = undefined; break }
      seen.add(parent)
      parent = byId.get(parent)?.parentId
    }
    if (row.parentId && !byId.has(row.parentId)) row.parentId = undefined
    if (row.parentId) {
      const siblings = children.get(row.parentId) ?? []
      siblings.push(row)
      children.set(row.parentId, siblings)
    }
  }
  const ordered: WaterfallRow[] = []
  const visit = (row: WaterfallRow, depth: number) => {
    row.depth = depth
    row.hasChildren = children.has(row.id)
    ordered.push(row)
    for (const child of children.get(row.id) ?? []) visit(child, depth + 1)
  }
  for (const row of rows) if (!row.parentId) visit(row, 0)
  return ordered
}

/** Search keeps ancestor context and deliberately reveals matches inside collapsed branches. */
export function visibleWaterfallRows(rows: WaterfallRow[], query: string, collapsed: Set<string>): WaterfallRow[] {
  const byId = new Map(rows.map(row => [row.id, row]))
  const term = query.trim().toLowerCase()
  if (term) {
    const matching = new Set<string>()
    for (const row of rows) {
      if (!`${row.name} ${row.kind} ${row.ok ? '' : 'failed'} ${row.span.status ?? ''}`.toLowerCase().includes(term)) continue
      let cursor: WaterfallRow | undefined = row
      while (cursor && !matching.has(cursor.id)) {
        matching.add(cursor.id)
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
      }
    }
    return rows.filter(row => matching.has(row.id))
  }
  const hidden = new Set<string>()
  return rows.filter(row => {
    const isHidden = row.parentId !== undefined && (collapsed.has(row.parentId) || hidden.has(row.parentId))
    if (isHidden) hidden.add(row.id)
    return !isHidden
  })
}
