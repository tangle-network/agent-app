/**
 * CommandPalette — the rendered half of the Cmd/Ctrl+K surface. Selection,
 * ranking, and grouping live in `/session-shell` (`buildCommandPaletteItems`,
 * `filterCommandPaletteItems`, `groupCommandPaletteItems`); this component is
 * the overlay, the input, and the keyboard model.
 *
 * Placement follows the PopoverSurface canon (AGENTS.md "UI chrome
 * ownership"): the panel PORTALS to `document.body` and positions in viewport
 * coordinates (`fixed`), so no host markup — a scroll rail, a `transform`, a
 * stacking context — can clip or trap it. Unlike the pickers it is CENTERED,
 * not trigger-anchored: the shared Dialog owns focus, dismissal and nested
 * modal layers, while the palette carries the same grammar — `bg-popover`,
 * `border-card-edge`, `OVERLAY_SHADOW`, the stamped surface attribute.
 *
 * The keyboard model is the ARIA combobox pattern: focus stays in the input,
 * ArrowUp/ArrowDown move `aria-activedescendant` across the FLAT result list
 * (groups are presentation), Enter selects, Escape closes, and closing returns
 * focus to whatever had it before the palette opened.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { Dialog, DialogContent, DialogTitle } from '@tangle-network/ui/primitives'

import {
  filterCommandPaletteItems,
  groupCommandPaletteItems,
  type CommandPaletteItem,
} from '../session-shell/index'
import { OVERLAY_SHADOW, POPOVER_SURFACE_ATTR } from './controls'

// The item type IS the palette's prop surface — a consumer builds items for
// this component, so it imports the type from here, not a second subpath.
export type { CommandPaletteItem } from '../session-shell/index'

function SearchGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}

export interface CommandPaletteProps {
  /** The full item list, build-ordered (recent-first sessions, then actions).
   *  Filtering and ranking are owned here — pass the UNFILTERED list. */
  items: CommandPaletteItem[]
  /** A row was chosen (click or Enter). The palette closes itself. */
  onSelect: (item: CommandPaletteItem) => void

  /** Controlled open state. Omit for self-managed state toggled by the hotkey. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Register the Cmd/Ctrl+K toggle. Default true. */
  hotkey?: boolean
  /** Stable return target when opening from a transient surface such as a menu
   *  item. Omit to restore the element focused before the palette opened. */
  returnFocusTo?: () => HTMLElement | null

  /** Async source is still resolving — the input stays live, the list shows
   *  the loading row instead of a premature empty state. */
  loading?: boolean
  /** Seed for the query (uncontrolled). */
  initialQuery?: string
  /** The query as it changes, including its reset on close. A host whose
   *  source is too large to pass whole searches it here and passes the
   *  matches back as `items`; the palette still ranks them against the query. */
  onQueryChange?: (query: string) => void
  placeholder?: string
  /** Empty-state copy. Default names the query: `No results for “…”`. */
  emptyMessage?: string
  /** Accessible name for the dialog. Default "Command palette". */
  label?: string
}

