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
 * not trigger-anchored: a palette has no trigger, so it does not reuse
 * `PopoverSurface` itself, but it carries the same grammar — `bg-popover`,
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
import { createPortal } from 'react-dom'

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

  /** Async source is still resolving — the input stays live, the list shows
   *  the loading row instead of a premature empty state. */
  loading?: boolean
  /** Seed for the query (uncontrolled). */
  initialQuery?: string
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
  loading = false,
  initialQuery,
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

  // Opening: remember who had focus, take it for the input. Closing: give it
  // back, reset the query, and drop the active row — a reopen starts clean.
  const restoreFocusRef = useRef<Element | null>(null)
  useEffect(() => {
    if (open) {
      restoreFocusRef.current = document.activeElement
      inputRef.current?.focus()
      return
    }
    setQuery(initialQuery ?? '')
    setActive(0)
    const restore = restoreFocusRef.current
    restoreFocusRef.current = null
    if (restore instanceof HTMLElement) restore.focus()
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
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  if (!open || typeof document === 'undefined') return null

  let rowIndex = -1
  return createPortal(
    <>
      <div
        aria-hidden
        data-testid="command-palette-backdrop"
        onMouseDown={() => setOpen(false)}
        className="fixed inset-0 z-[999] bg-background/80"
      />
      {/* Centering is a full-width flex wrapper, NOT a `-translate-x-1/2` on
          the panel: `.agent-pop-in` animates `transform` with fill mode
          `both`, and its settled `transform: none` would override a translate
          utility and leave the panel half a width to the right. The wrapper
          is click-transparent so the backdrop still receives outside
          mousedowns; the panel opts back in. */}
      <div className="pointer-events-none fixed inset-x-0 top-[15%] z-[1000] flex justify-center px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        {...{ [POPOVER_SURFACE_ATTR]: surfaceId }}
        className={`agent-pop-in pointer-events-auto flex max-h-[70vh] w-[560px] max-w-full flex-col overflow-hidden rounded-xl border border-card-edge bg-popover ${OVERLAY_SHADOW}`}
      >
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
      </div>
      </div>
    </>,
    document.body,
  )
}
