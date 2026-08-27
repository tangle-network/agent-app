/**
 * Horizontal (top) and vertical (left) canvas rulers. Each ruler:
 * - Draws zoom-scaled tick marks via `buildRulerTicks` / `selectTickStep`.
 * - Shows a pointer-position indicator (a hairline that follows the cursor).
 * - Supports guide creation by dragging OUT of the ruler: a live preview line
 *   appears while dragging; on drop a `set_page_guides` command is emitted.
 * - Existing guides that are dragged BACK into the ruler are deleted.
 *
 * All interaction math lives in ruler-math.ts and is testable without a DOM.
 * The rulers themselves are pure DOM (no Konva); they sit in a CSS grid slot
 * next to the workspace canvas.
 */

import { useCallback, useRef, useState } from 'react'
import type { PageGuides } from '../../design-canvas/model'
import { buildRulerTicks, screenToDocumentPosition, selectTickStep } from './ruler-math'

const RULER_SIZE_PX = 20

export interface RulersProps {
  /** Page width in document px. */
  pageWidth: number
  /** Page height in document px. */
  pageHeight: number
  zoom: number
  /** How many doc-px of the canvas are scrolled off-screen left/top. */
  scrollLeft: number
  scrollTop: number
  showRulers: boolean
  guides: PageGuides
  /** Emitted when the user drops a guide or deletes one back into the ruler. */
  onGuidesChange(guides: PageGuides): void
}

/** Minimum px from ruler edge before a guide drag counts as "delete". */
const DELETE_THRESHOLD_PX = RULER_SIZE_PX + 4

