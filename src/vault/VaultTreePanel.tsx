/** File-tree chrome and search input; the controller supplies guarded tree content. */
import type { ReactNode, RefObject } from 'react'
import { Folder, Plus, RefreshCw } from 'lucide-react'

const TREE_ICON_BUTTON = 'inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:size-10'

interface VaultTreePanelProps {
  label: string
  treeHeadingId: string
  headerActions?: ReactNode
  onRefresh: () => void
  onCreate?: () => void
  activeFolder: string | null
  onClearFolder: () => void
  query: string
  onQueryChange: (query: string) => void
  canSearchContent: boolean
  empty: boolean
  searchRef: RefObject<HTMLInputElement | null>
  children: ReactNode
}

export function VaultTreePanel({ label, treeHeadingId, headerActions, onRefresh, onCreate, activeFolder, onClearFolder, query, onQueryChange, canSearchContent, empty, searchRef, children }: VaultTreePanelProps) {
  const noun = label.toLowerCase()
  return (
    <section
      aria-labelledby={treeHeadingId}
      data-vault-tree-surface
      data-slot="card"
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-raised"
    >
      <div className="flex shrink-0 items-center gap-2 px-3 pb-2 pt-3">
        <h2 id={treeHeadingId} className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {label}
        </h2>
        <div className="flex shrink-0 items-center gap-1">
          {headerActions}
          <button
            type="button"
            aria-label={`Refresh ${noun}`}
            title="Refresh"
            onClick={onRefresh}
            className={`${TREE_ICON_BUTTON} text-muted-foreground hover:bg-muted hover:text-foreground`}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
          </button>
          {onCreate && (
            <button
              type="button"
              title="New file"
              aria-label={activeFolder ? `New file in ${activeFolder}` : 'New file'}
              onClick={onCreate}
              className={`${TREE_ICON_BUTTON} bg-primary text-primary-foreground hover:bg-primary/90`}
            >
              <Plus className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      <div className="shrink-0 px-3 pb-2">
        <input
          ref={searchRef}
          type="search"
          disabled={empty}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={canSearchContent ? `Search ${noun} names and text…` : `Search ${noun}…`}
          aria-label={`Search ${noun}`}
          className="h-8 w-full rounded-md border border-[var(--field-border,var(--color-border))] bg-[var(--well,var(--color-input))] px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:text-base"
        />
      </div>
      {activeFolder && onCreate && (
        <div className="mx-3 mb-2 flex shrink-0 items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-sm">
          <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="shrink-0 text-muted-foreground">New files go in</span>
          <span data-vault-folder className="min-w-0 flex-1 truncate font-medium text-foreground" title={activeFolder}>
            {activeFolder}
          </span>
          <button
            type="button"
            aria-label="Clear the active folder"
            onClick={onClearFolder}
            className="shrink-0 rounded px-1 text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Clear
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border px-1.5 py-1.5">
        {children}
      </div>
    </section>
  )
}
