/**
 * Export panel for a workspace settings page. Starts an export, drives it to
 * completion by calling `advance` while the page is open, shows each source as
 * it finishes, and offers the signed download link. Reopening the page resumes
 * a running export.
 */

import { Button, Card, StatusPill, type StatusTone } from '@tangle-network/ui/primitives'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExportProgress } from './types'

export interface WorkspaceExportPanelProps {
  /** The mount path of the product's export routes, e.g. `/api/workspaces/ws-1/exports`. */
  endpoint: string
  /** Hidden for non-owners; the server refuses them regardless. */
  canExport: boolean
  title?: string
  className?: string
  fetcher?: typeof fetch
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

const TONE: Record<ExportProgress['status'], StatusTone> = { running: 'info', complete: 'success', failed: 'danger' }
const LABEL: Record<ExportProgress['status'], string> = { running: 'Preparing', complete: 'Ready', failed: 'Failed' }

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
  if (!response.ok) throw new Error(body?.error?.message ?? `Request failed (${response.status})`)
  return body as T
}

export function WorkspaceExportPanel({ endpoint, canExport, title = 'Export workspace data', className, fetcher }: WorkspaceExportPanelProps) {
  const doFetch = fetcher ?? fetch
  const [exports, setExports] = useState<ExportProgress[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const driving = useRef<string | null>(null)
  const mounted = useRef(true)

  useEffect(() => () => {
    mounted.current = false
  }, [])

  const upsert = useCallback((next: ExportProgress) => {
    setExports((current) => [next, ...current.filter((e) => e.id !== next.id)])
  }, [])

  const drive = useCallback(async (id: string) => {
    if (driving.current === id) return
    driving.current = id
    // A failed request is retried: the server records each attempt and fails
    // the export itself once a source cannot finish.
    let failures = 0
    try {
      for (;;) {
        if (!mounted.current) return
        try {
          const next = await readJson<ExportProgress>(await doFetch(`${endpoint}/${id}/advance`, { method: 'POST', credentials: 'same-origin' }))
          if (!mounted.current) return
          failures = 0
          setError(null)
          upsert(next)
          if (next.status !== 'running') return
        } catch (err) {
          failures += 1
          if (failures >= 6) throw err
          if (mounted.current) setError(`Still working; retrying (${failures})`)
        }
        // Another tab may hold the lease, or the last request failed; wait before asking again.
        await new Promise((resolve) => setTimeout(resolve, failures ? 3000 * failures : 1500))
      }
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      driving.current = null
    }
  }, [doFetch, endpoint, upsert])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const body = await readJson<{ exports: ExportProgress[] }>(await doFetch(endpoint, { credentials: 'same-origin' }))
      if (!mounted.current) return
      setExports(body.exports)
      const running = body.exports.find((e) => e.status === 'running')
      if (running) void drive(running.id)
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [doFetch, drive, endpoint])

  useEffect(() => {
    if (canExport) void refresh()
  }, [canExport, refresh])

  const start = async () => {
    setStarting(true)
    setError(null)
    try {
      const job = await readJson<ExportProgress>(await doFetch(endpoint, { method: 'POST', credentials: 'same-origin' }))
      upsert(job)
      void drive(job.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  if (!canExport) return null
  const latest = exports[0]
  const running = latest?.status === 'running'

  return (
    <Card className={['min-w-0 space-y-4 p-5 shadow-none', className].filter(Boolean).join(' ')} aria-busy={running || loading || undefined}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            One zip with every conversation, record, file and the agent workspace, plus a manifest with checksums. Connection credentials are never included.
          </p>
        </div>
        <Button type="button" onClick={start} disabled={starting || running}>
          {running ? 'Exporting…' : starting ? 'Starting…' : 'Export'}
        </Button>
      </header>

      {error ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/40 p-3 text-sm text-destructive">
          <p className="min-w-0 flex-1 break-words">{error}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => (latest?.status === 'running' ? void drive(latest.id) : void refresh())}>
            Retry
          </Button>
        </div>
      ) : null}

      {latest ? (
        <section aria-label="Latest export" className="space-y-3 rounded-xl border border-border p-4">
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill tone={TONE[latest.status]} size="sm">{LABEL[latest.status]}</StatusPill>
            <span className="text-sm text-muted-foreground">
              {latest.unitsDone} of {latest.unitsTotal} sources · {formatBytes(latest.bytes)}
            </span>
            {latest.current ? <span className="min-w-0 truncate text-sm text-muted-foreground">Now: {latest.current}</span> : null}
          </div>
          <div
            role="progressbar"
            aria-label="Export progress"
            aria-valuemin={0}
            aria-valuemax={latest.unitsTotal}
            aria-valuenow={latest.unitsDone}
            className="h-2 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
              style={{ width: `${latest.unitsTotal ? Math.round((latest.unitsDone / latest.unitsTotal) * 100) : 0}%` }}
            />
          </div>
          {latest.status === 'failed' ? (
            <p className="text-sm text-destructive [overflow-wrap:anywhere]">{latest.error ?? 'The export failed.'} Start a new export to try again.</p>
          ) : null}
          {latest.downloadUrl ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button asChild>
                <a href={latest.downloadUrl} download>Download zip</a>
              </Button>
              <span className="text-xs text-muted-foreground">
                Link expires {latest.downloadExpiresAt ? new Date(latest.downloadExpiresAt).toLocaleTimeString() : 'soon'}; refresh the page for a new one.
              </span>
            </div>
          ) : null}
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Sources</summary>
            <ul className="mt-2 divide-y divide-border">
              {latest.units.map((unit) => (
                <li key={unit.name} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{unit.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {unit.status === 'pending' ? 'waiting' : unit.status === 'empty' ? 'nothing to export' : unit.status === 'failed' ? 'failed' : unit.rows !== undefined ? `${unit.rows} rows` : unit.files !== undefined ? `${unit.files} files · ${formatBytes(unit.bytes)}` : formatBytes(unit.bytes)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </section>
      ) : loading ? (
        <p role="status" className="text-sm text-muted-foreground">Loading exports…</p>
      ) : null}
    </Card>
  )
}
