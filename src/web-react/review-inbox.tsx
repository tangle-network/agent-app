import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, PageHeader } from '@tangle-network/ui/primitives'
import type { HubActionPreview, HubApprovalFeedback } from '../hub-approvals'
import { ReviewFeedbackForm, type ReviewFeedbackDraft, type ReviewFeedbackFormHandle, type ReviewVerdict } from '../hub-approvals-react/feedback'

export interface ReviewInboxItem {
  id: string
  revision: string | number
  title: string
  kind: string
  createdAt: number
  canReview: boolean
  input: unknown
  feedback?: HubApprovalFeedback
  preview?: HubActionPreview
  approveLabel?: string
  allowedVerdicts?: readonly ReviewVerdict[]
  /** Same row and seed display together, with identities hidden. Hosts render only blind artifact content. */
  compare?: { rowId: string; seed: string }
}
export interface ReviewInboxFeedback extends HubApprovalFeedback {
  verdict: ReviewVerdict
  /** Zero-based display position and frozen row order, retained by the host with the decision. */
  comparison?: { rowId: string; seed: string; position: number; itemIds: string[] }
}
export interface ReviewInboxProps {
  items: readonly ReviewInboxItem[]
  /** An existing deep-linked item; selected once when the round begins, without reordering it. */
  initialSelectedId?: string
  renderItem: (item: ReviewInboxItem) => ReactNode
  /** The shared brief appears once above the blind row; never include column identities. */
  renderCompareBrief?: (rowId: string) => ReactNode
  /** Resolves only after the verdict and its learning signal have been stored. */
  onVerdict: (item: ReviewInboxItem, decision: ReviewInboxFeedback) => Promise<void>
  onFeedback?: (item: ReviewInboxItem, feedback: Omit<ReviewInboxFeedback, 'verdict'>) => Promise<void>
  loading?: boolean
  error?: string | null
  onRefresh?: () => void | Promise<void>
}

