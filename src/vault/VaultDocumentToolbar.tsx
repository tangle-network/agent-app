/** Actions for the selected file, with capability-bound mode/history/dock controls. */
import type { ReactNode } from 'react'
import { Download, History, Trash2 } from 'lucide-react'
import { ShellHeader } from '@tangle-network/sandbox-ui/workspace'
import type { VaultEditorMode, VaultFile, VaultPaneProps } from './contracts'

interface VaultDocumentToolbarProps {
  file: VaultFile
  className?: string
  editing?: { value: VaultEditorMode; onRich: () => void; onSource: () => void }
  history?: { open: boolean; dirty: boolean; onToggle: () => void }
  dock?: { label: string; open: boolean; blocked: boolean; title: string; onToggle: () => void }
  onDownloadFile?: VaultPaneProps['onDownloadFile']
  onDelete?: () => void
  children?: ReactNode
}

export function VaultDocumentToolbar({ file: selectedFile, className: pathBarClassName, editing, history, dock, onDownloadFile, onDelete, children }: VaultDocumentToolbarProps) {
  return (
    <ShellHeader className={`justify-between gap-2 px-4 ${pathBarClassName ?? 'bg-card'}`}>
      <span data-vault-path className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{selectedFile.path}</span>
      <div className="flex shrink-0 items-center gap-1">
        {editing && (
          <div className="mr-1 flex items-center gap-1">
            <button
              type="button"
              aria-label="Edit as rich text"
              aria-pressed={editing.value === 'rich'}
              onClick={editing.onRich}
              className={`inline-flex h-8 items-center rounded px-2.5 text-sm transition-colors ${
                editing.value === 'rich'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              Rich
            </button>
            <button
              type="button"
              aria-label="Edit as source"
              aria-pressed={editing.value === 'source'}
              onClick={editing.onSource}
              className={`inline-flex h-8 items-center rounded px-2.5 text-sm transition-colors ${
                editing.value === 'source'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              Source
            </button>
          </div>
        )}
        {history && (
          <button
            type="button"
            aria-pressed={history.open}
            disabled={history.dirty && !history.open}
            title={history.dirty && !history.open ? 'Save or discard your edits first' : 'Saved versions of this file'}
            onClick={history.onToggle}
            className={`inline-flex h-8 items-center gap-1.5 rounded px-2.5 text-sm transition-colors disabled:pointer-events-none disabled:opacity-40 ${
              history.open
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            <History className="size-4" aria-hidden="true" />
            History
          </button>
        )}
        {dock && (
          <button
            type="button"
            aria-label={dock.label}
            aria-pressed={dock.open}
            disabled={dock.blocked}
            title={dock.blocked ? 'Save your changes first' : dock.title}
            onClick={dock.onToggle}
            className={`inline-flex h-8 items-center gap-1 rounded px-2.5 text-sm transition-colors disabled:pointer-events-none disabled:opacity-40 ${
              dock.open
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            {dock.label}
          </button>
        )}
        {children}
        {onDownloadFile && (
          <button
            type="button"
            aria-label="Download this file"
            title="Download file"
            onClick={() => onDownloadFile(selectedFile)}
            className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Download className="h-4 w-4" />
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            aria-label="Delete this file"
            title="Delete file"
            onClick={onDelete}
            className="inline-flex h-7 w-7 items-center justify-center rounded text-[var(--surface-danger-text)] transition-colors hover:bg-destructive/10"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
    </ShellHeader>
  )
}