export function Rulers({ pageWidth, pageHeight, zoom, scrollLeft, scrollTop, showRulers, guides, onGuidesChange }: RulersProps) {
  if (!showRulers) return null

  return (
    <>
      {/* Corner filler */}
      <div
        className="absolute top-0 left-0 z-20 shrink-0 border-b border-r border-[var(--border-default)] bg-[var(--bg-input)]"
        style={{ width: RULER_SIZE_PX, height: RULER_SIZE_PX }}
      />

      <HorizontalRuler
        pageWidth={pageWidth}
        zoom={zoom}
        scrollLeft={scrollLeft}
        guides={guides}
        onGuidesChange={onGuidesChange}
      />

      <VerticalRuler
        pageHeight={pageHeight}
        zoom={zoom}
        scrollTop={scrollTop}
        guides={guides}
        onGuidesChange={onGuidesChange}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Horizontal ruler
// ---------------------------------------------------------------------------

interface HorizontalRulerProps {
  pageWidth: number
  zoom: number
  scrollLeft: number
  guides: PageGuides
  onGuidesChange(guides: PageGuides): void
}

function HorizontalRuler({ pageWidth, zoom, scrollLeft, guides, onGuidesChange }: HorizontalRulerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pointerX, setPointerX] = useState<number | null>(null)
  const [dragGuideX, setDragGuideX] = useState<number | null>(null)
  const dragGuideIndexRef = useRef<number | null>(null)

  const step = selectTickStep({ zoom, minMajorSpacingPx: 40 })
  const ticks = buildRulerTicks({ documentLength: pageWidth, step })

  function screenXToDoc(clientX: number): number {
    if (!ref.current) return 0
    const rect = ref.current.getBoundingClientRect()
    return screenToDocumentPosition({ pointerScreenPx: clientX - rect.left, scrollOffset: scrollLeft, zoom })
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const docX = screenXToDoc(event.clientX)
    // Check if pointer is near an existing guide (within 4 screen px).
    const threshold = 4 / zoom
    const nearIdx = guides.vertical.findIndex((g) => Math.abs(g - docX) <= threshold)
    if (nearIdx >= 0) {
      dragGuideIndexRef.current = nearIdx
    } else {
      dragGuideIndexRef.current = null
    }
    setDragGuideX(docX)
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    const localY = event.clientY - rect.top
    setPointerX(event.clientX - rect.left)
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const docX = screenXToDoc(event.clientX)
    // If pointer moves BELOW the ruler, treat as "dragging to canvas" — show guide.
    if (localY > DELETE_THRESHOLD_PX) {
      setDragGuideX(docX)
    } else {
      // Dragged back into ruler — signal delete on release.
      setDragGuideX(null)
    }
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    event.currentTarget.releasePointerCapture(event.pointerId)

    const rect = ref.current?.getBoundingClientRect()
    const localY = rect ? event.clientY - rect.top : 0
    const deletingExisting = dragGuideIndexRef.current !== null
    const docX = screenXToDoc(event.clientX)

    const vertical = [...guides.vertical]

    if (localY <= DELETE_THRESHOLD_PX && deletingExisting) {
      // Dragged existing guide back into ruler — delete it.
      vertical.splice(dragGuideIndexRef.current!, 1)
    } else if (localY > DELETE_THRESHOLD_PX) {
      if (deletingExisting) {
        // Moved existing guide to new position.
        vertical[dragGuideIndexRef.current!] = docX
      } else {
        // New guide.
        vertical.push(docX)
      }
    }

    dragGuideIndexRef.current = null
    setDragGuideX(null)
    onGuidesChange({ ...guides, vertical })
  }

  function handlePointerLeave() {
    setPointerX(null)
  }

  return (
    <div
      ref={ref}
      className="absolute top-0 left-0 right-0 z-10 cursor-ew-resize select-none overflow-hidden border-b border-[var(--border-default)] bg-[var(--bg-input)]"
      style={{ height: RULER_SIZE_PX, marginLeft: RULER_SIZE_PX }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
    >
      {ticks.map((tick) => {
        const screenX = tick.position * zoom - scrollLeft * zoom
        return (
          <div
            key={tick.position}
            className={`absolute bottom-0 w-px bg-[var(--border-default)] ${tick.label !== null ? 'top-1.5' : 'top-[14px]'}`}
            style={{ left: screenX }}
          >
            {tick.label !== null ? (
              <span className="absolute -top-1 left-0.5 whitespace-nowrap font-mono text-[9px] leading-none text-[var(--text-muted)]">
                {tick.label}
              </span>
            ) : null}
          </div>
        )
      })}

      {/* Pointer indicator */}
      {pointerX !== null ? (
        <div className="pointer-events-none absolute top-0 bottom-0 w-px bg-[var(--brand-primary)]/60" style={{ left: pointerX }} />
      ) : null}

      {/* Live drag-guide preview */}
      {dragGuideX !== null ? (
        <div
          className="pointer-events-none absolute top-0 bottom-0 w-px bg-[var(--brand-primary)]"
          style={{ left: dragGuideX * zoom - scrollLeft * zoom }}
        />
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Vertical ruler
// ---------------------------------------------------------------------------

interface VerticalRulerProps {
  pageHeight: number
  zoom: number
  scrollTop: number
  guides: PageGuides
  onGuidesChange(guides: PageGuides): void
}

function VerticalRuler({ pageHeight, zoom, scrollTop, guides, onGuidesChange }: VerticalRulerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pointerY, setPointerY] = useState<number | null>(null)
  const [dragGuideY, setDragGuideY] = useState<number | null>(null)
  const dragGuideIndexRef = useRef<number | null>(null)

  const step = selectTickStep({ zoom, minMajorSpacingPx: 40 })
  const ticks = buildRulerTicks({ documentLength: pageHeight, step })

  function screenYToDoc(clientY: number): number {
    if (!ref.current) return 0
    const rect = ref.current.getBoundingClientRect()
    return screenToDocumentPosition({ pointerScreenPx: clientY - rect.top, scrollOffset: scrollTop, zoom })
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const docY = screenYToDoc(event.clientY)
    const threshold = 4 / zoom
    const nearIdx = guides.horizontal.findIndex((g) => Math.abs(g - docY) <= threshold)
    dragGuideIndexRef.current = nearIdx >= 0 ? nearIdx : null
    setDragGuideY(docY)
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    const localX = event.clientX - rect.left
    setPointerY(event.clientY - rect.top)
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const docY = screenYToDoc(event.clientY)
    if (localX > DELETE_THRESHOLD_PX) {
      setDragGuideY(docY)
    } else {
      setDragGuideY(null)
    }
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    event.currentTarget.releasePointerCapture(event.pointerId)

    const rect = ref.current?.getBoundingClientRect()
    const localX = rect ? event.clientX - rect.left : 0
    const deletingExisting = dragGuideIndexRef.current !== null
    const docY = screenYToDoc(event.clientY)

    const horizontal = [...guides.horizontal]

    if (localX <= DELETE_THRESHOLD_PX && deletingExisting) {
      horizontal.splice(dragGuideIndexRef.current!, 1)
    } else if (localX > DELETE_THRESHOLD_PX) {
      if (deletingExisting) {
        horizontal[dragGuideIndexRef.current!] = docY
      } else {
        horizontal.push(docY)
      }
    }

    dragGuideIndexRef.current = null
    setDragGuideY(null)
    onGuidesChange({ ...guides, horizontal })
  }

  function handlePointerLeave() {
    setPointerY(null)
  }

  return (
    <div
      ref={ref}
      className="absolute top-0 left-0 bottom-0 z-10 cursor-ns-resize select-none overflow-hidden border-r border-[var(--border-default)] bg-[var(--bg-input)]"
      style={{ width: RULER_SIZE_PX, marginTop: RULER_SIZE_PX }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
    >
      {ticks.map((tick) => {
        const screenY = tick.position * zoom - scrollTop * zoom
        return (
          <div
            key={tick.position}
            className={`absolute right-0 h-px bg-[var(--border-default)] ${tick.label !== null ? 'left-1.5' : 'left-[14px]'}`}
            style={{ top: screenY }}
          >
            {tick.label !== null ? (
              <span
                className="absolute top-0.5 left-0 whitespace-nowrap font-mono text-[9px] leading-none text-[var(--text-muted)]"
                style={{ transform: 'rotate(-90deg)', transformOrigin: '0 0', marginTop: 4 }}
              >
                {tick.label}
              </span>
            ) : null}
          </div>
        )
      })}

      {pointerY !== null ? (
        <div className="pointer-events-none absolute left-0 right-0 h-px bg-[var(--brand-primary)]/60" style={{ top: pointerY }} />
      ) : null}

      {dragGuideY !== null ? (
        <div
          className="pointer-events-none absolute left-0 right-0 h-px bg-[var(--brand-primary)]"
          style={{ top: dragGuideY * zoom - scrollTop * zoom }}
        />
      ) : null}
    </div>
  )
}
