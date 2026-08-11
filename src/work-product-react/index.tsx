/**
 * `./work-product-react` — the sandbox-ui-composed review pane. It follows the
 * optional-peer rule: this is the ONLY work-product surface
 * that imports `@tangle-network/sandbox-ui` (its `workbench` primitives:
 * `PillTabs`, `CodeSurface`, `DiffView`, `FileBreadcrumb`).
 * `/web-react`'s queue/card/lineage components stay
 * sandbox-ui-free; importing THIS subpath requires the otherwise optional
 * sandbox-ui peer.
 *
 * The pane never fetches: bodies arrive as resolved strings
 * (`currentContent`/`baselineContent`) and history compares load through the
 * injected `loadVersionBody(ref)` seam. The default tab is a PROP — tax
 * passes `'lineage'` (lineage before diff for tax), legal passes `'diff'`
 * (the redline IS the artifact), gtm passes `'artifact'`.
 */

import { useCallback, useMemo, useState } from 'react'
import {
  CodeSurface,
  DiffView,
  FileBreadcrumb,
  PillTabs,
  type PillTabItem,
} from '@tangle-network/sandbox-ui/workbench'

import {
  EvidenceLineageTable,
  ExceptionList,
  ProvenanceStamp,
  QualityCheckList,
  workProductStatusLabel,
} from '../web-react/work-product'
import type {
  EvidenceEntry,
  ProfileBacktestSummary,
  WorkProductRecord,
  WorkProductVersionEntry,
} from '../work-product/types'
import { unresolvedBlockingExceptions } from '../work-product/types'

export type WorkProductPaneTab = 'artifact' | 'diff' | 'lineage' | 'exceptions' | 'checks' | 'history'

/** Properties for the tabbed work-product review pane */
export interface WorkProductPaneProps {
  workProduct: WorkProductRecord
  /** Which tab opens first — a product choice, not a heuristic: tax passes
   *  'lineage', legal 'diff', gtm 'artifact'. Default 'artifact'. */
  defaultTab?: WorkProductPaneTab
  /** Resolved artifact body when it lives at `artifact.path` rather than
   *  inline. Falls back to `artifact.content`. */
  currentContent?: string
  /** Resolved baseline body for diff-first products. Falls back to
   *  `artifact.baseline.content`. */
  baselineContent?: string
  /** Load a frozen version body by its `history[].artifactPath` ref for the
   *  vN-1 → vN compare. Omit to hide history compares. */
  loadVersionBody?: (ref: string) => Promise<string | null>
  /** Resolve one evidence entry's source to an openable URL (lineage
   *  click-through). */
  resolveSourceUrl?: (entry: EvidenceEntry) => string
  /** Backtest summary for the record's profile hash, rendered on the
   *  provenance stamp. */
  backtest?: ProfileBacktestSummary
  className?: string
}

interface VersionCompare {
  fromVersion: number
  toVersion: number
  baseline: string
  current: string
}

/** Trailing path segment for a diff header. */
function filenameOf(path: string | undefined, fallback: string): string {
  if (!path) return fallback
  const segments = path.split('/')
  return segments[segments.length - 1] || fallback
}

/**
 * The tabbed review pane over one work product: Artifact | Diff | Lineage |
 * Exceptions | Checks | History. Diff renders baseline→current for redline
 * artifacts and vN-1→vN for history compares; lineage is the
 * every-value-traceable table; provenance is stamped across the header.
 */
