/** Responsive navigation between the file list and the selected document. */
interface VaultPaneNavigationProps {
  label: string
  selectedPath: string | null
  showFiles: boolean
  onShowFiles: () => void
  onShowDocument: () => void
}

export function VaultPaneNavigation({ label, selectedPath, showFiles, onShowFiles, onShowDocument }: VaultPaneNavigationProps) {
  return (
    <>
      {selectedPath && (
      <nav aria-label={`${label} navigation`} className="flex shrink-0 items-center gap-1 border-b border-border p-2 @[60rem]/vault:hidden">
        <button
          type="button"
          aria-pressed={showFiles}
          onClick={onShowFiles}
          className={`shrink-0 rounded-md px-3 py-2 text-sm ${showFiles ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted'}`}
        >
          Files
        </button>
        {selectedPath && (
          <button
            type="button"
            aria-pressed={!showFiles}
            onClick={onShowDocument}
            title={selectedPath}
            className={`min-w-0 truncate rounded-md px-3 py-2 text-sm ${!showFiles ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted'}`}
          >
            {selectedPath.split('/').pop()}
          </button>
        )}
      </nav>
      )}
    </>
  )
}