export function CommandPalette({
  items,
  onSelect,
  open: controlledOpen,
  onOpenChange,
  hotkey = true,
  returnFocusTo,
  loading = false,
  initialQuery,
  onQueryChange,
  placeholder = 'Search sessions and commands…',
  emptyMessage,
  label = 'Command palette',
}: CommandPaletteProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setInternalOpen(next)
      onOpenChange?.(next)
    },
    [controlledOpen, onOpenChange],
  )

  const [query, setQuery] = useState(initialQuery ?? '')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const surfaceId = useId()
  const listId = `${surfaceId}-list`

  // The flat list is the keyboard model: activedescendant indexes into it.
  // Sections regroup the SAME order for rendering, so the two never disagree.
  const flat = useMemo(() => filterCommandPaletteItems(items, query), [items, query])
  const sections = useMemo(() => groupCommandPaletteItems(flat), [flat])
  const activeIndex = flat.length === 0 ? 0 : Math.min(active, flat.length - 1)
  const activeId = flat.length > 0 ? `${listId}-${activeIndex}` : undefined

  // Cmd/Ctrl+K toggles from anywhere — the one global chord this surface owns.
  useEffect(() => {
    if (!hotkey) return
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(!open)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [hotkey, open, setOpen])

  // Focus belongs to Dialog's lifecycle, not this effect: an opening palette
  // must join the same modal stack as the drawer/menu that launched it.
  const restoreFocusRef = useRef<Element | null>(null)
  useEffect(() => {
    if (open) return
    setQuery(initialQuery ?? '')
    onQueryChange?.(initialQuery ?? '')
    setActive(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialQuery is a seed, not a subscription
  }, [open])

  // Keep the active row on screen as the list scrolls under the keyboard.
  useEffect(() => {
    if (!open || !activeId) return
    document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' })
  }, [open, activeId])

  const choose = useCallback(
    (item: CommandPaletteItem) => {
      onSelect(item)
      setOpen(false)
    },
    [onSelect, setOpen],
  )

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (flat.length > 0) setActive((activeIndex + 1) % flat.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (flat.length > 0) setActive((activeIndex - 1 + flat.length) % flat.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = flat[activeIndex]
      if (item) choose(item)
    }
  }

  let rowIndex = -1
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        hideCloseButton
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          restoreFocusRef.current = document.activeElement
          inputRef.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const restore = returnFocusTo?.() ?? restoreFocusRef.current
          restoreFocusRef.current = null
          if (restore instanceof HTMLElement && restore.isConnected) restore.focus()
        }}
        {...{ [POPOVER_SURFACE_ATTR]: surfaceId }}
        className={`top-[15%] z-[1000] flex max-h-[70vh] w-[560px] max-w-[calc(100vw-2rem)] translate-y-0 flex-col gap-0 overflow-hidden rounded-xl border-card-edge bg-popover p-0 ${OVERLAY_SHADOW}`}
      >
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5">
          <SearchGlyph className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-label={label}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              onQueryChange?.(e.target.value)
              setActive(0)
            }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground"
          />
        </div>

        {/* `min-h-0` lets the list absorb the panel's max-height instead of
            overflowing it — the same flex rule the picker panels rely on. */}
        <div role="listbox" id={listId} className="min-h-0 flex-1 overflow-y-auto p-1 pb-2">
          {loading && (
            <div className="px-3 py-4 text-center text-sm text-muted-foreground">Loading…</div>
          )}
          {!loading && flat.length === 0 && (
            <div className="px-3 py-4 text-center text-sm text-muted-foreground">
              {emptyMessage ?? (query.trim() ? `No results for “${query.trim()}”` : 'Nothing here yet')}
            </div>
          )}
          {!loading &&
            sections.map((section) => (
              <div key={section.group}>
                <div className="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {section.group}
                </div>
                {section.items.map((item) => {
                  rowIndex += 1
                  const index = rowIndex
                  return (
                    <div
                      key={item.id}
                      id={`${listId}-${index}`}
                      role="option"
                      aria-selected={index === activeIndex}
                      onMouseMove={() => setActive(index)}
                      onClick={() => choose(item)}
                      className={`flex w-full cursor-pointer items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-sm ${
                        index === activeIndex ? 'bg-accent' : ''
                      }`}
                    >
                      <span className="truncate text-foreground">{item.label}</span>
                      {item.description && (
                        <span className="truncate text-xs text-muted-foreground">{item.description}</span>
                      )}
                      {item.hint && (
                        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{item.hint}</span>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {query.trim() ? `${flat.length} of ${items.length}` : `${items.length} items`}
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className="rounded border border-border bg-background px-1 py-0.5">↑↓</kbd>
            <span>navigate</span>
            <kbd className="ml-1.5 rounded border border-border bg-background px-1 py-0.5">↵</kbd>
            <span>select</span>
            <kbd className="ml-1.5 rounded border border-border bg-background px-1 py-0.5">esc</kbd>
            <span>close</span>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