const revisionKey = (item: ReviewInboxItem) => JSON.stringify([item.id, item.revision])
function comparisonOrder(items: readonly ReviewInboxItem[], seed: string) {
  const result = [...items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  let state = 2166136261
  for (const character of seed) state = Math.imul(state ^ character.charCodeAt(0), 16777619) >>> 0
  for (let index = result.length - 1; index > 0; index--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const other = Math.floor((state / 4294967296) * (index + 1))
    ;[result[index], result[other]] = [result[other]!, result[index]!]
  }
  return result
}

function ordered(items: readonly ReviewInboxItem[]) {
  return [...items].sort((left, right) => left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

/** One oldest-first review round, with optional blind comparison rows. Hosts own rendering, storage and authority. */
export function ReviewInbox({ items, initialSelectedId, renderItem, renderCompareBrief, onVerdict, onFeedback, loading = false, error, onRefresh }: ReviewInboxProps) {
  const [round, setRound] = useState(() => ordered(items).map(item => item.id))
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set())
  const [resolvedElsewhere, setResolvedElsewhere] = useState<ReadonlySet<string>>(new Set())
  const [activeId, setActiveId] = useState<string | null>(() => items.some(item => item.id === initialSelectedId) ? initialSelectedId! : ordered(items)[0]?.id ?? null)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [restart, setRestart] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const cache = useRef(new Map<string, ReviewInboxItem>())
  const comparisons = useRef(new Map<string, ReviewInboxItem['compare']>())
  const drafts = useRef(new Map<string, ReviewFeedbackDraft>())
  const pending = useRef(false)
  const section = useRef<HTMLElement>(null)
  const form = useRef<ReviewFeedbackFormHandle>(null)
  const compareForms = useRef(new Map<string, ReviewFeedbackFormHandle>())
  for (const item of items) {
    cache.current.set(item.id, item)
    if (!comparisons.current.has(item.id)) comparisons.current.set(item.id, item.compare ? { ...item.compare } : undefined)
  }
  const currentItems = new Map(items.map(item => [item.id, item]))
  // Confirmed source changes affect this render's navigation, before effects retain the snapshot.
  const missing = loading || error || busy || refreshing ? resolvedElsewhere : new Set(round.filter(id => !currentItems.has(id)))
  const unanswered = round.filter(id => {
    const item = cache.current.get(id)
    return item && !answered.has(revisionKey(item)) && !missing.has(id)
  })
  const currentId = activeId && unanswered.includes(activeId) ? activeId
    : unanswered.find(id => round.indexOf(id) > round.indexOf(activeId ?? '')) ?? unanswered[0]
  const active = currentId ? cache.current.get(currentId) : undefined
  const currentKey = active ? revisionKey(active) : ''
  const available = !!active && currentItems.has(active.id)
  const canReview = !!active && available && active.canReview
  const rank = currentId ? round.indexOf(currentId) + 1 : round.length
  const reviewed = round.length - unanswered.length
  const compare = active ? comparisons.current.get(active.id) : undefined
  const compareItems = compare ? comparisonOrder(round.flatMap(id => {
    const item = cache.current.get(id)
    return item && comparisons.current.get(id)?.rowId === compare.rowId ? [item] : []
  }), compare.seed) : []
  const compareValid = !!compare?.rowId && !!compare.seed && compareItems.length > 0 && compareItems.every(item => item.compare?.rowId === compare.rowId && item.compare.seed === compare.seed)
  const positionOf = (item: ReviewInboxItem): ReviewInboxFeedback['comparison'] => compareValid && item.compare ? {
    rowId: item.compare.rowId, seed: item.compare.seed, position: compareItems.findIndex(cell => cell.id === item.id),
    itemIds: compareItems.map(cell => cell.id),
  } : undefined

  useEffect(() => {
    if (loading || (!restart && (round.length > 0 || items.length === 0))) return
    const next = ordered(items).map(item => item.id)
    comparisons.current = new Map(items.map(item => [item.id, item.compare ? { ...item.compare } : undefined]))
    setRound(next); setActiveId(initialSelectedId && next.includes(initialSelectedId) ? initialSelectedId : next[0] ?? null)
    setAnswered(new Set()); setResolvedElsewhere(new Set()); setRestart(false)
  }, [items, loading, restart, round.length, initialSelectedId])

  useEffect(() => {
    if (loading || error || busy || refreshing) return
    const present = new Set(items.map(item => item.id))
    setResolvedElsewhere(previous => {
      const next = new Set(round.filter(id => !present.has(id)))
      return next.size === previous.size && [...next].every(id => previous.has(id)) ? previous : next
    })
  }, [items, loading, error, busy, refreshing, round])

  useEffect(() => {
    setActiveId(currentId ?? null)
    if (!compare) section.current?.focus({ preventScroll: true })
  }, [currentKey, !!compare])

  function navigate(direction: -1 | 1) {
    if (pending.current || unanswered.length < 2) return
    const index = Math.max(0, unanswered.indexOf(currentId!))
    setActiveId(unanswered[(index + direction + unanswered.length) % unanswered.length]!)
  }

  async function verdict(item: ReviewInboxItem, value: ReviewInboxFeedback) {
    if (pending.current || !item.canReview || !currentItems.has(item.id) || (comparisons.current.get(item.id) && !compareValid)) return
    pending.current = true; setBusy(true)
    try {
      await onVerdict(item, { ...value, ...(comparisons.current.get(item.id) ? { comparison: positionOf(item) } : {}) })
      const nextAnswered = new Set(answered).add(revisionKey(item))
      setAnswered(nextAnswered)
      const remaining = round.filter(id => {
        const candidate = cache.current.get(id)
        return candidate && !nextAnswered.has(revisionKey(candidate))
      })
      const position = round.indexOf(item.id)
      setActiveId(remaining.find(id => round.indexOf(id) > position) ?? remaining[0] ?? null)
    } finally { pending.current = false; setBusy(false) }
  }

  async function feedback(item: ReviewInboxItem, value: Omit<ReviewInboxFeedback, 'verdict'>) {
    if (!onFeedback || pending.current || !item.canReview || !currentItems.has(item.id) || (comparisons.current.get(item.id) && !compareValid)) return
    pending.current = true; setBusy(true)
    try { await onFeedback(item, { ...value, ...(comparisons.current.get(item.id) ? { comparison: positionOf(item) } : {}) }) }
    finally { pending.current = false; setBusy(false) }
  }

  async function refresh() {
    if (!onRefresh || pending.current) return
    pending.current = true; setRefreshing(true); setRefreshError('')
    try { await onRefresh(); setRestart(true) }
    catch (cause) { setRefreshError(cause instanceof Error ? cause.message : 'The inbox could not refresh. Your drafts are kept.') }
    finally { pending.current = false; setRefreshing(false) }
  }

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return
      const target = event.target instanceof Element ? event.target : null
      const typing = target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')
      if (event.key === 'Escape' && typing instanceof HTMLElement) { typing.blur(); event.preventDefault(); return }
      if (typing || (target && target !== document.body && !section.current?.contains(target)) || pending.current || refreshing) return
      const key = event.key.toLowerCase()
      if (key === 'j') { event.preventDefault(); navigate(1) }
      else if (key === 'k') { event.preventDefault(); navigate(-1) }
      else if (active && canReview && key === 's') { event.preventDefault(); (compare ? compareForms.current.get(active.id) : form.current)?.focusScore() }
      else if (active && canReview && (key === 'a' || key === 'r')) {
        event.preventDefault(); void (compare ? compareForms.current.get(active.id) : form.current)?.submitVerdict(key === 'a' ? 'approve' : 'request_changes')
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  })

  return <section ref={section} tabIndex={-1} aria-label="Review inbox" aria-busy={busy || refreshing || loading}
    className={`mx-auto min-w-0 space-y-5 outline-none ${compare ? 'max-w-none' : 'max-w-4xl'}`} data-review-inbox>
    <PageHeader title="Review inbox" description="Review the oldest work first. Every decision includes your score and feedback."
      actions={onRefresh && <Button variant="outline" disabled={busy || refreshing || loading} onClick={() => void refresh()}>{refreshing ? 'Refreshing…' : 'Refresh'}</Button>}
      meta={<p role="status" data-review-progress>{active ? `${compare ? reviewed : rank} of ${round.length}${compare ? ' resolved' : ''}` : `${reviewed} of ${round.length} resolved`}</p>} />
    {(error || refreshError) && <p role="alert" className="text-sm text-[var(--surface-danger-text)]">{error || refreshError}</p>}
    {round.length > 0 && <progress aria-label="Items resolved this round" value={reviewed} max={round.length} className="h-1.5 w-full accent-primary" />}
    {(loading || error) && !active ? <p role="status">{loading ? 'Loading the review inbox…' : 'The review inbox could not load.'}</p> : !active ? <div className="py-12 text-center"><h2 className="text-xl font-semibold">All caught up</h2><p className="mt-2 text-sm text-muted-foreground">{reviewed} of {round.length} resolved this round.</p></div> : <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">{!compare && <p className="text-sm text-muted-foreground">{active.kind}</p>}<h2 className="break-words text-lg font-semibold" data-review-title>{compare ? 'Compare drafts' : active.title}</h2></div>
        <div className="flex gap-2"><Button variant="outline" aria-keyshortcuts="K" disabled={busy || unanswered.length < 2} onClick={() => navigate(-1)}>Previous</Button><Button variant="outline" aria-keyshortcuts="J" disabled={busy || unanswered.length < 2} onClick={() => navigate(1)}>Next</Button></div>
      </div>
      {compare ? <>
        {renderCompareBrief && <div data-review-compare-brief>{renderCompareBrief(compare.rowId)}</div>}
        {!compareValid && <p role="alert">This comparison changed. Refresh the inbox before reviewing it.</p>}
        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3" data-review-compare-row>
          {compareItems.map((item, index) => {
            const key = revisionKey(item)
            const done = answered.has(key)
            const present = currentItems.has(item.id)
            return <article key={key} aria-label={`Draft ${index + 1}`} className="min-w-0 space-y-3 rounded-lg border p-4"
              data-review-compare-position={index} onFocusCapture={() => { if (!done && present) setActiveId(item.id) }}>
              <h3 className="text-lg font-semibold">Draft {index + 1}</h3>
              <div className="min-w-0" data-review-content>{renderItem(item)}</div>
              {done ? <p role="status">Review saved</p> : !present ? <p role="status">This draft is no longer waiting.</p> : <ReviewFeedbackForm
                key={key} ref={handle => { if (handle) compareForms.current.set(item.id, handle); else compareForms.current.delete(item.id) }}
                draftKey={key} drafts={drafts.current} input={item.input} feedback={item.feedback}
                disabled={!compareValid || !item.canReview || busy || loading} approveLabel={item.approveLabel} allowedVerdicts={item.allowedVerdicts}
                onVerdict={(decision, value) => verdict(item, { verdict: decision, ...value })}
                onFeedback={onFeedback ? value => feedback(item, value) : undefined} />}
            </article>
          })}
        </div>
      </> : <>
      {available && !active.canReview && <p className="text-sm text-muted-foreground">You do not have permission to review this item.</p>}
      <div className="min-w-0" data-review-content>{renderItem(active)}</div>
      <ReviewFeedbackForm key={currentKey} ref={form} draftKey={currentKey} drafts={drafts.current} input={active.input} preview={active.preview} feedback={active.feedback}
        disabled={!canReview || busy || loading} approveLabel={active.approveLabel} allowedVerdicts={active.allowedVerdicts}
        onVerdict={(decision, value) => verdict(active, { verdict: decision, ...value })}
        onFeedback={onFeedback ? (value) => feedback(active, value) : undefined} />
      </>}
      <p className="text-xs leading-5 text-muted-foreground">A approve · R request changes · S score · J/K next/previous · Esc leave a field. Shortcuts pause while typing.</p>
    </>}
  </section>
}
