/**
 * A file's saved versions, newest first, with a read-only preview of the one
 * selected and a confirmed Restore. Restoring writes the old text as a new
 * version, so the version it replaces stays in the list.
 */

import { useCallback, useEffect, useId, useState, type ReactNode } from 'react'
import { History, X } from 'lucide-react'
import { ConfirmDialog } from './ConfirmDialog'
import type { VaultRevision } from './contracts'

type Load<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string }

function message(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function savedAtLabel(savedAt: string) {
  const date = new Date(savedAt)
  if (Number.isNaN(date.getTime())) return savedAt
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)
}

export interface VaultHistoryPanelProps {
  path: string
  listRevisions: (path: string) => Promise<VaultRevision[]>
  readRevision: (path: string, revisionId: string) => Promise<string>
  /** False hides Restore, for a reader who cannot write. */
  canRestore: boolean
  /** Renders a version's text read-only, the way the pane renders the file. */
  renderPreview: (content: string) => ReactNode
  /** Writes `content` as the file's newest version. */
  onRestore: (content: string) => Promise<void>
  onClose: () => void
}

export function VaultHistoryPanel({
  path,
  listRevisions,
  readRevision,
  canRestore,
  renderPreview,
  onRestore,
  onClose,
}: VaultHistoryPanelProps) {
  const listId = useId()
  const [revisions, setRevisions] = useState<Load<VaultRevision[]>>({ status: 'loading' })
  const [listNonce, setListNonce] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [contents, setContents] = useState<Record<string, Load<string>>>({})
  const [confirming, setConfirming] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setRevisions({ status: 'loading' })
    listRevisions(path).then(
      (value) => {
        if (cancelled) return
        setRevisions({ status: 'ready', value })
        setSelectedId((current) => current ?? value[0]?.id ?? null)
      },
      (error) => {
        if (!cancelled) setRevisions({ status: 'error', message: message(error, 'Could not list the saved versions.') })
      },
    )
    return () => { cancelled = true }
  }, [path, listRevisions, listNonce])

  const loadContent = useCallback((id: string) => {
    setContents((current) => ({ ...current, [id]: { status: 'loading' } }))
    readRevision(path, id).then(
      (value) => setContents((current) => ({ ...current, [id]: { status: 'ready', value } })),
      (error) => setContents((current) => ({
        ...current,
        [id]: { status: 'error', message: message(error, 'Could not read this version.') },
      })),
    )
  }, [path, readRevision])

  useEffect(() => {
    if (selectedId && !contents[selectedId]) loadContent(selectedId)
  }, [selectedId, contents, loadContent])

  const list = revisions.status === 'ready' ? revisions.value : []
  const selected = list.find((revision) => revision.id === selectedId) ?? null
  const content = selectedId ? contents[selectedId] : undefined
  const restorable = canRestore && selected !== null && !selected.current && content?.status === 'ready'

  const restore = async () => {
    if (content?.status !== 'ready') return
    setRestoring(true)
    setRestoreError(null)
    try {
      await onRestore(content.value)
      setConfirming(false)
    } catch (error) {
      setRestoreError(message(error, 'Could not restore this version.'))
      setConfirming(false)
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div data-vault-history className="flex h-full min-h-0 flex-col @[45rem]/vault:flex-row">
      <nav
        aria-labelledby={listId}
        className="flex max-h-56 shrink-0 flex-col border-b border-border @[45rem]/vault:max-h-none @[45rem]/vault:w-64 @[45rem]/vault:border-b-0 @[45rem]/vault:border-r"
      >
        <h3 id={listId} className="flex items-center gap-2 px-4 pb-2 pt-3 text-sm font-semibold text-foreground">
          <History className="size-4 text-muted-foreground" aria-hidden="true" />
          Saved versions
        </h3>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {revisions.status === 'loading' && <p role="status" className="px-2 py-1 text-sm text-muted-foreground">Loading versions…</p>}
          {revisions.status === 'error' && (
            <div role="alert" className="space-y-2 px-2 py-1 text-sm text-[var(--surface-danger-text)]">
              <p>{revisions.message}</p>
              <button type="button" onClick={() => setListNonce((n) => n + 1)} className="font-medium underline-offset-2 hover:underline">
                Try again
              </button>
            </div>
          )}
          {revisions.status === 'ready' && list.length === 0 && (
            <p className="px-2 py-1 text-sm text-muted-foreground">No earlier versions are saved for this file.</p>
          )}
          <ul className="space-y-0.5">
            {list.map((revision) => (
              <li key={revision.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(revision.id)}
                  aria-pressed={revision.id === selectedId}
                  className={`w-full rounded-md px-2 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                    revision.id === selectedId ? 'bg-muted' : 'hover:bg-muted'
                  }`}
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    {savedAtLabel(revision.savedAt)}
                    {revision.current && (
                      <span className="rounded-full border border-border px-2 text-sm font-normal text-muted-foreground">Current</span>
                    )}
                  </span>
                  {revision.author && <span className="mt-0.5 block text-sm text-muted-foreground">{revision.author}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
          <p className="min-w-0 text-sm text-muted-foreground">
            {selected
              ? selected.current
                ? 'This is the version the file holds now.'
                : `Saved ${savedAtLabel(selected.savedAt)}${selected.author ? ` by ${selected.author}` : ''}. Read only.`
              : 'Choose a version to see it.'}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {restorable && (
              <button
                type="button"
                onClick={() => { setRestoreError(null); setConfirming(true) }}
                className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Restore this version
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-sm text-foreground transition-colors hover:bg-muted"
            >
              <X className="size-4" aria-hidden="true" />
              Close history
            </button>
          </div>
        </div>
        {restoreError && (
          <p role="alert" className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-[var(--surface-danger-text)]">
            {restoreError}
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-hidden">
          {content?.status === 'ready' ? (
            renderPreview(content.value)
          ) : content?.status === 'error' ? (
            <div role="alert" className="space-y-2 p-6 text-sm text-[var(--surface-danger-text)]">
              <p>{content.message}</p>
              <button type="button" onClick={() => selectedId && loadContent(selectedId)} className="font-medium underline-offset-2 hover:underline">
                Try again
              </button>
            </div>
          ) : selectedId ? (
            <p role="status" className="p-6 text-sm text-muted-foreground">Loading this version…</p>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        title="Restore this version?"
        description={`${path} goes back to the version saved ${selected ? savedAtLabel(selected.savedAt) : ''}. The version it holds now stays in this list.`}
        confirmLabel={restoring ? 'Restoring…' : 'Restore version'}
        confirmDisabled={restoring}
        onConfirm={() => void restore()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  )
}
