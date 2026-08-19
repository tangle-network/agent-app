/**
 * Selection actions — the transcript's "highlight a passage, hand it to the
 * agent" gesture (issue #420). The reader selects a run of text in the
 * transcript and a small action surface opens next to the selection; choosing
 * an action hands the quoted passage to the host's `onSelectionAction`
 * callback, and the host decides what it means (seed the composer, ask about
 * it, rewrite it). The surface owns only the mechanism — the action list and
 * the destination are both seams.
 *
 * Wired into `ChatMessages` via the `selectionActions` + `onSelectionAction`
 * props; both must be present or the transcript renders untouched.
 *
 * Popover canon: the panel renders through `PopoverSurface` (portaled to
 * `document.body`, viewport-anchored), anchored to a zero-size span the scope
 * positions over the selection — a selection has no trigger element, so the
 * span IS the anchor `PopoverSurface` measures. The span sits in the
 * transcript's flow (absolute inside the relative scope), so a host's scroll
 * container moves anchor and selection together and the surface's own
 * scroll/resize re-placement reads a fresh rect. `usePopover` supplies the
 * outside-mousedown/Escape close model.
 */

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { OVERLAY_SHADOW, POPOVER_OPTION_FOCUS, PopoverSurface, usePopover } from './controls'

/** One action offered on a selected passage. The host supplies the list —
 *  the surface ships no default verbs, because what "ask" or "rewrite" means
 *  is the product's business. */
export interface ChatSelectionAction {
  /** Stable id handed back to the host callback. */
  id: string
  /** The button label. */
  label: string
}

/** A selection captured inside the transcript: the quoted text plus the
 *  container-relative box the virtual anchor is positioned at. */
interface CapturedSelection {
  text: string
  top: number
  left: number
  width: number
  height: number
}

/** Two captures describe the same selection when text and box agree — the
 *  comparison a dismissal needs, since every selection event produces a fresh
 *  capture OBJECT for what may be an unchanged selection. */
function sameSelection(a: CapturedSelection, b: CapturedSelection): boolean {
  return (
    a.text === b.text &&
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height
  )
}

/**
 * Track text selection inside `containerRef` and report the current capture,
 * or null when there is no usable in-container selection.
 *
 * Two open paths, because the two selection modalities have different
 * cadences:
 *  - pointer: `selectionchange` fires on every drag frame, so while the
 *    pointer is down changes are ignored; the capture is taken once, on
 *    `mouseup`. A mid-drag surface would strobe.
 *  - keyboard (Shift+arrows over a focusable transcript): no drag phase —
 *    every `selectionchange` re-captures live, which is what keeps the
 *    surface reachable without a mouse.
 *
 * A collapsed selection reports null, which is what closes the surface when
 * the reader clicks on to something else.
 */
function useTranscriptSelection(
  containerRef: RefObject<HTMLElement | null>,
): CapturedSelection | null {
  const [captured, setCaptured] = useState<CapturedSelection | null>(null)
  const pointerDownRef = useRef(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const read = (): CapturedSelection | null => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
      const text = selection.toString().trim()
      if (!text) return null
      const range = selection.getRangeAt(0)
      // Transcript-scoped: a selection anywhere else (the composer, the rail,
      // another panel) must not raise the surface. `intersectsNode` covers a
      // range whose common ancestor sits ABOVE the container (a selection
      // spanning from the transcript into the rail); the `contains` fallback
      // covers Range implementations that predate it.
      const inside =
        typeof range.intersectsNode === 'function'
          ? (() => {
              try {
                return range.intersectsNode(container)
              } catch {
                return false
              }
            })()
          : container.contains(range.commonAncestorContainer)
      if (!inside) return null
      // jsdom's Range has no layout, hence no rect — fall back to the origin
      // there; in a browser the range box is always available.
      const rect =
        typeof range.getBoundingClientRect === 'function'
          ? range.getBoundingClientRect()
          : { top: 0, left: 0, width: 0, height: 0 }
      const containerRect = container.getBoundingClientRect()
      return {
        text,
        top: rect.top - containerRect.top,
        left: rect.left - containerRect.left,
        width: rect.width,
        height: rect.height,
      }
    }

    const update = () => setCaptured(read())
    const onMouseDown = () => {
      pointerDownRef.current = true
    }
    const onMouseUp = () => {
      if (!pointerDownRef.current) return
      pointerDownRef.current = false
      update()
    }
    const onSelectionChange = () => {
      if (pointerDownRef.current) return
      update()
    }

    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('selectionchange', onSelectionChange)
    }
  }, [containerRef])

  return captured
}

