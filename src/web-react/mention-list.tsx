import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { joinClasses } from './class-names'
import type { MentionItem } from './use-file-mentions'

/** Imperative surface the editor's suggestion keymap drives. */
export interface MentionListHandle {
  /** Returns true when the key was consumed — the editor must not also act. */
  onKeyDown: (event: KeyboardEvent) => boolean
}

export interface MentionListProps {
  items: MentionItem[]
  loading: boolean
  error: boolean
  /** Shown when the fetch resolved to zero items. Default "No matches". */
  emptyText?: string
  renderItem?: (item: MentionItem) => ReactNode
  onSelect: (item: MentionItem) => void
  /** Root `role="listbox"` element id; option rows derive stable ids from it
   *  (`<id>-opt-<index>`) so the editor can point `aria-activedescendant` at
   *  the highlighted row. */
  id?: string
  /** Fired whenever the highlight moves (keys, hover, or a result-set
   *  re-home) — what keeps the editor's `aria-activedescendant` current. */
  onActiveChange?: (index: number) => void
  /** Extra classes merged onto the panel's root element, applied last so
   *  they win over the component's own. */
  className?: string
}

/**
 * The mention suggestion list: a flat, keyboard-driven menu with loading,
 * empty, and error states. Selection is owned here so ↑/↓ and Enter/Tab
 * resolve against the highlighted row; every key it handles is reported
 * consumed so the composer's Enter-to-send never fires while open. The panel
 * carries its own surface classes but no positioning — the editor places it
 * through `PopoverSurface`, per the popover canon.
 */
export const MentionList = forwardRef<MentionListHandle, MentionListProps>(
  function MentionList(
    { items, loading, error, emptyText = 'No matches', renderItem, onSelect, id, onActiveChange, className },
    ref,
  ) {
    const [selected, setSelected] = useState(0)
    // Mirrors `selected` so the key handler reads the live index even when keys
    // arrive faster than React commits (e.g. synchronous test-driven calls).
    const selectedRef = useRef(0)
    const onActiveChangeRef = useRef(onActiveChange)
    onActiveChangeRef.current = onActiveChange
    const move = (next: number) => {
      selectedRef.current = next
      setSelected(next)
      onActiveChangeRef.current?.(next)
    }

    // A new result set re-homes the highlight to the top.
    useEffect(() => {
      move(0)
    }, [items])

    useImperativeHandle(
      ref,
      () => ({
        onKeyDown(event) {
          // The handler must agree with the render: while loading or errored
          // the rows are not painted, so `items` still holding the PREVIOUS
          // query's results must not make Enter select an invisible file.
          const count = loading || error ? 0 : items.length
          switch (event.key) {
            case 'ArrowDown':
              if (count > 0) move((selectedRef.current + 1) % count)
              return true
            case 'ArrowUp':
              if (count > 0) move((selectedRef.current - 1 + count) % count)
              return true
            case 'Enter':
              // Consume even with nothing to select so the message never
              // submits while the popover is open. Clamp the index: a
              // shrunken result set re-homes the highlight in an effect, and
              // a key can arrive before that effect commits.
              if (count > 0) onSelect(items[Math.min(selectedRef.current, count - 1)]!)
              return true
            case 'Tab':
              // Tab selects only when a row exists; with nothing selectable
              // (loading, error, empty) it must fall through to normal focus
              // navigation — consuming it would trap keyboard focus.
              if (count === 0) return false
              onSelect(items[Math.min(selectedRef.current, count - 1)]!)
              return true
            default:
              return false
          }
        },
      }),
      [items, loading, error, onSelect],
    )

    return (
      <div
        role="listbox"
        id={id}
        aria-label="File mentions"
        className={joinClasses(
          'max-h-64 min-w-[16rem] max-w-sm overflow-y-auto rounded-xl border border-border',
          'bg-popover p-1 text-popover-foreground shadow-lg',
          className,
        )}
      >
        {loading && (
          <div className="flex items-center gap-2 px-2.5 py-2 text-sm text-muted-foreground">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            Searching…
          </div>
        )}

        {!loading && error && (
          <div className="px-2.5 py-2 text-sm text-destructive">Couldn’t load matches</div>
        )}

        {!loading && !error && items.length === 0 && (
          <div className="px-2.5 py-2 text-sm text-muted-foreground">{emptyText}</div>
        )}

        {!loading &&
          !error &&
          items.map((item, index) => {
            const active = index === selected
            return (
              <button
                type="button"
                key={item.id}
                id={id ? `${id}-opt-${index}` : undefined}
                role="option"
                aria-selected={active}
                // Keyboard navigation must keep the highlight visible inside
                // the panel's own scroll (`max-h-64 overflow-y-auto`).
                ref={(el) => {
                  if (active) el?.scrollIntoView?.({ block: 'nearest' })
                }}
                // Pointer down only PREVENTS the focus steal (a blur would
                // tear down the suggestion mid-select); selection happens on
                // click so mouse, touch, keyboard, and assistive-technology
                // synthesized activations all share the native path — and a
                // secondary-button press never inserts a mention.
                onMouseDown={(event) => {
                  event.preventDefault()
                }}
                onClick={() => onSelect(item)}
                // Routes through the same path arrows use so the imperative
                // Enter/Tab handler (which reads `selectedRef`, not `selected`)
                // agrees with the row the pointer is over.
                onMouseEnter={() => move(index)}
                className={joinClasses(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm',
                  active ? 'bg-primary/10 text-foreground' : 'text-muted-foreground',
                )}
              >
                {renderItem ? (
                  renderItem(item)
                ) : (
                  <>
                    <span className="truncate text-foreground">{item.label}</span>
                    {item.detail && (
                      <span className="ml-auto truncate text-xs text-muted-foreground">
                        {item.detail}
                      </span>
                    )}
                  </>
                )}
              </button>
            )
          })}
      </div>
    )
  },
)
