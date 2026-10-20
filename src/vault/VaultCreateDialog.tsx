/** Controlled file-creation confirmation; mutation and dismissal stay with the pane. */
import { ConfirmDialog } from './ConfirmDialog'
import type { VaultOperationFailure } from './contracts'

interface VaultCreateDialogProps {
  open: boolean
  path: string
  label: string
  folder: string | null
  busy: boolean
  error: VaultOperationFailure | null
  onPathChange: (path: string) => void
  onConfirm: () => void
  onCancel: () => void
}

export function VaultCreateDialog({ open: createOpen, path: newPath, label, folder: activeFolder, busy: creating, error: createError, onPathChange, onConfirm, onCancel }: VaultCreateDialogProps) {
  const createFileName = newPath.trim().split('/').pop()?.trim() ?? ''
  return (
    <ConfirmDialog
      open={createOpen}
      title="Create file"
      description={activeFolder ? `Add a new document to ${activeFolder}.` : `Add a new document to ${label}.`}
      confirmLabel={creating ? 'Creating…' : 'Create'}
      // A prefilled folder is a path with no file name yet, so emptiness is
      // not the test — `folder/` would otherwise be sent to the port as a
      // file to create.
      confirmDisabled={creating || !createFileName}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <div className="space-y-2">
        <input
          value={newPath}
          autoFocus
          onChange={(e) => onPathChange(e.target.value)}
          placeholder="e.g. playbooks/new-strategy.md"
          aria-label="New file path"
          className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground"
        />
        {createError && <p role="alert" className="text-xs text-[var(--surface-danger-text)]">{createError.message}</p>}
      </div>
    </ConfirmDialog>
  )
}
