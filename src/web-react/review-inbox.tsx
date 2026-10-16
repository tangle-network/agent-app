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
}
export interface ReviewInboxFeedback extends HubApprovalFeedback { verdict: ReviewVerdict }
export interface ReviewInboxProps {
  items: readonly ReviewInboxItem[]
  /** An existing deep-linked item; selected once when the round begins, without reordering it. */
  initialSelectedId?: string
  renderItem: (item: ReviewInboxItem) => ReactNode
  /** Resolves only after the verdict and its learning signal have been stored. */
  onVerdict: (item: ReviewInboxItem, decision: ReviewInboxFeedback) => Promise<void>
  onFeedback?: (item: ReviewInboxItem, feedback: Omit<ReviewInboxFeedback, 'verdict'>) => Promise<void>
  loading?: boolean
  error?: string | null
  onRefresh?: () => void | Promise<void>
}

const revisionKey = (item: ReviewInboxItem) => JSON.stringify([item.id, item.revision])
function ordered(items: readonly ReviewInboxItem[]) {
  return [...items].sort((left, right) => left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

/** One oldest-first review round. Domain rendering, storage and authority stay with the host. */
export function ReviewInbox({ items, initialSelectedId, renderItem, onVerdict, onFeedback, loading = false, error, onRefresh }: ReviewInboxProps) {
  const [round, setRound] = useState(() => ordered(items).map(item => item.id))
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set())
  const [resolvedElsewhere, setResolvedElsewhere] = useState<ReadonlySet<string>>(new Set())
  const [activeId, setActiveId] = useState<string | null>(() => items.some(item => item.id === initialSelectedId) ? initialSelectedId! : ordered(items)[0]?.id ?? null)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [restart, setRestart] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const cache = useRef(new Map<string, ReviewInboxItem>())
  const drafts = useRef(new Map<string, ReviewFeedbackDraft>())
  const pending = useRef(false)
  const section = useRef<HTMLElement>(null)
  const form = useRef<ReviewFeedbackFormHandle>(null)
  for (const item of items) cache.current.set(item.id, item)
  const currentItems = new Map(items.map(item => [item.id, item]))
  const unanswered = round.filter(id => {
    const item = cache.current.get(id)
    return item && !answered.has(revisionKey(item)) && !resolvedElsewhere.has(id)
  })
  const currentId = activeId && unanswered.includes(activeId) ? activeId
    : unanswered.find(id => round.indexOf(id) > round.indexOf(activeId ?? '')) ?? unanswered[0]
  const active = currentId ? cache.current.get(currentId) : undefined
  const currentKey = active ? revisionKey(active) : ''
  const available = !!active && currentItems.has(active.id)
  const canReview = !!active && available && active.canReview
  const rank = currentId ? round.indexOf(currentId) + 1 : round.length
  const reviewed = round.length - unanswered.length

  useEffect(() => {
    if (loading || (!restart && (round.length > 0 || items.length === 0))) return
    const next = ordered(items).map(item => item.id)
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

  useEffect(() => { setActiveId(currentId ?? null); section.current?.focus({ preventScroll: true }) }, [currentKey])

  function navigate(direction: -1 | 1) {
    if (pending.current || unanswered.length < 2) return
    const index = Math.max(0, unanswered.indexOf(currentId!))
    setActiveId(unanswered[(index + direction + unanswered.length) % unanswered.length]!)
  }

  async function verdict(item: ReviewInboxItem, value: ReviewInboxFeedback) {
    if (pending.current || !item.canReview || !currentItems.has(item.id)) return
    pending.current = true; setBusy(true)
    try {
      await onVerdict(item, value)
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

  async function feedback(item: ReviewInboxItem, value: HubApprovalFeedback) {
    if (!onFeedback || pending.current || !item.canReview || !currentItems.has(item.id)) return
    pending.current = true; setBusy(true)
    try { await onFeedback(item, value) }
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
      else if (active && canReview && key === 's') { event.preventDefault(); form.current?.focusScore() }
      else if (active && canReview && (key === 'a' || key === 'r')) {
        event.preventDefault(); void form.current?.submitVerdict(key === 'a' ? 'approve' : 'request_changes')
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  })

  return <section ref={section} tabIndex={-1} aria-label="Review inbox" aria-busy={busy || refreshing || loading}
    className="mx-auto min-w-0 max-w-4xl space-y-5 outline-none" data-review-inbox>
    <PageHeader title="Review inbox" description="Review the oldest work first. Every decision includes your score and feedback."
      actions={onRefresh && <Button variant="outline" disabled={busy || refreshing || loading} onClick={() => void refresh()}>{refreshing ? 'Refreshing…' : 'Refresh'}</Button>}
      meta={<p role="status" data-review-progress>{active ? `${rank} of ${round.length}` : `${reviewed} of ${round.length} resolved`}</p>} />
    {(error || refreshError) && <p role="alert" className="text-sm text-[var(--surface-danger-text)]">{error || refreshError}</p>}
    {round.length > 0 && <progress aria-label="Items resolved this round" value={reviewed} max={round.length} className="h-1.5 w-full accent-primary" />}
    {(loading || error) && !active ? <p role="status">{loading ? 'Loading the review inbox…' : 'The review inbox could not load.'}</p> : !active ? <div className="py-12 text-center"><h2 className="text-xl font-semibold">All caught up</h2><p className="mt-2 text-sm text-muted-foreground">{reviewed} of {round.length} resolved this round.</p></div> : <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0"><p className="text-sm text-muted-foreground">{active.kind}</p><h2 className="break-words text-lg font-semibold" data-review-title>{active.title}</h2></div>
        <div className="flex gap-2"><Button variant="outline" aria-keyshortcuts="K" disabled={busy || unanswered.length < 2} onClick={() => navigate(-1)}>Previous</Button><Button variant="outline" aria-keyshortcuts="J" disabled={busy || unanswered.length < 2} onClick={() => navigate(1)}>Next</Button></div>
      </div>
      {available && !active.canReview && <p className="text-sm text-muted-foreground">You do not have permission to review this item.</p>}
      <div className="min-w-0" data-review-content>{renderItem(active)}</div>
      <ReviewFeedbackForm key={currentKey} ref={form} draftKey={currentKey} drafts={drafts.current} input={active.input} preview={active.preview} feedback={active.feedback}
        disabled={!canReview || busy || loading} approveLabel={active.approveLabel} allowedVerdicts={active.allowedVerdicts}
        onVerdict={(decision, value) => verdict(active, { verdict: decision, ...value })}
        onFeedback={onFeedback ? (value) => feedback(active, value) : undefined} />
      <p className="text-xs leading-5 text-muted-foreground">A approve · R request changes · S score · J/K next/previous · Esc leave a field. Shortcuts pause while typing.</p>
    </>}
  </section>
}
