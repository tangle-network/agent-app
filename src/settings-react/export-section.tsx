/**
 * Export as a settings card: the workspace export (the same engine and
 * resume behaviour as `WorkspaceExportPanel`) drawn as rows, with any other
 * copy or download rows the product adds below it. A viewer who cannot export
 * sees the row locked with the reason instead of a missing feature.
 */

import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Progress,
  SettingsRow,
  SettingsSection,
} from '@tangle-network/ui/primitives'
import { ChevronDown } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useWorkspaceExport } from '../workspace-export/react'
import type { ExportProgress } from '../workspace-export/types'

export interface ExportSectionProps {
  /** The card's anchor. */
  id?: string
  title?: string
  /** The mount path of the product's export routes, e.g. `/api/workspaces/ws-1/exports`. */
  endpoint: string
  /** Whether the viewer may export; the server refuses others regardless. */
  canExport: boolean
  /** Why the viewer cannot export, naming who can. Without it a viewer who cannot export sees no export row. */
  disabledReason?: ReactNode
  /** The export row's one line. */
  description?: ReactNode
  fetcher?: typeof fetch
  /** True when the product finishes exports on a schedule after the page closes. */
  continuesInBackground?: boolean
  /** More rows for this card, such as a JSON download or "Duplicate project…". */
  children?: ReactNode
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${BYTE_UNITS[unit]}`
}

function unitState(unit: ExportProgress['units'][number]): string {
  if (unit.status === 'pending') return 'Waiting'
  if (unit.status === 'empty') return 'Nothing to export'
  if (unit.status === 'failed') return 'Failed'
  if (unit.rows !== undefined) return `${unit.rows} rows`
  if (unit.files !== undefined) return `${unit.files} files · ${formatBytes(unit.bytes)}`
  return formatBytes(unit.bytes)
}

function progressLine(latest: ExportProgress): string {
  return [
    `${latest.unitsDone} of ${latest.unitsTotal} sources`,
    latest.unitsFailed ? `${latest.unitsFailed} failed` : null,
    formatBytes(latest.bytes),
    latest.status === 'running' && latest.current ? `now ${latest.current}` : null,
  ].filter(Boolean).join(' · ')
}

function LatestExport({ latest, continuesInBackground }: { latest: ExportProgress; continuesInBackground: boolean }) {
  const [open, setOpen] = useState(false)
  const percent = latest.unitsTotal ? Math.round((latest.unitsDone / latest.unitsTotal) * 100) : 0
  const label = latest.status === 'running' ? 'Preparing your export' : latest.status === 'complete' ? 'Your export is ready' : 'The export failed'
  return (
    <SettingsRow
      label={label}
      layout="stacked"
      description={latest.status === 'failed' ? undefined : progressLine(latest)}
      error={latest.status === 'failed' ? `${latest.error ?? 'A source could not be read.'} Start a new export to try again.` : undefined}
    >
      <div className="grid w-full min-w-0 gap-3 text-sm">
        {latest.status === 'running' && (
          <>
            <Progress value={percent} aria-label="Export progress" />
            {continuesInBackground && <p className="text-muted-foreground">You can close this page. The export keeps going, and the download is here when you return.</p>}
          </>
        )}
        {latest.downloadUrl && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button asChild variant="outline"><a href={latest.downloadUrl} download>Download zip</a></Button>
            <span className="text-muted-foreground">
              Link expires {latest.downloadExpiresAt ? new Date(latest.downloadExpiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'soon'}; reload for a new one.
            </span>
          </div>
        )}
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" className="-ml-4">
              {open ? 'Hide sources' : `Show ${latest.units.length} sources`}
              <ChevronDown aria-hidden="true" className={open ? 'rotate-180' : undefined} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-1 divide-y divide-[color:var(--border-subtle)] rounded-lg border border-border">
              {latest.units.map((unit) => (
                <li key={unit.name} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{unit.name}</span>
                  <span className={unit.status === 'failed' ? 'text-[var(--surface-danger-text)]' : 'text-muted-foreground'}>{unitState(unit)}</span>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </SettingsRow>
  )
}

export function ExportSection({
  id = 'export',
  title = 'Export',
  endpoint,
  canExport,
  disabledReason,
  description = 'A zip of everything. Credentials are never included.',
  fetcher,
  continuesInBackground = false,
  children,
}: ExportSectionProps) {
  const { latest, error, loading, starting, running, start, retry } = useWorkspaceExport({ endpoint, enabled: canExport, fetcher })
  const showExport = canExport || disabledReason != null
  if (!showExport && children == null) return null
  return (
    <SettingsSection id={id} title={title}>
      {showExport && (
        <SettingsRow
          label="Export everything"
          layout="compact"
          description={description}
          disabledReason={canExport ? undefined : disabledReason}
          error={canExport ? error ?? undefined : undefined}
          onRetry={canExport && error ? retry : undefined}
        >
          <Button type="button" variant="outline" disabled={!canExport || loading || starting || running} loading={starting} onClick={() => void start()}>
            {running ? 'Exporting…' : 'Export'}
          </Button>
        </SettingsRow>
      )}
      {canExport && latest && <LatestExport latest={latest} continuesInBackground={continuesInBackground} />}
      {children}
    </SettingsSection>
  )
}
