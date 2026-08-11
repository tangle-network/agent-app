/**
 * Work-product review surfaces — the sandbox-ui-FREE half of the vertical:
 *
 *  - {@link ReviewQueuePanel}: the practice/matters/campaign review queue over
 *    a `fetchQueue(cursor)` data port (the `AgentActivityPanel` shape).
 *  - {@link WorkProductCard}: the persisted `type:'work_product'` transcript
 *    anchor rendered inside `ChatMessages` — chat stays the driver surface.
 *  - {@link EvidenceLineageTable}: target → claim → source rows with
 *    click-through via an injected `resolveSourceUrl` (the
 *    `MessageAttachments.resolveFileUrl` pattern).
 *  - {@link ExceptionList} / {@link QualityCheckList}: severity-badged
 *    exception rows and pass/fail check rows.
 *  - {@link ProvenanceStamp}: profileHash prefix + runId + serving-model
 *    chips + the optional backtest slot ("182 cases · composite 0.81 ·
 *    trust PASS" — or "quality: unverified" when the trust gate failed).
 *
 * Anything hosting sandbox-ui (DiffView, CodeView, PillTabs) lives in
 * `./work-product-react` instead — this module must stay importable without
 * the optional sandbox-ui peer.
 */

import { useCallback, useEffect, useState } from 'react'

import {
  parseReviewQueueItem,
  type ReviewQueueItem,
  type ReviewQueueState,
} from '../work-product/queue'
import type {
  EvidenceEntry,
  ExceptionEntry,
  ProfileBacktestSummary,
  QualityCheck,
  WorkProductPersistedPart,
  WorkProductProvenance,
  WorkProductStatus,
} from '../work-product/types'
import { persistedPartToWorkProduct } from '../work-product/types'

export { parseReviewQueueItem }
export type { ReviewQueueItem, ReviewQueueState }

// ── shared presentation vocabulary ────────────────────────────────────────

const STATE_LABELS: Record<ReviewQueueState, string> = {
  intake: 'Intake',
  missing_info: 'Missing info',
  working: 'Working',
  ready_for_review: 'Ready for review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  blocked: 'Blocked',
}

const STATE_TONES: Record<ReviewQueueState, string> = {
  intake: 'bg-secondary text-muted-foreground',
  missing_info: 'bg-warning/10 text-warning',
  working: 'bg-primary/10 text-primary',
  ready_for_review: 'bg-success/10 text-success',
  changes_requested: 'bg-warning/10 text-warning',
  approved: 'bg-success/10 text-success',
  blocked: 'bg-destructive/10 text-destructive',
}

const STATUS_LABELS: Record<WorkProductStatus, string> = {
  draft: 'Draft',
  blocked: 'Blocked',
  ready: 'Ready for review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  superseded: 'Superseded',
}

const STATUS_TONES: Record<WorkProductStatus, string> = {
  draft: 'bg-primary/10 text-primary',
  blocked: 'bg-destructive/10 text-destructive',
  ready: 'bg-success/10 text-success',
  changes_requested: 'bg-warning/10 text-warning',
  approved: 'bg-success/10 text-success',
  superseded: 'bg-secondary text-muted-foreground',
}

/** Human label for a queue state. */
export function reviewQueueStateLabel(state: ReviewQueueState): string {
  return STATE_LABELS[state]
}

/** Human label for a work-product status. */
export function workProductStatusLabel(status: WorkProductStatus): string {
  return STATUS_LABELS[status]
}

