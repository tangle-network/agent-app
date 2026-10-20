/** Portaled popover placement, nested focus, and outside-click ownership. */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/**
 * Keyboard + pointer model for a trigger-and-popover pair, dependency-free.
 * Outside-mousedown and Escape both close; Escape also returns focus to the
 * trigger so keyboard users aren't dropped at the top of the document. The
 * returned `triggerProps` carry the ARIA contract (`aria-haspopup`/
 * `aria-expanded`); spread them onto the trigger button.
 *
 * `panelRef` belongs to the popover panel and MUST be wired when the panel is
 * rendered through {@link PopoverSurface}: a portaled panel is not inside
 * `containerRef`, so a container-only outside test reads every click on the
 * menu's own rows as an outside click and closes before the row's handler runs.
 */
export function usePopover(open: boolean, setOpen: (open: boolean) => void) {
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node
      if (containerRef.current?.contains(target)) return
      const panel = panelRef.current
      if (panel?.contains(target)) return
      // A popover opened FROM this one portals as a SIBLING at body level, so
      // `contains` cannot see it and a click on its rows would read as outside.
      // Surfaces stamp their ancestor chain, so descendancy survives the portal.
      const ownPath = panel?.getAttribute(POPOVER_SURFACE_ATTR)
      const hitPath =
        target instanceof Element
          ? target.closest(`[${POPOVER_SURFACE_ATTR}]`)?.getAttribute(POPOVER_SURFACE_ATTR)
          : null
      if (ownPath && hitPath && (hitPath === ownPath || hitPath.startsWith(`${ownPath}${POPOVER_PATH_SEPARATOR}`))) return
      setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        const ownPath = panelRef.current?.getAttribute(POPOVER_SURFACE_ATTR)
        const focusedPath = document.activeElement?.closest(`[${POPOVER_SURFACE_ATTR}]`)?.getAttribute(POPOVER_SURFACE_ATTR)
        if (ownPath && focusedPath?.startsWith(`${ownPath}${POPOVER_PATH_SEPARATOR}`)) return
        e.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, setOpen])

  return {
    containerRef,
    triggerRef,
    panelRef,
    triggerProps: {
      ref: triggerRef,
      'aria-haspopup': true as const,
      'aria-expanded': open,
    },
  }
}

// ── PopoverSurface ────────────────────────────────────────────────────────

/** Distance between the trigger and the panel it opens. */
const POPOVER_GAP = 8
/** Minimum distance the panel keeps from every viewport edge. */
const POPOVER_VIEWPORT_MARGIN = 16
/** Floor for the computed max-height, so a cramped side still shows rows
 *  rather than collapsing to a sliver the user cannot read. */
const POPOVER_MIN_HEIGHT = 120

/**
 * Marks the portaled panel in the DOM. Products and audits (see
 * `playground/scripts/popover-hit-test.mjs`) select on this rather than on a
 * Tailwind class, which is presentation and free to change.
 *
 * Its VALUE is the surface's ancestor path (`outer/inner`), which is what
 * restores "is this click inside my popover" after the portal flattens two
 * nested panels into two siblings of `<body>`.
 */
export const POPOVER_SURFACE_ATTR = 'data-agent-app-popover'
const POPOVER_PATH_SEPARATOR = '/'

/**
 * `PopoverSurface` is now mounted (closed) inside every server-rendered
 * composer, so its hooks run on the server once per composer per request.
 * React 18 logs "useLayoutEffect does nothing on the server" for that; React 19
 * does not (measured silent on react-dom 19.2.8). The peer floor is `react >=18`,
 * so bind the synchronous hook only where there is a DOM and the effect hook
 * elsewhere — placement never runs on the server either way.
 */
export const useBrowserLayoutEffect = typeof document !== 'undefined' ? useLayoutEffect : useEffect

export interface PopoverSurfaceProps {
  open: boolean
  /** The trigger the panel anchors to — `usePopover`'s `triggerRef`. */
  triggerRef: RefObject<HTMLElement | null>
  /** `usePopover`'s `panelRef`; also what the outside-click test consults. */
  panelRef: RefObject<HTMLDivElement | null>
  /** Presentation classes. Placement and elevation are owned here — a caller
   *  must not pass `absolute`/`fixed`/`top-*`/`bottom-*`/`z-*`. */
  className?: string
  role?: string
  id?: string
  'aria-label'?: string
  /** Make the panel at least as wide as its trigger. A portaled panel has no
   *  `w-full` to inherit — the trigger is no longer its offset parent — so a
   *  menu that used to stretch to a full-width trigger declares it here. */
  matchTriggerWidth?: boolean
  /** Preferred side. `above` suits controls docked at the bottom of a composer;
   *  `below` suits headers, rows, and rails. Either flips when the other side has more room. */
  side?: 'above' | 'below'
  /** Which trigger edge the panel lines up with. `end` keeps a row's trailing menu over the row. */
  align?: 'start' | 'end'
  /** Opt in to remeasurement when asynchronous or filtered content changes. */
  contentKey?: unknown
  children: ReactNode
}