/**
 * The popover itself: the quoted passage (so the reader sees what will be
 * handed over) and the host's action rows. `mousedown` on the panel is
 * preventDefaulted — without it the press would collapse the document
 * selection, the selectionchange handler would close the surface, and the
 * click would never land on the row.
 */
function SelectionActionsPanel({
  captured,
  actions,
  onAction,
  onDismiss,
}: {
  captured: CapturedSelection
  actions: readonly ChatSelectionAction[]
  onAction: (text: string, action: ChatSelectionAction) => void
  onDismiss: () => void
}) {
  const { triggerRef, panelRef } = usePopover(true, (open: boolean) => {
    if (!open) onDismiss()
  })
  const firstActionRef = useRef<HTMLButtonElement>(null)

  // Keyboard reachability: the surface takes focus when it opens (pointer
  // users lose nothing — the selection highlight survives a programmatic
  // focus), so a keyboard selection flows straight into the actions and Tab
  // walks them. Escape returns focus to the anchor via `usePopover`.
  useEffect(() => {
    firstActionRef.current?.focus()
  }, [])

  const choose = (action: ChatSelectionAction) => {
    onAction(captured.text, action)
    // The passage has been handed off; leaving it selected reads as still
    // waiting on the reader.
    window.getSelection()?.removeAllRanges()
    onDismiss()
  }

  const quote =
    captured.text.length > 80 ? `${captured.text.slice(0, 79)}…` : captured.text

  return (
    <>
      {/* The virtual trigger: a zero-visible span over the selection's box
          that `PopoverSurface` anchors to. It is in the transcript's flow, so
          host scrolling moves it with the selected text; `pointer-events:
          none` keeps it from ever intercepting the next selection. */}
      <span
        ref={triggerRef}
        tabIndex={-1}
        data-testid="selection-anchor"
        style={{
          position: 'absolute',
          top: captured.top,
          left: captured.left,
          width: captured.width,
          height: captured.height,
          pointerEvents: 'none',
        }}
      />
      <PopoverSurface
        open
        triggerRef={triggerRef}
        panelRef={panelRef}
        role="group"
        className={`select-none overflow-hidden rounded-xl border border-card-edge bg-popover ${OVERLAY_SHADOW}`}
      >
        <div
          data-testid="selection-actions"
          aria-label="Selection actions"
          onMouseDown={(e) => e.preventDefault()}
        >
          <p className="max-w-64 truncate border-b border-border px-3 py-2 text-xs italic text-muted-foreground">
            “{quote}”
          </p>
          <div className="p-1">
            {actions.map((action, i) => (
              <button
                key={action.id}
                ref={i === 0 ? firstActionRef : undefined}
                type="button"
                onClick={() => choose(action)}
                className={`flex min-h-[36px] w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition hover:bg-accent ${POPOVER_OPTION_FOCUS}`}
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>
      </PopoverSurface>
    </>
  )
}

/**
 * Wraps the transcript when selection actions are enabled: establishes the
 * relative positioning scope + the selection tracking, and renders the panel
 * for the current capture. ChatMessages mounts this only when the host wired
 * both seams — without it the transcript subtree is byte-identical to before.
 */
export function SelectionActionsScope({
  actions,
  onAction,
  children,
}: {
  actions: readonly ChatSelectionAction[]
  onAction: (text: string, action: ChatSelectionAction) => void
  children: ReactNode
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const captured = useTranscriptSelection(containerRef)
  const [dismissed, setDismissed] = useState<CapturedSelection | null>(null)

  // A dismissal (Escape / outside press) holds until the selection CHANGES —
  // re-showing on a stray selection event for the same range would make
  // Escape feel broken. A collapsed selection resets the dismissal, so
  // re-selecting the same passage in a fresh gesture re-opens the surface.
  useEffect(() => {
    if (captured === null) setDismissed(null)
  }, [captured])
  const visible = captured && !(dismissed && sameSelection(captured, dismissed))

  return (
    <div ref={containerRef} className="relative">
      {children}
      {visible && captured && (
        <SelectionActionsPanel
          captured={captured}
          actions={actions}
          onAction={onAction}
          onDismiss={() => setDismissed(captured)}
        />
      )}
    </div>
  )
}