function StatePill({ state }: { state: ReviewQueueState }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${STATE_TONES[state]}`}>
      {STATE_LABELS[state]}
    </span>
  )
}

function StatusPill({ status }: { status: WorkProductStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  )
}

// ── transcript anchor helpers + card ──────────────────────────────────────

/** Every persisted work-product anchor on one message, re-validated. */
export function workProductPartsFromMessageParts(
  parts: ReadonlyArray<Record<string, unknown>> | null | undefined,
): WorkProductPersistedPart[] {
  if (!parts) return []
  const out: WorkProductPersistedPart[] = []
  for (const part of parts) {
    const typed = persistedPartToWorkProduct(part)
    if (typed) out.push(typed)
  }
  return out
}

/** Properties for the transcript anchor card rendered in chat */
export interface WorkProductCardProps {
  part: WorkProductPersistedPart
  /** Open the work product (queue detail / pane) — the card's only action. */
  onOpen?: (part: WorkProductPersistedPart) => void
  className?: string
}

/** The chat transcript anchor card for one work-product version — a compact,
 *  system-authored pointer, not a parallel review surface. */
export function WorkProductCard({ part, onOpen, className }: WorkProductCardProps) {
  return (
    <div
      className={`flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 ${className ?? ''}`}
      data-work-product-id={part.ref.id}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <path d="m9 15 2 2 4-4" />
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-foreground">{part.title}</p>
        <p className="text-[11px] text-muted-foreground">
          {part.kind && <span className="font-mono">{part.kind}</span>}
          {part.kind && ' · '}v{part.ref.version}
        </p>
      </div>
      <StatusPill status={part.status} />
      {onOpen && (
        <button
          type="button"
          onClick={() => onOpen(part)}
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition hover:bg-accent"
        >
          Review
        </button>
      )}
    </div>
  )
}

// ── review queue panel ────────────────────────────────────────────────────

/** One fetched page of queue items with an optional continuation cursor */
export interface ReviewQueuePage {
  items: ReviewQueueItem[]
  /** Opaque continuation token; absent ⇒ no further pages. */
  nextCursor?: string
}

/** Properties for the review queue panel over a fetch data port */
export interface ReviewQueuePanelProps {
  /** Data port — fetch one page of queue items (the projection's output,
   *  re-validated here at the JSON boundary). */
  fetchQueue: (cursor?: string) => Promise<ReviewQueuePage>
  /** Open one queue item (navigate to its thread / detail pane). */
  onSelect?: (item: ReviewQueueItem) => void
  title?: string
  emptyLabel?: string
  className?: string
}

/** Merge a fetched page into held rows: dedupe by scopeKey, incoming wins,
 *  newest updatedAt first. Exported for tests. */
export function mergeReviewQueuePages(existing: ReviewQueueItem[], incoming: ReviewQueueItem[]): ReviewQueueItem[] {
  const byScope = new Map<string, ReviewQueueItem>()
  for (const item of existing) byScope.set(item.scopeKey, item)
  for (const item of incoming) byScope.set(item.scopeKey, item)
  return [...byScope.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

/** The workspace review queue — cursor-paged, refreshable, selection via
 *  callback. States, counts, and provenance render from the projection; the
 *  panel holds no domain logic. */
export function ReviewQueuePanel({
  fetchQueue,
  onSelect,
  title = 'Review queue',
  emptyLabel = 'Nothing awaiting review.',
  className,
}: ReviewQueuePanelProps) {
  const [items, setItems] = useState<ReviewQueueItem[]>([])
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (from?: string) => {
      setLoading(true)
      setError(null)
      try {
        const page = await fetchQueue(from)
        const validated = page.items
          .map((item) => parseReviewQueueItem(item))
          .filter((item): item is ReviewQueueItem => item !== null)
        setItems((prev) => mergeReviewQueuePages(from === undefined ? [] : prev, validated))
        setCursor(page.nextCursor)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [fetchQueue],
  )

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className={`space-y-2 ${className ?? ''}`}>
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-sm font-semibold">{title}</h2>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Refresh"
          className="rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <polyline points="21 3 21 9 15 9" />
          </svg>
        </button>
      </div>
      {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
      {!error && items.length === 0 && !loading && (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">{emptyLabel}</p>
      )}
      {/* The queue renders neither rows nor the empty copy while `loading`, so
          the announcement is the only thing a screen reader has during the wait.
          Kept mounted with changing text: an inserted live region that already
          carries its message is not reliably announced. */}
      <span role="status" aria-live="polite" aria-busy={loading} className="sr-only">
        {loading ? 'Loading review queue…' : ''}
      </span>
      <ul className="space-y-1.5" aria-busy={loading}>
        {items.map((item) => (
          <li key={item.scopeKey}>
            <button
              type="button"
              onClick={() => onSelect?.(item)}
              className="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition hover:border-primary/40 hover:bg-accent"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {item.workProduct?.title ?? item.scopeKey}
                  {item.workProduct && <span className="ml-1.5 text-[11px] text-muted-foreground">v{item.workProduct.version}</span>}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                  {item.workProduct?.kind && <span className="font-mono">{item.workProduct.kind}</span>}
                  {item.pendingAsk && <span>asks: {item.pendingAsk.title}</span>}
                  {item.blockingExceptions > 0 && (
                    <span className="text-destructive">{item.blockingExceptions} blocking</span>
                  )}
                  {item.failedChecks > 0 && <span className="text-warning">{item.failedChecks} failed checks</span>}
                  {item.provenance && item.provenance.profileHash && (
                    <span className="font-mono">{item.provenance.profileHash.slice(0, 8)}</span>
                  )}
                </p>
              </div>
              <StatePill state={item.state} />
            </button>
          </li>
        ))}
      </ul>
      {cursor && (
        <button
          type="button"
          onClick={() => void load(cursor)}
          disabled={loading}
          className="w-full rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-accent disabled:opacity-50"
        >
          Load more
        </button>
      )}
    </div>
  )
}

// ── evidence lineage table ────────────────────────────────────────────────

/** Properties for the evidence lineage table with source click-through */
export interface EvidenceLineageTableProps {
  evidence: readonly EvidenceEntry[]
  /** Resolve one entry's source document to an openable URL (signed
   *  object-store/vault download) — the `resolveFileUrl` pattern. Absent →
   *  sources render as plain refs without links. */
  resolveSourceUrl?: (entry: EvidenceEntry) => string
  className?: string
}

function locatorLabel(entry: EvidenceEntry): string | null {
  const parts: string[] = []
  if (entry.locator.page !== undefined) parts.push(`p.${entry.locator.page}`)
  if (entry.locator.range) parts.push(entry.locator.range)
  return parts.length ? parts.join(' · ') : null
}

/** Target → claim → source lineage rows: the "every material value traceable
 *  to source evidence" surface. Each row names the artifact target, the
 *  claim, and the source document location supporting it. */
export function EvidenceLineageTable({ evidence, resolveSourceUrl, className }: EvidenceLineageTableProps) {
  if (evidence.length === 0) {
    return <p className={`text-xs text-muted-foreground ${className ?? ''}`}>No evidence recorded.</p>
  }
  return (
    <div className={`overflow-x-auto ${className ?? ''}`}>
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-border text-[11px] uppercase tracking-[0.05em] text-muted-foreground">
            <th className="py-1.5 pr-3 font-medium">Target</th>
            <th className="py-1.5 pr-3 font-medium">Claim</th>
            <th className="py-1.5 font-medium">Source</th>
          </tr>
        </thead>
        <tbody>
          {evidence.map((entry) => {
            const url = resolveSourceUrl?.(entry)
            const locator = locatorLabel(entry)
            return (
              <tr key={entry.id} className="border-b border-border align-top">
                <td className="py-2 pr-3 font-mono text-xs text-foreground">{entry.target}</td>
                <td className="py-2 pr-3 text-sm leading-snug text-foreground">
                  {entry.claim}
                  {entry.locator.quote && (
                    // The basis is what a reviewer weighs, so it has to be
                    // visible per row, not only in the aggregate check detail.
                    // A platform-sliced quote came out of the document's own
                    // bytes; a model-typed one was proved to occur but was
                    // transcribed. Same text, different strength of evidence.
                    <span
                      className={`mt-0.5 block border-l-2 pl-2 text-xs italic ${
                        entry.locator.quoteBasis === 'span'
                          ? 'border-primary/60 text-foreground'
                          : 'border-border text-muted-foreground'
                      }`}
                      title={
                        entry.locator.quoteBasis === 'span'
                          ? 'Sliced from the source document by the platform'
                          : entry.locator.quoteBasis === 'model'
                            ? 'Quoted by the agent, verified to occur in the source'
                            : 'Unverified quote'
                      }
                    >
                      “{entry.locator.quote}”
                      {entry.locator.quoteBasis && (
                        <span className="ml-1.5 align-middle text-[11px] not-italic uppercase tracking-[0.05em] text-muted-foreground">
                          {entry.locator.quoteBasis === 'span' ? 'from source' : 'verified'}
                        </span>
                      )}
                    </span>
                  )}
                </td>
                <td className="py-2 text-xs">
                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-primary underline-offset-2 hover:underline"
                    >
                      {entry.sourceRef}
                    </a>
                  ) : (
                    <span className="font-mono text-muted-foreground">{entry.sourceRef}</span>
                  )}
                  {locator && <span className="ml-1.5 text-muted-foreground">{locator}</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── exceptions + checks ───────────────────────────────────────────────────

const SEVERITY_TONES: Record<ExceptionEntry['severity'], string> = {
  blocking: 'bg-destructive/10 text-destructive',
  material: 'bg-warning/10 text-warning',
  advisory: 'bg-secondary text-muted-foreground',
}

/** Properties for the severity-badged exception list */
export interface ExceptionListProps {
  exceptions: readonly ExceptionEntry[]
  className?: string
}

/** Severity-badged exception rows with resolution state. */
export function ExceptionList({ exceptions, className }: ExceptionListProps) {
  if (exceptions.length === 0) {
    return <p className={`text-xs text-muted-foreground ${className ?? ''}`}>No exceptions flagged.</p>
  }
  return (
    <ul className={`space-y-1.5 ${className ?? ''}`}>
      {exceptions.map((entry) => (
        <li key={entry.id} className="flex items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2">
          <span className={`mt-0.5 inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.05em] ${SEVERITY_TONES[entry.severity]}`}>
            {entry.severity}
          </span>
          <div className="min-w-0 flex-1">
            <p className={`text-sm leading-snug ${entry.resolved ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
              {entry.message}
            </p>
            <p className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
              <span className="font-mono">{entry.kind}</span>
              {entry.targets && entry.targets.length > 0 && <span className="font-mono">{entry.targets.join(', ')}</span>}
              {entry.resolved && <span>resolved{entry.resolvedBy ? ` by ${entry.resolvedBy}` : ''}</span>}
              {entry.resolutionNote && <span>{entry.resolutionNote}</span>}
            </p>
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Properties for the pass/fail quality check list */
export interface QualityCheckListProps {
  checks: readonly QualityCheck[]
  className?: string
}

/** Pass/fail quality-check rows tagged with their source (agent self-report,
 *  platform gate, judge ensemble). */
export function QualityCheckList({ checks, className }: QualityCheckListProps) {
  if (checks.length === 0) {
    return <p className={`text-xs text-muted-foreground ${className ?? ''}`}>No checks recorded.</p>
  }
  return (
    <ul className={`space-y-1 ${className ?? ''}`}>
      {checks.map((check) => (
        <li key={check.id} className="flex items-start gap-2 rounded-md px-1 py-1">
          {check.passed ? (
            <svg viewBox="0 0 24 24" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm text-foreground">
              {check.name}
              <span className="ml-1.5 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">{check.source}</span>
            </p>
            {check.detail && <p className="text-[11px] leading-snug text-muted-foreground">{check.detail}</p>}
          </div>
        </li>
      ))}
    </ul>
  )
}

// ── provenance stamp ──────────────────────────────────────────────────────

/** Properties for the provenance stamp with the optional backtest slot */
export interface ProvenanceStampProps {
  provenance: Pick<WorkProductProvenance, 'profileHash' | 'runId' | 'servingModels'> &
    Partial<Pick<WorkProductProvenance, 'costUsd' | 'producedAt'>>
  /** The product-resolved backtest summary for this profile hash. When its
   *  trust gate failed, the composite renders as "quality: unverified" —
   *  never a naked number. */
  backtest?: ProfileBacktestSummary
  className?: string
}

/** Truncated id with an ellipsis marker, so a sliced hash never passes as complete. */
function truncateId(id: string, length: number): string {
  return id.length > length ? `${id.slice(0, length)}…` : id
}

/** The audit line a reviewer approves against: which configuration produced
 *  this document, what served it, and how that configuration measured on its
 *  backtest. */
export function ProvenanceStamp({ provenance, backtest, className }: ProvenanceStampProps) {
  return (
    <div className={`flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground ${className ?? ''}`}>
      <span className="font-mono" title={provenance.profileHash}>
        profile {provenance.profileHash ? truncateId(provenance.profileHash, 10) : '—'}
      </span>
      <span className="font-mono" title={provenance.runId}>
        run {provenance.runId ? truncateId(provenance.runId, 10) : '—'}
      </span>
      {provenance.servingModels.length > 0 ? (
        provenance.servingModels.map((model) => (
          <span key={model} className="rounded-full bg-secondary px-2 py-0.5 font-mono">
            {model}
          </span>
        ))
      ) : (
        <span className="italic">serving model pending</span>
      )}
      {typeof provenance.costUsd === 'number' && <span>${provenance.costUsd.toFixed(provenance.costUsd < 0.01 ? 4 : 2)}</span>}
      {backtest &&
        (backtest.trust === 'pass' ? (
          <span className="text-success">
            {backtest.cases} backtest cases · composite {backtest.composite.toFixed(2)} · trust PASS
          </span>
        ) : (
          <span className="text-warning" title={backtest.trustReasons.join('; ')}>
            quality: unverified
          </span>
        ))}
    </div>
  )
}
