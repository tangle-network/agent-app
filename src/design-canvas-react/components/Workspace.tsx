/**
 * Konva Stage host for the design-canvas editor. Renders the active page
 * (background rect + element nodes), wires all interaction gestures, and
 * delegates persistence through the command stack.
 *
 * COORDINATE SYSTEM:
 * The Konva stage sits at (0,0) in screen space. The content Layer group is
 * translated by (panX, panY) and scaled by (zoom, zoom). Document coordinates
 * map to screen via: screenX = panX + docX * zoom.
 *
 * GESTURES (mutually exclusive; escape cancels any live gesture):
 * - Wheel: zoom-to-cursor via ZoomPanMath.zoomAtPoint; setView only.
 * - Middle-button drag / space+drag: pan; setView only.
 * - Empty-space drag: marquee selection; setView only.
 * - Element drag: move via onDragMove preview + onDragEnd command.
 * - Transformer: resize/rotate; handled by SelectionLayer.
 * - Double-click on text: opens InlineTextEditor.
 *
 * KEYBOARD (active when canvas wrapper div is focused):
 * - delete/backspace → deleteElementCommand for each selected id.
 * - arrows → nudge (shift ×10); ONE command emitted on keyup (coalescing).
 * - mod+z / shift+mod+z → undo / redo.
 * - mod+d → duplicate selection at +10,+10 offset.
 * - mod+g → group selection (≥2 elements).
 * - shift+mod+g → ungroup selected group.
 * - mod+a → select all on current page.
 * - escape → cancel live gesture or clear selection.
 *
 * POINTER CAPTURE: marquee and pan gestures call setPointerCapture on the
 * wrapper div so drag events don't escape on fast pointer moves.
 *
 * DEVICEPIXELRATIO: Konva's pixelRatio prop multiplies the backing canvas
 * resolution for crisp rendering at any DPR.
 *
 * Architecture: WorkspaceInner receives a guaranteed non-null activePage,
 * keeping all hooks at the top level and avoiding conditional-hook violations.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Stage, Layer, Rect, Group } from 'react-konva'
import type Konva from 'konva'

import type { DesignCanvasProps } from '../contracts'
import { createSceneCommandStack } from '../engine/command-stack'
import { createSnapEngine, collectGridTargets } from '../engine/snap'
import { createZoomPanMath } from '../engine/zoom-pan'
import { marqueeSelect } from '../engine/selection'
import {
  addElementCommand,
  setAttrsCommand,
  multiSetAttrsCommand,
  deleteElementCommand,
  groupElementsCommand,
  ungroupElementCommand,
} from '../engine/commands'
import type { MultiSetAttrsEntry } from '../engine/commands'

import { ElementNode } from './ElementNode'
import { SelectionLayer } from './SelectionLayer'
import { GridLayer } from './GridLayer'
import { SnapGuidesOverlay } from './SnapGuidesOverlay'
import { InlineTextEditor } from './InlineTextEditor'
import { BleedTrimOverlay } from './BleedTrimOverlay'

import { normalizeMarquee, nudgeDelta as nudgeDeltaMath } from './transform-math'
import { elementAabb, findElement } from '../../design-canvas/model'
import type { SceneElement, ScenePage, TextElement } from '../../design-canvas/model'
import type { SnapResult, SnapTarget, SceneCommand } from '../contracts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SNAP_THRESHOLD_SCREEN_PX = 8
const DUPLICATE_OFFSET = 10
const ZOOM_FACTOR_WHEEL = 0.998
const ZOOM_MIN = 0.05
const ZOOM_MAX = 32

// ---------------------------------------------------------------------------
// Gesture / marquee types
// ---------------------------------------------------------------------------

interface MarqueeState {
  active: boolean
  startDocX: number
  startDocY: number
  endDocX: number
  endDocY: number
}

const NO_MARQUEE: MarqueeState = { active: false, startDocX: 0, startDocY: 0, endDocX: 0, endDocY: 0 }

type GestureMode = 'idle' | 'pan' | 'marquee' | 'drag'

// ---------------------------------------------------------------------------
// Workspace — shell that guards page presence and delegates to WorkspaceInner
// ---------------------------------------------------------------------------

export function Workspace(props: DesignCanvasProps) {
  // Command stack is owned here so it outlives WorkspaceInner re-mounts.
  const stackRef = useRef(
    createSceneCommandStack(
      props.document,
      props.document.pages[0]?.id ?? '',
    ),
  )

  const [, setTick] = useState(0)
  const forceRender = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    return stackRef.current.subscribe(forceRender)
  }, [forceRender])

  // Rebase on server refresh (host changes rev + document together).
  const prevRevRef = useRef(props.rev)
  useEffect(() => {
    if (props.rev !== prevRevRef.current) {
      prevRevRef.current = props.rev
      stackRef.current.reset(props.document)
    }
  }, [props.rev, props.document])

  const state = stackRef.current.getState()
  const activePage =
    state.document.pages.find((p) => p.id === state.activePageId) ??
    state.document.pages[0]

  // No pages — document is empty shell, nothing to render.
  if (!activePage) return null

  return (
    <WorkspaceInner
      {...props}
      stack={stackRef.current}
      activePage={activePage}
    />
  )
}

// ---------------------------------------------------------------------------
// WorkspaceInner — receives a guaranteed activePage
// ---------------------------------------------------------------------------

interface WorkspaceInnerProps extends DesignCanvasProps {
  stack: ReturnType<typeof createSceneCommandStack>
  activePage: ScenePage
}

function WorkspaceInner({
  canWrite,
  onApplyOperations,
  onSelectionChange,
  renderAgentPanel,
  renderSidePanel,
  className,
  stack,
  activePage,
}: WorkspaceInnerProps) {
  // Re-render when command stack changes state.
  const [, setTick] = useState(0)
  const forceRender = useCallback(() => setTick((t) => t + 1), [])
  useEffect(() => stack.subscribe(forceRender), [stack, forceRender])

  const state = stack.getState()
  const { document, activePageId, selectedElementIds, zoom, panX, panY, gridEnabled, gridSize, snapEnabled, showBleed } = state

  // -------------------------------------------------------------------------
  // Stable engines
  // -------------------------------------------------------------------------

  const zoomPanMath = useMemo(() => createZoomPanMath({ minZoom: ZOOM_MIN, maxZoom: ZOOM_MAX }), [])
  const snapEngine = useMemo(() => createSnapEngine(), [])

  // -------------------------------------------------------------------------
  // Container sizing
  // -------------------------------------------------------------------------

  const containerRef = useRef<HTMLDivElement>(null)
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 })

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      setContainerSize({ width, height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const stageRef = useRef<Konva.Stage | null>(null)

  // -------------------------------------------------------------------------
  // Gesture refs
  // -------------------------------------------------------------------------

  const gestureRef = useRef<GestureMode>('idle')
  const panOriginRef = useRef({ screenX: 0, screenY: 0, panX: 0, panY: 0 })
  const [marquee, setMarquee] = useState<MarqueeState>(NO_MARQUEE)
  const marqueeRef = useRef<MarqueeState>(NO_MARQUEE)
  const spaceHeldRef = useRef(false)
  // Stores origin position AND AABB dimensions captured at drag start so
  // snap reference points (center, far edge) are correct for any element size.
  const dragOriginRef = useRef<Map<string, { x: number; y: number; width: number; height: number }>>(new Map())
  const [activeSnap, setActiveSnap] = useState<SnapResult | null>(null)
  const [editingElementId, setEditingElementId] = useState<string | null>(null)
  const editingPreRef = useRef<string>('')
  const nudgeHeldRef = useRef<{
    key: string
    ids: string[]
    origin: Map<string, { x: number; y: number }>
  } | null>(null)

  // -------------------------------------------------------------------------
  // Persist helper — optimistic execute then remote apply, rollback on throw
  // -------------------------------------------------------------------------

  async function persist(command: SceneCommand): Promise<void> {
    if (!canWrite) return
    stack.execute(command)
    try {
      const result = await onApplyOperations(command.operations())
      if (result.document) stack.reset(result.document)
    } catch {
      // Roll back: execute the inverse transform as a new command so undo
      // history stays coherent rather than silently patching state.
      stack.execute({
        label: 'rollback',
        execute: (s) => command.undo(s),
        undo: (s) => command.execute(s),
        operations: () => command.inverseOperations(),
        inverseOperations: () => command.operations(),
      })
    }
  }

  // -------------------------------------------------------------------------
  // Wheel zoom-to-cursor
  // -------------------------------------------------------------------------

  function handleWheel(e: React.WheelEvent<HTMLDivElement>) {
    e.preventDefault()
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const screenX = e.clientX - rect.left
    const screenY = e.clientY - rect.top
    const factor = Math.pow(ZOOM_FACTOR_WHEEL, e.deltaY)
    const next = zoomPanMath.zoomAtPoint({ zoom, panX, panY }, factor, screenX, screenY)
    stack.setView(next)
  }

  // -------------------------------------------------------------------------
  // Pointer handlers
  // -------------------------------------------------------------------------

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button === 1 || spaceHeldRef.current) {
      e.preventDefault()
      ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
      gestureRef.current = 'pan'
      panOriginRef.current = { screenX: e.clientX, screenY: e.clientY, panX, panY }
      return
    }
    if (e.button !== 0) return

    const stage = stageRef.current
    const rect = containerRef.current?.getBoundingClientRect()
    if (!stage || !rect) return
    const screenX = e.clientX - rect.left
    const screenY = e.clientY - rect.top
    const hitNode = stage.getIntersection({ x: screenX, y: screenY })

    if (hitNode && !hitNode.name().startsWith('overlay:') && hitNode.name() !== 'page-background') {
      return
    }

    e.preventDefault()
    ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
    gestureRef.current = 'marquee'
    const docPos = zoomPanMath.screenToDocument({ zoom, panX, panY }, screenX, screenY)
    const m: MarqueeState = { active: true, startDocX: docPos.x, startDocY: docPos.y, endDocX: docPos.x, endDocY: docPos.y }
    marqueeRef.current = m
    setMarquee(m)
    stack.setView({ selectedElementIds: [] })
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const mode = gestureRef.current
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return

    if (mode === 'pan') {
      const dx = e.clientX - panOriginRef.current.screenX
      const dy = e.clientY - panOriginRef.current.screenY
      stack.setView({ panX: panOriginRef.current.panX + dx, panY: panOriginRef.current.panY + dy })
      return
    }

    if (mode === 'marquee') {
      const screenX = e.clientX - rect.left
      const screenY = e.clientY - rect.top
      const docPos = zoomPanMath.screenToDocument({ zoom, panX, panY }, screenX, screenY)
      const m: MarqueeState = { ...marqueeRef.current, active: true, endDocX: docPos.x, endDocY: docPos.y }
      marqueeRef.current = m
      setMarquee(m)
      const normalized = normalizeMarquee(m.startDocX, m.startDocY, m.endDocX, m.endDocY)
      const ids = marqueeSelect(activePage, normalized)
      stack.setView({ selectedElementIds: ids })
    }
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    gestureRef.current = 'idle'
    setMarquee(NO_MARQUEE)
    marqueeRef.current = NO_MARQUEE
    setActiveSnap(null)
    ;(e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId)
  }

  // -------------------------------------------------------------------------
  // Element drag callbacks
  // -------------------------------------------------------------------------

  function handleElementDragStart(elementId: string) {
    if (!canWrite) return
    const ids = selectedElementIds.includes(elementId) ? selectedElementIds : [elementId]
    const origins = new Map<string, { x: number; y: number; width: number; height: number }>()
    for (const id of ids) {
      const found = findElement(activePage, id)
      if (found) {
        const aabb = elementAabb(found.element)
        origins.set(id, { x: found.element.x, y: found.element.y, width: aabb.width, height: aabb.height })
      }
    }
    dragOriginRef.current = origins
    gestureRef.current = 'drag'
    if (!selectedElementIds.includes(elementId)) {
      stack.setView({ selectedElementIds: [elementId] })
    }
  }

  function handleElementDragMove(elementId: string, dx: number, dy: number) {
    if (!canWrite) return
    const origin = dragOriginRef.current.get(elementId)
    if (!origin) return
    const dragging = selectedElementIds.includes(elementId) ? selectedElementIds : [elementId]
    const proposedX = origin.x + dx
    const proposedY = origin.y + dy
    // Use the actual element AABB dimensions so center and far-edge snap points
    // are correct for elements of any size (not the former hardcoded 100×100).
    const snapBounds = { x: proposedX, y: proposedY, width: origin.width, height: origin.height }

    if (snapEnabled) {
      const targets = snapEngine.collectTargets(state, dragging)
      if (gridEnabled) {
        const thresholdDoc = SNAP_THRESHOLD_SCREEN_PX / zoom
        const gt = collectGridTargets(snapBounds, gridSize, activePage, thresholdDoc)
        targets.vertical.push(...gt.vertical)
        targets.horizontal.push(...gt.horizontal)
      }
      const snapResult = snapEngine.apply(snapBounds, targets, SNAP_THRESHOLD_SCREEN_PX, zoom)
      setActiveSnap(snapResult)
    }
  }

  async function handleElementDragEnd(elementId: string, finalX: number, finalY: number) {
    if (!canWrite) return
    gestureRef.current = 'idle'
    setActiveSnap(null)

    const origin = dragOriginRef.current.get(elementId)
    if (!origin) return

    const dx = finalX - origin.x
    const dy = finalY - origin.y
    const draggingIds = selectedElementIds.includes(elementId) ? selectedElementIds : [elementId]

    if (draggingIds.length === 1) {
      const el = findElement(activePage, elementId)?.element
      if (!el) return
      await persist(
        setAttrsCommand({
          pageId: activePageId,
          elementId,
          attrs: { x: finalX, y: finalY },
          priorAttrs: { x: el.x, y: el.y },
        }),
      )
    } else {
      const entries: MultiSetAttrsEntry[] = []
      for (const id of draggingIds) {
        const el = findElement(activePage, id)?.element
        const orig = dragOriginRef.current.get(id)
        if (!el || !orig) continue
        entries.push({
          pageId: activePageId,
          elementId: id,
          attrs: { x: orig.x + dx, y: orig.y + dy },
          priorAttrs: { x: orig.x, y: orig.y },
        })
      }
      if (entries.length > 0) await persist(multiSetAttrsCommand(entries))
    }

    dragOriginRef.current = new Map()
  }

  // -------------------------------------------------------------------------
  // Element interactions
  // -------------------------------------------------------------------------

  function handleElementClick(elementId: string) {
    stack.setView({ selectedElementIds: [elementId] })
  }

  function handleElementDoubleClick(elementId: string) {
    if (!canWrite) return
    const found = findElement(activePage, elementId)
    if (!found || found.element.kind !== 'text') return
    editingPreRef.current = (found.element as TextElement).text
    setEditingElementId(elementId)
  }

  async function handleTextCommit(text: string) {
    const id = editingElementId
    setEditingElementId(null)
    if (!id || !canWrite) return
    const found = findElement(activePage, id)
    if (!found || found.element.kind !== 'text') return
    if (text === editingPreRef.current) return
    await persist(
      setAttrsCommand({
        pageId: activePageId,
        elementId: id,
        attrs: { text },
        priorAttrs: { text: editingPreRef.current },
      }),
    )
  }

  function handleTextCancel() {
    setEditingElementId(null)
  }

  // -------------------------------------------------------------------------
  // Transformer end
  // -------------------------------------------------------------------------

  async function handleTransformEnd(entries: MultiSetAttrsEntry[]) {
    if (!canWrite || entries.length === 0) return
    await persist(multiSetAttrsCommand(entries))
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === ' ') {
      e.preventDefault()
      spaceHeldRef.current = true
      return
    }

    const mod = e.metaKey || e.ctrlKey

    if (e.key === 'Escape') {
      e.preventDefault()
      if (gestureRef.current !== 'idle') {
        gestureRef.current = 'idle'
        setMarquee(NO_MARQUEE)
        setActiveSnap(null)
      } else if (editingElementId) {
        setEditingElementId(null)
      } else {
        stack.setView({ selectedElementIds: [] })
      }
      return
    }

    if (editingElementId) return

    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedElementIds.length > 0) {
      e.preventDefault()
      for (const id of [...selectedElementIds]) {
        try {
          persist(deleteElementCommand({ document, pageId: activePageId, elementId: id }))
        } catch { /* element gone — skip */ }
      }
      stack.setView({ selectedElementIds: [] })
      return
    }

    if (mod && e.key === 'z' && !e.shiftKey) {
      e.preventDefault()
      if (stack.canUndo()) stack.undo()
      return
    }
    if (mod && ((e.key === 'z' && e.shiftKey) || e.key === 'y')) {
      e.preventDefault()
      if (stack.canRedo()) stack.redo()
      return
    }

    if (mod && e.key === 'a') {
      e.preventDefault()
      const ids = activePage.elements.filter((el) => !el.locked && el.visible).map((el) => el.id)
      stack.setView({ selectedElementIds: ids })
      return
    }

    if (mod && e.key === 'd' && selectedElementIds.length > 0) {
      e.preventDefault()
      for (const id of selectedElementIds) {
        const found = findElement(activePage, id)
        if (!found) continue
        const clone: SceneElement = {
          ...structuredClone(found.element),
          id: crypto.randomUUID(),
          x: found.element.x + DUPLICATE_OFFSET,
          y: found.element.y + DUPLICATE_OFFSET,
        }
        persist(addElementCommand({ pageId: activePageId, element: clone }))
      }
      return
    }

    if (mod && !e.shiftKey && e.key === 'g' && selectedElementIds.length >= 2) {
      e.preventDefault()
      persist(groupElementsCommand({
        document,
        pageId: activePageId,
        elementIds: selectedElementIds,
        groupId: crypto.randomUUID(),
      }))
      return
    }

    if (mod && e.shiftKey && e.key === 'g' && selectedElementIds.length === 1) {
      e.preventDefault()
      const id = selectedElementIds[0]!
      persist(ungroupElementCommand({ document, pageId: activePageId, groupId: id }))
      return
    }

    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && selectedElementIds.length > 0) {
      e.preventDefault()
      const key = e.key as 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'
      if (nudgeHeldRef.current && nudgeHeldRef.current.key !== key) {
        flushNudge()
      }
      if (!nudgeHeldRef.current) {
        const origins = new Map<string, { x: number; y: number }>()
        for (const id of selectedElementIds) {
          const found = findElement(activePage, id)
          if (found) origins.set(id, { x: found.element.x, y: found.element.y })
        }
        nudgeHeldRef.current = { key, ids: selectedElementIds.slice(), origin: origins }
      }
      // Apply nudge optimistically each keydown via the command stack so the
      // user sees live movement; the held ref lets us coalesce all steps into
      // one undo entry on keyup.
      const { dx, dy } = nudgeDeltaMath(key, e.shiftKey)
      const entries: MultiSetAttrsEntry[] = []
      for (const [id, orig] of nudgeHeldRef.current.origin) {
        const found = findElement(activePage, id)
        if (!found) continue
        entries.push({
          pageId: activePageId,
          elementId: id,
          attrs: { x: found.element.x + dx, y: found.element.y + dy },
          priorAttrs: { x: found.element.x, y: found.element.y },
        })
      }
      if (entries.length > 0) {
        // Preview: silent local apply without remote persist (flushed on keyup).
        stack.execute(multiSetAttrsCommand(entries))
      }
    }
  }

  function handleKeyUp(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === ' ') {
      spaceHeldRef.current = false
      return
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      flushNudge()
    }
  }

  function flushNudge() {
    const held = nudgeHeldRef.current
    if (!held) return
    nudgeHeldRef.current = null
    if (!canWrite || held.ids.length === 0) return

    // Build a single coalesced set_attrs from original positions to current.
    const entries: MultiSetAttrsEntry[] = []
    for (const id of held.ids) {
      const orig = held.origin.get(id)
      const found = findElement(activePage, id)
      if (!orig || !found) continue
      entries.push({
        pageId: activePageId,
        elementId: id,
        attrs: { x: found.element.x, y: found.element.y },
        priorAttrs: { x: orig.x, y: orig.y },
      })
    }
    if (entries.length > 0) {
      // Persist the coalesced nudge; the intermediate stack entries from
      // keydown previews become part of the committed ops batch.
      onApplyOperations(multiSetAttrsCommand(entries).operations()).catch(() => {
        // Roll back if remote rejects.
        for (const [id, orig] of held.origin) {
          const found = findElement(activePage, id)
          if (!found) continue
          persist(setAttrsCommand({
            pageId: activePageId,
            elementId: id,
            attrs: { x: orig.x, y: orig.y },
            priorAttrs: { x: found.element.x, y: found.element.y },
          }))
        }
      })
    }
  }

  // -------------------------------------------------------------------------
  // Notify host of selection changes
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!onSelectionChange) return
    const elements = selectedElementIds
      .map((id) => findElement(activePage, id)?.element)
      .filter((el): el is SceneElement => !!el)
    onSelectionChange(elements)
  }, [selectedElementIds, activePage, onSelectionChange])

  // -------------------------------------------------------------------------
  // Derived values for render
  // -------------------------------------------------------------------------

  const selectedElements = useMemo(
    () =>
      selectedElementIds
        .map((id) => findElement(activePage, id)?.element)
        .filter((el): el is SceneElement => !!el),
    [selectedElementIds, activePage],
  )

  const editingTextElement = editingElementId
    ? (findElement(activePage, editingElementId)?.element as TextElement | undefined) ?? null
    : null

  const stageRect = containerRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 }
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1

  const pageScreenX = panX
  const pageScreenY = panY
  const pageScreenW = activePage.width * zoom
  const pageScreenH = activePage.height * zoom

  const activeVerticalGuide: SnapTarget | null = activeSnap?.activeVertical ?? null
  const activeHorizontalGuide: SnapTarget | null = activeSnap?.activeHorizontal ?? null

  const normalizedMarquee = marquee.active
    ? normalizeMarquee(marquee.startDocX, marquee.startDocY, marquee.endDocX, marquee.endDocY)
    : null

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div
      className={`design-canvas-workspace relative overflow-hidden bg-[#1a1a1a] outline-none ${className ?? ''}`}
      ref={containerRef}
      tabIndex={0}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      style={{ cursor: spaceHeldRef.current ? 'grab' : 'default' }}
    >
      {/* Left side panel */}
      {renderSidePanel && (
        <div className="absolute left-0 top-0 bottom-0 z-20 w-60 pointer-events-auto">
          {renderSidePanel()}
        </div>
      )}

      {/* Konva Stage */}
      <Stage
        ref={stageRef}
        width={containerSize.width}
        height={containerSize.height}
        pixelRatio={dpr}
        listening={true}
      >
        {/* Grid beneath content */}
        {gridEnabled && (
          <GridLayer
            pageWidth={activePage.width}
            pageHeight={activePage.height}
            gridSize={gridSize}
            zoom={zoom}
          />
        )}

        {/* Page content */}
        <Layer>
          <Group x={panX} y={panY} scaleX={zoom} scaleY={zoom}>
            <Rect
              name="page-background"
              x={0}
              y={0}
              width={activePage.width}
              height={activePage.height}
              fill={activePage.background}
              shadowColor="rgba(0,0,0,0.4)"
              shadowBlur={24 / zoom}
              shadowOffset={{ x: 0, y: 4 / zoom }}
              listening={false}
            />
            <Group
              clipX={0}
              clipY={0}
              clipWidth={activePage.width}
              clipHeight={activePage.height}
            >
              {activePage.elements.map((element) => (
                <ElementNode
                  key={element.id}
                  element={element}
                  isSelected={selectedElementIds.includes(element.id)}
                  zoom={zoom}
                  onClick={handleElementClick}
                  onDragStart={handleElementDragStart}
                  onDragMove={handleElementDragMove}
                  onDragEnd={handleElementDragEnd}
                  onDoubleClick={handleElementDoubleClick}
                />
              ))}
            </Group>
          </Group>
        </Layer>

        {/* Snap guides — same doc-space coordinate group */}
        {(activeVerticalGuide || activeHorizontalGuide) && (
          <Layer>
            <Group x={panX} y={panY} scaleX={zoom} scaleY={zoom}>
              <SnapGuidesOverlay
                pageWidth={activePage.width}
                pageHeight={activePage.height}
                activeVertical={activeVerticalGuide}
                activeHorizontal={activeHorizontalGuide}
                zoom={zoom}
              />
            </Group>
          </Layer>
        )}

        {/* Transformer / selection handles */}
        <SelectionLayer
          stageRef={stageRef}
          selectedIds={selectedElementIds}
          selectedElements={selectedElements}
          canWrite={canWrite}
          onTransformEnd={handleTransformEnd}
          pageId={activePageId}
        />
      </Stage>

      {/* Bleed overlay */}
      {showBleed && activePage.bleed && (
        <div
          className="pointer-events-none absolute"
          style={{ left: pageScreenX, top: pageScreenY, width: pageScreenW, height: pageScreenH }}
        >
          <BleedTrimOverlay
            pageWidthPx={pageScreenW}
            pageHeightPx={pageScreenH}
            bleed={{
              top: activePage.bleed.top * zoom,
              right: activePage.bleed.right * zoom,
              bottom: activePage.bleed.bottom * zoom,
              left: activePage.bleed.left * zoom,
            }}
          />
        </div>
      )}

      {/* Marquee rect */}
      {normalizedMarquee && (
        <div
          className="pointer-events-none absolute border border-blue-400 bg-blue-400/10"
          style={{
            left: panX + normalizedMarquee.x * zoom,
            top: panY + normalizedMarquee.y * zoom,
            width: normalizedMarquee.width * zoom,
            height: normalizedMarquee.height * zoom,
          }}
        />
      )}

      {/* Inline text editor */}
      {editingTextElement && (
        <InlineTextEditor
          element={editingTextElement}
          zoom={zoom}
          panX={panX}
          panY={panY}
          stageRect={{ left: stageRect.left, top: stageRect.top }}
          onCommit={handleTextCommit}
          onCancel={handleTextCancel}
        />
      )}

      {/* Agent panel (right) */}
      {renderAgentPanel && (
        <div className="absolute right-0 top-0 bottom-0 z-20 w-80 pointer-events-auto">
          {renderAgentPanel({ selectedElements, activePageId })}
        </div>
      )}
    </div>
  )
}
