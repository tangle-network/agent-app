/** Session rename and deletion with their confirmation dialogs. */
import { useCallback, useState, type ReactNode } from 'react'
import { sessionLabel, type SessionSummary } from '../session-shell/index'
import { Input } from '@tangle-network/ui/primitives'
import { ActionDialog, ActionDialogButton } from './action-dialog'

// ---------------------------------------------------------------------------
// useSessionActions — rename / delete over injected mutations
// ---------------------------------------------------------------------------

export interface SessionActionsOptions {
  /** Persist a new title. Reject to surface the error in the dialog. */
  renameSession: (sessionId: string, title: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  /** Called after a successful rename/delete — revalidate the rail here. */
  onChanged?: () => void
  /** Called after deleting the session the user is currently viewing, so the
   *  product can navigate away from a route that no longer resolves. */
  onDeletedCurrent?: () => void
  /** The open session, compared against the delete target. */
  currentSessionId?: string | null
  /** Product toast/log seam. Errors also render inside the dialog. */
  notify?: (level: 'success' | 'error', message: string) => void
  labels?: Partial<SessionActionLabels>
}

export interface SessionActionLabels {
  renameTitle: string
  renameField: string
  renameSubmit: string
  deleteTitle: string
  deleteBody: (title: string) => string
  deleteSubmit: string
  cancel: string
  renamed: string
  deleted: string
  renameFailed: string
  deleteFailed: string
}

const DEFAULT_LABELS: SessionActionLabels = {
  renameTitle: 'Rename session',
  renameField: 'Title',
  renameSubmit: 'Save',
  deleteTitle: 'Delete session?',
  deleteBody: (title) => `This will permanently delete “${title}” and its messages. This cannot be undone.`,
  deleteSubmit: 'Delete',
  cancel: 'Cancel',
  renamed: 'Session renamed',
  deleted: 'Session deleted',
  renameFailed: 'Failed to rename session',
  deleteFailed: 'Failed to delete session',
}

export interface SessionActions {
  openRename: (session: SessionSummary) => void
  openDelete: (session: SessionSummary) => void
  /** Render once, anywhere that survives navigation (the layout). */
  dialogs: ReactNode
  busy: boolean
}

/**
 * Rename + delete for one session, shared by the rail kebab and the history
 * row menu so both drive the same dialogs and the same product mutations.
 *
 * Dialogs are owned here rather than returned as raw state: two surfaces
 * needing the same confirm step is exactly how a product ends up with two
 * subtly different delete confirmations.
 */
export function useSessionActions({
  renameSession,
  deleteSession,
  onChanged,
  onDeletedCurrent,
  currentSessionId,
  notify,
  labels,
}: SessionActionsOptions): SessionActions {
  const text = { ...DEFAULT_LABELS, ...labels }
  const [renameTarget, setRenameTarget] = useState<SessionSummary | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const openRename = useCallback((session: SessionSummary) => {
    setError(null)
    setRenameTarget(session)
    setRenameValue(session.title ?? '')
  }, [])

  const openDelete = useCallback((session: SessionSummary) => {
    setError(null)
    setDeleteTarget(session)
  }, [])

  const submitRename = useCallback(async () => {
    if (!renameTarget) return
    const title = renameValue.trim()
    // A no-op rename closes rather than writing — otherwise every accidental
    // open costs a request and a revalidation.
    if (!title || title === renameTarget.title) {
      setRenameTarget(null)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await renameSession(renameTarget.id, title)
      setRenameTarget(null)
      notify?.('success', text.renamed)
      onChanged?.()
    } catch (e) {
      const message = e instanceof Error ? e.message : text.renameFailed
      setError(message)
      notify?.('error', message)
    } finally {
      setBusy(false)
    }
  }, [renameTarget, renameValue, renameSession, notify, onChanged, text.renamed, text.renameFailed])

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    const deletingCurrent = currentSessionId != null && deleteTarget.id === currentSessionId
    setBusy(true)
    setError(null)
    try {
      await deleteSession(deleteTarget.id)
      setDeleteTarget(null)
      notify?.('success', text.deleted)
      onChanged?.()
      if (deletingCurrent) onDeletedCurrent?.()
    } catch (e) {
      const message = e instanceof Error ? e.message : text.deleteFailed
      setError(message)
      notify?.('error', message)
    } finally {
      setBusy(false)
    }
  }, [deleteTarget, currentSessionId, deleteSession, notify, onChanged, onDeletedCurrent, text.deleted, text.deleteFailed])

  const dialogs = (
    <>
      {renameTarget && (
        <ActionDialog
          title={text.renameTitle}
          onClose={() => setRenameTarget(null)}
          busy={busy}
          error={error}
          footer={
            <>
              <ActionDialogButton onClick={() => setRenameTarget(null)} disabled={busy} variant="ghost">
                {text.cancel}
              </ActionDialogButton>
              <ActionDialogButton onClick={() => void submitRename()} disabled={busy || !renameValue.trim()}>
                {text.renameSubmit}
              </ActionDialogButton>
            </>
          }
        >
          <label htmlFor="agent-app-rename-session" className="text-xs text-muted-foreground">
            {text.renameField}
          </label>
          <Input
            id="agent-app-rename-session"
            value={renameValue}
            autoFocus
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) {
                e.preventDefault()
                void submitRename()
              }
            }}
            className="mt-1.5"
          />
        </ActionDialog>
      )}

      {deleteTarget && (
        <ActionDialog
          title={text.deleteTitle}
          onClose={() => setDeleteTarget(null)}
          busy={busy}
          error={error}
          footer={
            <>
              <ActionDialogButton onClick={() => setDeleteTarget(null)} disabled={busy} variant="ghost">
                {text.cancel}
              </ActionDialogButton>
              <ActionDialogButton onClick={() => void confirmDelete()} disabled={busy} variant="destructive">
                {text.deleteSubmit}
              </ActionDialogButton>
            </>
          }
        >
          <p className="text-sm text-muted-foreground">{text.deleteBody(sessionLabel(deleteTarget))}</p>
        </ActionDialog>
      )}
    </>
  )

  return { openRename, openDelete, dialogs, busy }
}
