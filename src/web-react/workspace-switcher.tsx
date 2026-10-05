import { useCallback, useState, type ReactNode } from 'react'
import { CheckGlyph, OVERLAY_SHADOW, PopoverSurface } from './controls'
import { usePopoverDialog } from './popover-dialog'

export interface WorkspaceSwitcherItem {
  id: string
  name: string
  /** Host-provided presentation; never used to resolve identity. */
  icon?: ReactNode
}
export interface WorkspaceSwitcherProps {
  items: readonly WorkspaceSwitcherItem[]
  value: string | null | undefined
  onChange: (id: string) => void
  label?: string
  placeholder?: string
  searchLabel?: string
  emptyLabel?: string
  collapsed?: boolean
  variant?: 'inline' | 'block'
  /** Product-owned creation/navigation actions. No new data or route owner. */
  footer?: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/** Searchable workspace/client/project selection, shared across all workspace shells. */
export function WorkspaceSwitcher({
  items, value, onChange, label = 'Switch workspace', placeholder = 'Select workspace',
  searchLabel = 'Search workspaces', emptyLabel = 'No workspaces available',
  collapsed = false, variant = 'block', footer, open: controlledOpen, onOpenChange,
}: WorkspaceSwitcherProps) {
  const [localOpen, setLocalOpen] = useState(false)
  const [query, setQuery] = useState('')
  const open = controlledOpen ?? localOpen
  const changeOpen = useCallback((next: boolean) => {
    setLocalOpen(next)
    if (!next) setQuery('')
    onOpenChange?.(next)
  }, [onOpenChange])
  const { containerRef, triggerRef, panelRef, triggerProps, id } = usePopoverDialog(open, changeOpen)
  const current = items.find((item) => item.id === value)
  const search = query.trim().toLocaleLowerCase()
  const visible = search ? items.filter((item) => item.name.toLocaleLowerCase().includes(search)) : items
  const mark = (item?: WorkspaceSwitcherItem) => item?.icon ?? <WorkspaceInitial name={item?.name ?? ''} />
  return (
    <div ref={containerRef} className={`min-w-0 ${variant === 'block' ? 'w-full' : 'inline-flex'}`}>
      <button type="button" {...triggerProps} onClick={() => changeOpen(!open)}
        aria-label={`${label}: ${current?.name ?? placeholder}`} title={current?.name ?? placeholder}
        className={`flex min-h-10 min-w-0 items-center gap-2 rounded-lg text-left text-sm text-foreground transition-colors hover:bg-muted ${collapsed ? 'w-10 justify-center' : variant === 'block' ? 'w-full border border-border px-2 py-1.5' : 'max-w-[16rem] px-2.5 py-1.5'}`}>
        {mark(current)}
        {!collapsed && <><span className="min-w-0 flex-1 truncate font-medium">{current?.name ?? placeholder}</span><svg aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="m8 9 4-4 4 4m-8 6 4 4 4-4" /></svg></>}
      </button>
      <PopoverSurface open={open} id={id} role="dialog" aria-label={label} triggerRef={triggerRef} panelRef={panelRef}
        contentKey={`${query}:${items.length}`} className={`w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-card-edge bg-popover p-2 text-foreground ${OVERLAY_SHADOW}`}>
        <input data-autofocus aria-label={searchLabel} placeholder={searchLabel} value={query} onChange={(event) => setQuery(event.target.value)}
          className="mb-2 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground" />
        <div className="max-h-64 overflow-y-auto">
          {visible.map((item) => (
            <button key={item.id} type="button" aria-current={item.id === value ? 'true' : undefined}
              className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-muted"
              onClick={() => { onChange(item.id); changeOpen(false); triggerRef.current?.focus() }}>
              {mark(item)}<span className="min-w-0 flex-1 break-words">{item.name}</span>
              {item.id === value && <CheckGlyph className="h-4 w-4 shrink-0 text-primary" />}
            </button>
          ))}
          {visible.length === 0 && <p className="p-3 text-sm text-muted-foreground" role="status">{items.length === 0 ? emptyLabel : 'No matches. Try another search.'}</p>}
        </div>
        {footer != null && <div className="mt-2 border-t border-border pt-2">{footer}</div>}
      </PopoverSurface>
    </div>
  )
}

/**
 * The one workspace avatar: a rounded square with the first letter, tinted
 * with the product accent. The switchers and the listing all use it, so a
 * client looks the same wherever it appears.
 */
export function WorkspaceInitial({ name, size = 'sm' }: { name: string; size?: 'sm' | 'lg' }) {
  const letter = Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '?'
  const box = size === 'lg' ? 'h-10 w-10 rounded-lg text-base' : 'h-6 w-6 rounded-md text-xs'
  return (
    // The letter is foreground on an accent tint, not accent on accent: a dim
    // dark-theme primary (physim's aubergine) left a primary letter unreadable.
    <span aria-hidden className={`flex shrink-0 items-center justify-center bg-primary/15 font-semibold text-foreground ring-1 ring-inset ring-primary/20 ${box}`}>
      {letter}
    </span>
  )
}