export function WorkProductPane({
  workProduct,
  defaultTab = 'artifact',
  currentContent,
  baselineContent,
  loadVersionBody,
  resolveSourceUrl,
  backtest,
  className,
}: WorkProductPaneProps) {
  const artifact = workProduct.artifact
  const body = currentContent ?? artifact?.content ?? ''
  const baseline = baselineContent ?? artifact?.baseline?.content
  const hasDiff = baseline !== undefined

  const tabs = useMemo(() => {
    const items: PillTabItem<WorkProductPaneTab>[] = [{ value: 'artifact', label: 'Artifact' }]
    if (hasDiff) items.push({ value: 'diff', label: 'Diff' })
    items.push(
      { value: 'lineage', label: `Lineage (${workProduct.evidence.length})` },
      { value: 'exceptions', label: `Exceptions (${workProduct.exceptions.length})` },
      { value: 'checks', label: `Checks (${workProduct.checks.length})` },
      { value: 'history', label: `History (${workProduct.history.length})` },
    )
    return items
  }, [hasDiff, workProduct.evidence.length, workProduct.exceptions.length, workProduct.checks.length, workProduct.history.length])

  const initialTab = tabs.some((tab) => tab.value === defaultTab) ? defaultTab : 'artifact'
  const [tab, setTab] = useState<WorkProductPaneTab>(initialTab)
  const [compare, setCompare] = useState<VersionCompare | null>(null)
  const [compareError, setCompareError] = useState<string | null>(null)

  const diffFilename = filenameOf(artifact?.path, artifact?.title ?? workProduct.scopeKey)

  const loadCompare = useCallback(
    async (from: WorkProductVersionEntry, to: WorkProductVersionEntry) => {
      if (!loadVersionBody || !from.artifactPath || !to.artifactPath) return
      setCompareError(null)
      try {
        const [fromBody, toBody] = await Promise.all([
          loadVersionBody(from.artifactPath),
          loadVersionBody(to.artifactPath),
        ])
        if (fromBody === null || toBody === null) {
          setCompareError('A version snapshot could not be loaded.')
          return
        }
        setCompare({ fromVersion: from.version, toVersion: to.version, baseline: fromBody, current: toBody })
      } catch (error) {
        setCompareError(error instanceof Error ? error.message : String(error))
      }
    },
    [loadVersionBody],
  )

  return (
    <div className={`flex min-h-0 flex-col gap-3 ${className ?? ''}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">
            {artifact?.title ?? workProduct.scopeKey}
            <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">v{workProduct.version}</span>
          </p>
          <p className="text-[11px] text-muted-foreground">
            {artifact?.kind && <span className="font-mono">{artifact.kind} · </span>}
            {workProductStatusLabel(workProduct.status)}
            {unresolvedBlockingExceptions(workProduct.exceptions).length > 0 && (
              <span className="text-destructive"> · {unresolvedBlockingExceptions(workProduct.exceptions).length} blocking</span>
            )}
          </p>
        </div>
        <ProvenanceStamp provenance={workProduct.provenance} backtest={backtest} />
      </div>

      <PillTabs items={tabs} value={tab} onChange={setTab} aria-label="Work product views" />

      {tab === 'artifact' && (
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border">
          {artifact?.path && <FileBreadcrumb path={artifact.path} className="border-b border-border px-3 py-2" />}
          {body ? (
            <CodeSurface code={body} filename={diffFilename} />
          ) : artifact?.fields ? (
            <CodeSurface code={JSON.stringify(artifact.fields, null, 2)} filename={`${diffFilename}.json`} language="json" />
          ) : (
            <p className="px-4 py-6 text-center text-xs text-muted-foreground">No artifact body yet.</p>
          )}
        </div>
      )}

      {tab === 'diff' && hasDiff && (
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border">
          {/* DiffView's own file header already carries the +/− counts. */}
          <DiffView filename={diffFilename} baseline={baseline ?? ''} current={body} />
        </div>
      )}

      {tab === 'lineage' && (
        <EvidenceLineageTable evidence={workProduct.evidence} resolveSourceUrl={resolveSourceUrl} />
      )}

      {tab === 'exceptions' && <ExceptionList exceptions={workProduct.exceptions} />}

      {tab === 'checks' && <QualityCheckList checks={workProduct.checks} />}

      {tab === 'history' && (
        <div className="space-y-2">
          {workProduct.history.length === 0 && <p className="text-xs text-muted-foreground">No versions yet.</p>}
          {workProduct.history.map((entry, index) => {
            const prior = workProduct.history
              .slice(0, index)
              .reverse()
              .find((candidate) => candidate.version < entry.version && candidate.artifactPath)
            return (
              <div key={`${entry.version}:${entry.status}:${entry.at}`} className="rounded-lg border border-border bg-card px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">v{entry.version}</span>
                  <span className="text-[11px] text-muted-foreground">{workProductStatusLabel(entry.status)}</span>
                  {entry.reviewedBy && <span className="text-[11px] text-muted-foreground">by {entry.reviewedBy}</span>}
                  <span className="flex-1" />
                  {loadVersionBody && prior?.artifactPath && entry.artifactPath && (
                    <button
                      type="button"
                      onClick={() => void loadCompare(prior, entry)}
                      className="rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-foreground transition hover:bg-accent"
                    >
                      Compare v{prior.version} → v{entry.version}
                    </button>
                  )}
                </div>
                {entry.reviewNote && <p className="mt-1 text-sm leading-snug text-foreground">{entry.reviewNote}</p>}
                <ProvenanceStamp provenance={entry.provenance} className="mt-1" />
              </div>
            )
          })}
          {compareError && <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{compareError}</p>}
          {compare && (
            <div className="overflow-auto rounded-lg border border-border">
              <p className="border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
                v{compare.fromVersion} → v{compare.toVersion}
              </p>
              <DiffView filename={diffFilename} baseline={compare.baseline} current={compare.current} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