/**
 * The floating panel every canonical picker opens.
 *
 * It renders through a PORTAL to `document.body` and anchors itself to the
 * trigger in viewport coordinates, because an in-place `absolute` panel's
 * visibility is decided by markup this package does not own. Measured in
 * production: the shipped chat composer docks these controls inside a
 * horizontally scrolling rail (`overflow-x-auto`), and a scroll container
 * clips every positioned descendant whose containing block sits inside it —
 * so a correct 420x457 menu with correct coordinates painted zero pixels and
 * could not be clicked. An ancestor `transform`/`filter`/`contain` would trap
 * it the same way through the stacking context instead of the clip. Leaving
 * the DOM subtree is the only placement a host cannot re-break.
 *
 * Placement prefers ABOVE the trigger (these controls dock at the bottom of a
 * composer), flips below when there is more room there, clamps horizontally
 * into the viewport, and caps its own height to the space on the chosen side.
 * The panel is `visibility: hidden` for the measure pass so it never paints at
 * the pre-placement origin.
 */
export function PopoverSurface({
  open,
  triggerRef,
  panelRef,
  className,
  role,
  id,
  'aria-label': ariaLabel,
  matchTriggerWidth,
  side = 'above',
  align = 'start',
  contentKey,
  children,
}: PopoverSurfaceProps) {
  const surfaceId = useId()
  const [style, setStyle] = useState<CSSProperties>(() => ({
    position: 'fixed',
    top: 0,
    left: 0,
    visibility: 'hidden',
  }))

  const place = useCallback(() => {
    const trigger = triggerRef.current
    const panel = panelRef.current
    if (!trigger || !panel) return
    const anchor = trigger.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    // `scrollHeight` is the panel's CONTENT height, so it does not feed back
    // on the `maxHeight` this function just applied — reading `offsetHeight`
    // here would measure the previous pass's clamp and ratchet the panel
    // smaller on every scroll event.
    const contentHeight = panel.scrollHeight
    const panelWidth = panel.offsetWidth

    const roomAbove = anchor.top - POPOVER_GAP - POPOVER_VIEWPORT_MARGIN
    const roomBelow = viewportHeight - anchor.bottom - POPOVER_GAP - POPOVER_VIEWPORT_MARGIN
    const above = side === 'above'
      ? contentHeight <= roomAbove || roomAbove >= roomBelow
      : !(contentHeight <= roomBelow || roomBelow >= roomAbove)
    const maxHeight = Math.max(POPOVER_MIN_HEIGHT, above ? roomAbove : roomBelow)
    const height = Math.min(contentHeight, maxHeight)

    const top = above ? Math.max(POPOVER_VIEWPORT_MARGIN, anchor.top - POPOVER_GAP - height) : anchor.bottom + POPOVER_GAP
    const rightBound = Math.max(POPOVER_VIEWPORT_MARGIN, viewportWidth - panelWidth - POPOVER_VIEWPORT_MARGIN)
    const preferredLeft = align === 'end' ? anchor.right - panelWidth : anchor.left
    const left = Math.min(Math.max(POPOVER_VIEWPORT_MARGIN, preferredLeft), rightBound)

    setStyle({
      position: 'fixed',
      top,
      left,
      maxHeight,
      visibility: 'visible',
      ...(matchTriggerWidth ? { minWidth: anchor.width } : {}),
    })
  }, [align, matchTriggerWidth, panelRef, side, triggerRef])

  // Layout effect: placement is resolved before the browser paints, so the
  // panel is never seen at the origin it mounts at.
  useBrowserLayoutEffect(() => {
    if (!open) {
      setStyle({ position: 'fixed', top: 0, left: 0, visibility: 'hidden' })
      return
    }
    place()
  }, [open, place, contentKey])

  useEffect(() => {
    if (!open) return
    const onViewportChange = () => place()
    // `capture` so the rail's OWN scroll re-anchors the panel — a scroll inside
    // an ancestor does not bubble to window.
    window.addEventListener('scroll', onViewportChange, true)
    window.addEventListener('resize', onViewportChange)
    return () => {
      window.removeEventListener('scroll', onViewportChange, true)
      window.removeEventListener('resize', onViewportChange)
    }
  }, [open, place])

  if (!open || typeof document === 'undefined') return null

  const ownerPath = triggerRef.current?.closest?.(`[${POPOVER_SURFACE_ATTR}]`)?.getAttribute(POPOVER_SURFACE_ATTR)
  const path = ownerPath ? `${ownerPath}${POPOVER_PATH_SEPARATOR}${surfaceId}` : surfaceId

  return createPortal(
    <div
      ref={panelRef}
      id={id}
      role={role}
      aria-label={ariaLabel}
      style={style}
      {...{ [POPOVER_SURFACE_ATTR]: path }}
      className={`z-[1000] ${className ?? ''}`}
    >
      {children}
    </div>,
    document.body,
  )
}
