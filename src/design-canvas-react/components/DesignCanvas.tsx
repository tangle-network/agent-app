/**
 * Root editor shell. Products mount exactly this component. Layout mirrors
 * Polotno: optional left side panel | main column | optional right agent panel.
 *
 * Main column stacks top→bottom:
 *   Toolbar (undo/redo, view toggles, selection attrs, page props)
 *   Rulers + Workspace  (the Workspace is injected by the integrator via the
 *                        `renderWorkspace` prop — it owns Konva and is Konva-
 *                        specific; this chrome stays canvas-free)
 *   bottom row: PagesStrip + ZoomControls
 *
 * Command lifecycle:
 * - The command stack lives here; every panel receives callbacks, never the
 *   stack itself.
 * - `onApplyOperations` is called optimistically after every command. If it
 *   rejects, the command is rolled back locally. If it resolves with a fresh
 *   `document`, the stack rebases via `stack.reset(document)` — this preserves
 *   history while reconciling server-minted ids or normalised values.
 * - `setView` (zoom/pan/selection/toggles) never enters history.
 * - Keyboard: Mod+Z undo · Shift+Mod+Z / Mod+Y redo · Delete/Backspace deletes
 *   the selection · F fits the page (forwarded to workspace via ref).
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { SceneDocument, SceneElement } from '../../design-canvas/model'
import { findElement, requirePage } from '../../design-canvas/model'
import type { SceneAttrsPatch, SceneOperation } from '../../design-canvas/operations'
import type { PageBleed } from '../../design-canvas/model'
import type { DesignCanvasProps, SceneCommand } from '../contracts'
import { createSceneCommandStack } from '../engine/command-stack'
import {
  addPageCommand,
  bindSlotCommand,
  deleteElementCommand,
  deletePageCommand,
  duplicatePageCommand,
  groupElementsCommand,
  multiSetAttrsCommand,
  reorderElementCommand,
  reorderPageCommand,
  setAttrsCommand,
  setPageGuidesCommand,
  setPagePropsCommand,
  ungroupElementCommand,
} from '../engine/commands'
import { clampIndex, indexBackward, indexForward, topIndex } from './ruler-math'
import { BleedTrimOverlay } from './BleedTrimOverlay'
import { LayersPanel } from './LayersPanel'
import { PagesStrip } from './PagesStrip'
import { Rulers } from './Rulers'
import { Toolbar } from './Toolbar'
import { ZoomControls } from './ZoomControls'

/** Callers inject a workspace renderer so this chrome stays Konva-free. The
 *  workspace occupies the scrollable area between the rulers and the bottom bar. */
export interface DesignCanvasFullProps extends DesignCanvasProps {
  /**
   * Render the Konva canvas workspace into the slot this shell provides.
   * The shell passes viewport dimensions, view-state, and the shared command
   * stack so `WorkspaceView` can commit gestures through the same stack the
   * chrome uses for undo/redo and layers-panel selection.
   *
   * `onFitRef` is a ref the workspace fills with a fit-page callback; the
   * shell calls it when the user presses F or clicks the Fit button.
   */
  renderWorkspace(ctx: {
    document: SceneDocument
    activePageId: string
    selectedElementIds: string[]
    zoom: number
    panX: number
    panY: number
    gridEnabled: boolean
    gridSize: number
    snapEnabled: boolean
    showBleed: boolean
    canWrite: boolean
    /** The chrome's command stack. Pass to WorkspaceView so gestures, undo,
     *  and layers-panel selection share a single state machine. */
    stack: ReturnType<typeof createSceneCommandStack>
    activePage: SceneDocument['pages'][number] | undefined
    onFitRef: React.MutableRefObject<(() => void) | null>
    onZoomChange(zoom: number): void
    onPanChange(panX: number, panY: number): void
    onSelectElements(ids: string[], additive: boolean): void
  }): React.ReactNode

  /**
   * Generates page thumbnails for the PagesStrip. Injected by the integrator
   * (who has Konva access) so the chrome doesn't import Konva directly.
   */
  renderThumbnail(page: SceneDocument['pages'][number]): Promise<string | null>
}

function mintId(): string {
  const uuid = globalThis.crypto && 'randomUUID' in globalThis.crypto
    ? globalThis.crypto.randomUUID()
    : null
  return `local-${uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('input, textarea, select, [contenteditable="true"]') !== null
  )
}

/** Commit a command: execute optimistically, persist via `onApplyOperations`,
 *  roll back locally on rejection. The command reference is captured at call
 *  time so the rejection handler removes that specific command regardless of
 *  how many further commands the user has executed while the save was pending. */
function useCommitCommand(
  stack: ReturnType<typeof createSceneCommandStack>,
  onApplyOperations: DesignCanvasProps['onApplyOperations'],
  canWrite: boolean,
  setError: (msg: string | null) => void,
) {
  return useCallback(
    (command: SceneCommand) => {
      if (!canWrite) return
      try {
        stack.execute(command)
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error))
        return
      }
      const ops = command.operations()
      void onApplyOperations(ops)
        .then((result) => {
          if (result.document) {
            // Server re-minted ids or normalised the document: rebase without
            // clearing history. History holds transforms, not snapshots, so
            // rebasing cannot stale it; a later undo re-applies the inverse
            // transform to the current (rebased) document.
            stack.reset(result.document)
          }
        })
        .catch((error: unknown) => {
          // Roll back the specific command that failed. stack.rollback() splices
          // this command out of history and applies its inverse to the current
          // state — commands the user executed while this save was in-flight are
          // not disturbed (their undo entries are preserved). If the command is
          // no longer in the stack (double-fire or already reset), rollback is a
          // safe no-op.
          stack.rollback(command)
          setError(error instanceof Error ? error.message : String(error))
        })
    },
    [stack, onApplyOperations, canWrite, setError],
  )
}

export function DesignCanvas({
  document: initialDocument,
  rev: initialRev,
  canWrite,
  onApplyOperations,
  onSelectionChange,
  renderAgentPanel,
  renderSidePanel,
  onExport,
  className,
  renderWorkspace,
  renderThumbnail,
}: DesignCanvasFullProps) {
  // The command stack is created once from the initial document. Subsequent
  // server refreshes come in via the prop and are applied via reset().
  const stack = useMemo(
    () => createSceneCommandStack(initialDocument, initialDocument.pages[0]?.id ?? 'page-1'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const editorState = useSyncExternalStore(stack.subscribe, stack.getState, stack.getState)

  // Track the applied document prop to detect server refreshes.
  const appliedDocumentRef = useRef(initialDocument)
  useEffect(() => {
    if (appliedDocumentRef.current === initialDocument) return
    appliedDocumentRef.current = initialDocument
    stack.reset(initialDocument)
  }, [initialDocument, stack])

  const [commitError, setCommitError] = useState<string | null>(null)

  const commit = useCommitCommand(stack, onApplyOperations, canWrite, setCommitError)

  // Notify host when selection changes.
  const selectionChangeRef = useRef(onSelectionChange)
  selectionChangeRef.current = onSelectionChange
  useEffect(() => {
    const page = editorState.document.pages.find((p) => p.id === editorState.activePageId)
    if (!page) return
    const selected = editorState.selectedElementIds
      .map((id) => page.elements.find((el) => el.id === id))
      .filter((el): el is SceneElement => el !== undefined)
    selectionChangeRef.current?.(selected)
  }, [editorState.selectedElementIds, editorState.activePageId, editorState.document])

  // Workspace fit callback ref — the workspace fills this; the shell calls it.
  const fitRef = useRef<(() => void) | null>(null)

  // ---------------------------------------------------------------------------
  // View-state helpers (no history)
  // ---------------------------------------------------------------------------

  const setZoom = useCallback((zoom: number) => stack.setView({ zoom }), [stack])
  const setPan = useCallback((panX: number, panY: number) => stack.setView({ panX, panY }), [stack])
  const setActivePage = useCallback((activePageId: string) => stack.setView({ activePageId, selectedElementIds: [] }), [stack])

  const setSelectedElements = useCallback(
    (ids: string[], additive: boolean) => {
      if (!additive) {
        stack.setView({ selectedElementIds: ids })
        return
      }
      const current = new Set(editorState.selectedElementIds)
      for (const id of ids) {
        if (current.has(id)) current.delete(id)
        else current.add(id)
      }
      stack.setView({ selectedElementIds: [...current] })
    },
    [stack, editorState.selectedElementIds],
  )

  // ---------------------------------------------------------------------------
  // Element commands
  // ---------------------------------------------------------------------------

  const handleSetAttrs = useCallback(
    (elementId: string, attrs: SceneAttrsPatch) => {
      const page = requirePage(editorState.document, editorState.activePageId)
      // findElement searches group children; page.elements.find misses nested elements.
      const found = findElement(page, elementId)
      if (!found) return
      if (found.element.locked) return
      const priorAttrs: SceneAttrsPatch = Object.fromEntries(
        Object.keys(attrs).map((k) => [k, (found.element as unknown as Record<string, unknown>)[k]]),
      ) as SceneAttrsPatch
      commit(
        setAttrsCommand({
          pageId: editorState.activePageId,
          elementId,
          attrs,
          priorAttrs,
        }),
      )
    },
    [commit, editorState.activePageId, editorState.document],
  )

  const handleMultiSetAttrs = useCallback(
    (patches: Array<{ elementId: string; attrs: SceneAttrsPatch }>) => {
      const page = requirePage(editorState.document, editorState.activePageId)
      const entries = patches.flatMap(({ elementId, attrs }) => {
        const found = findElement(page, elementId)
        // Skip elements that are missing (concurrent delete) or locked.
        if (!found || found.element.locked) return []
        const priorAttrs = Object.fromEntries(
          Object.keys(attrs).map((k) => [k, (found.element as unknown as Record<string, unknown>)[k]]),
        ) as SceneAttrsPatch
        return [{ pageId: editorState.activePageId, elementId, attrs, priorAttrs }]
      })
      if (entries.length === 0) return
      commit(multiSetAttrsCommand(entries))
    },
    [commit, editorState.activePageId, editorState.document],
  )

  const handleReorder = useCallback(
    (elementId: string, toIndex: number, ownerLength: number, direction: 'front' | 'back' | 'forward' | 'backward') => {
      const page = requirePage(editorState.document, editorState.activePageId)
      // findElement searches group children so nested elements are reorderable.
      const found = findElement(page, elementId)
      if (!found) return
      const currentIndex = found.index
      const target =
        direction === 'front'
          ? topIndex(ownerLength)
          : direction === 'back'
            ? 0
            : direction === 'forward'
              ? indexForward(currentIndex, ownerLength)
              : indexBackward(currentIndex)
      const clamped = clampIndex(target, ownerLength)
      if (clamped === currentIndex) return
      commit(reorderElementCommand({ pageId: editorState.activePageId, elementId, toIndex: clamped }))
    },
    [commit, editorState.activePageId, editorState.document],
  )

  const handleDelete = useCallback(
    (elementIds: string[]) => {
      for (const elementId of elementIds) {
        commit(
          deleteElementCommand({
            document: editorState.document,
            pageId: editorState.activePageId,
            elementId,
          }),
        )
      }
    },
    [commit, editorState.document, editorState.activePageId],
  )

  const handleGroup = useCallback(
    (elementIds: string[]) => {
      commit(
        groupElementsCommand({
          document: editorState.document,
          pageId: editorState.activePageId,
          elementIds,
          groupId: mintId(),
        }),
      )
    },
    [commit, editorState.document, editorState.activePageId],
  )

  const handleUngroup = useCallback(
    (groupId: string) => {
      commit(ungroupElementCommand({ document: editorState.document, pageId: editorState.activePageId, groupId }))
    },
    [commit, editorState.document, editorState.activePageId],
  )

  const handleBindSlot = useCallback(
    (elementId: string, slot: string | null) => {
      commit(bindSlotCommand({ document: editorState.document, pageId: editorState.activePageId, elementId, slot }))
    },
    [commit, editorState.document, editorState.activePageId],
  )

  // ---------------------------------------------------------------------------
  // Page commands
  // ---------------------------------------------------------------------------

  const handleSetPageProps = useCallback(
    (props: { name?: string; width?: number; height?: number; background?: string; bleed?: PageBleed | null }) => {
      commit(setPagePropsCommand({ document: editorState.document, pageId: editorState.activePageId, props }))
    },
    [commit, editorState.document, editorState.activePageId],
  )

  const handleSetPageGuides = useCallback(
    (guides: { vertical: number[]; horizontal: number[] }) => {
      commit(setPageGuidesCommand({ document: editorState.document, pageId: editorState.activePageId, guides }))
    },
    [commit, editorState.document, editorState.activePageId],
  )

  const handleAddPage = useCallback(() => {
    const pageId = mintId()
    commit(addPageCommand({ pageId }))
    setActivePage(pageId)
  }, [commit, setActivePage])

  const handleDuplicatePage = useCallback(
    (sourcePageId: string) => {
      const pageId = mintId()
      commit(duplicatePageCommand({ document: editorState.document, sourcePageId, pageId }))
      setActivePage(pageId)
    },
    [commit, editorState.document, setActivePage],
  )

  const handleDeletePage = useCallback(
    (pageId: string) => {
      commit(deletePageCommand({ document: editorState.document, pageId }))
    },
    [commit, editorState.document],
  )

  const handleReorderPage = useCallback(
    (pageId: string, toIndex: number) => {
      commit(reorderPageCommand({ pageId, toIndex }))
    },
    [commit],
  )

  // ---------------------------------------------------------------------------
  // Undo / redo
  // ---------------------------------------------------------------------------

  const handleUndo = useCallback(() => {
    if (!canWrite || !stack.canUndo()) return
    let command
    try {
      command = stack.undo()
    } catch (error) {
      setCommitError(`Undo failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    // Persist the inverse so the server tracks the undo; on rejection re-execute
    // to re-apply the original forward state.
    void onApplyOperations(command.inverseOperations())
      .then((result) => {
        if (result.document) stack.reset(result.document)
      })
      .catch((error: unknown) => {
        if (stack.canRedo()) {
          try { stack.redo() } catch { /* concurrent edit; next reset reconciles */ }
        }
        setCommitError(error instanceof Error ? error.message : String(error))
      })
  }, [stack, canWrite, onApplyOperations])

  const handleRedo = useCallback(() => {
    if (!canWrite || !stack.canRedo()) return
    let command
    try {
      command = stack.redo()
    } catch (error) {
      setCommitError(`Redo failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    void onApplyOperations(command.operations())
      .then((result) => {
        if (result.document) stack.reset(result.document)
      })
      .catch((error: unknown) => {
        if (stack.canUndo()) {
          try { stack.undo() } catch { /* concurrent edit; next reset reconciles */ }
        }
        setCommitError(error instanceof Error ? error.message : String(error))
      })
  }, [stack, canWrite, onApplyOperations])

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts
  // ---------------------------------------------------------------------------

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey
      if (mod && !isTypingTarget(event.target)) {
        if (event.key.toLowerCase() === 'z') {
          event.preventDefault()
          if (event.shiftKey) handleRedo()
          else handleUndo()
          return
        }
        if (event.key.toLowerCase() === 'y') {
          event.preventDefault()
          handleRedo()
          return
        }
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && !isTypingTarget(event.target)) {
        if (!canWrite || editorState.selectedElementIds.length === 0) return
        event.preventDefault()
        handleDelete(editorState.selectedElementIds)
        return
      }
      if (event.key.toLowerCase() === 'f' && !isTypingTarget(event.target)) {
        event.preventDefault()
        fitRef.current?.()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  // ---------------------------------------------------------------------------
  // Derived state for render
  // ---------------------------------------------------------------------------

  const activePage = useMemo(
    () => editorState.document.pages.find((p) => p.id === editorState.activePageId),
    [editorState.document, editorState.activePageId],
  )

  const selectedElements = useMemo(() => {
    if (!activePage) return []
    return editorState.selectedElementIds
      .map((id) => activePage.elements.find((el) => el.id === id))
      .filter((el): el is SceneElement => el !== undefined)
  }, [activePage, editorState.selectedElementIds])

  if (!activePage) {
    return (
      <div className={`flex h-full items-center justify-center bg-[var(--bg-input)] text-[var(--text-muted)] ${className ?? ''}`}>
        No pages in document
      </div>
    )
  }

  // Bleed extents in screen px for the overlay
  const bleedScreen = editorState.showBleed && activePage.bleed
    ? {
        top: activePage.bleed.top * editorState.zoom,
        right: activePage.bleed.right * editorState.zoom,
        bottom: activePage.bleed.bottom * editorState.zoom,
        left: activePage.bleed.left * editorState.zoom,
      }
    : null

  return (
    <div className={`flex h-full min-h-0 bg-[var(--bg-input)] text-[var(--text-primary)] ${className ?? ''}`}>
      {/* Optional left side panel (asset/template browser, etc.) */}
      {renderSidePanel ? (
        <aside className="flex w-64 shrink-0 flex-col overflow-hidden border-r border-[var(--border-default)]">
          {renderSidePanel()}
        </aside>
      ) : null}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Toolbar */}
        <Toolbar
          page={activePage}
          selectedElements={selectedElements}
          canWrite={canWrite}
          canUndo={stack.canUndo()}
          canRedo={stack.canRedo()}
          gridEnabled={editorState.gridEnabled}
          snapEnabled={editorState.snapEnabled}
          showRulers={editorState.showRulers}
          showBleed={editorState.showBleed}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onToggleGrid={() => stack.setView({ gridEnabled: !editorState.gridEnabled })}
          onToggleSnap={() => stack.setView({ snapEnabled: !editorState.snapEnabled })}
          onToggleRulers={() => stack.setView({ showRulers: !editorState.showRulers })}
          onToggleBleed={() => stack.setView({ showBleed: !editorState.showBleed })}
          onSetAttrs={handleSetAttrs}
          onSetPageProps={handleSetPageProps}
          onSetPageGuides={handleSetPageGuides}
          onReorder={handleReorder}
          onGroup={handleGroup}
          onUngroup={handleUngroup}
          onDelete={handleDelete}
          onBindSlot={handleBindSlot}
        />

        {/* Error bar */}
        {commitError ? (
          <div
            className="flex shrink-0 items-center justify-between gap-3 border-b border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300"
            role="alert"
          >
            <span className="min-w-0 truncate">{commitError}</span>
            <button
              type="button"
              onClick={() => setCommitError(null)}
              className="shrink-0 underline-offset-2 hover:underline"
            >
              Dismiss
            </button>
          </div>
        ) : null}

        {/* Rulers + Workspace area */}
        <div className="relative min-h-0 flex-1">
          {/* Rulers overlay inside the workspace container */}
          <Rulers
            pageWidth={activePage.width}
            pageHeight={activePage.height}
            zoom={editorState.zoom}
            scrollLeft={-editorState.panX / editorState.zoom}
            scrollTop={-editorState.panY / editorState.zoom}
            showRulers={editorState.showRulers}
            guides={activePage.guides}
            onGuidesChange={handleSetPageGuides}
          />

          {/* Bleed overlay — absolutely positioned over the workspace */}
          {bleedScreen && activePage.bleed ? (
            <div
              className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
              aria-hidden
            >
              <div
                style={{
                  position: 'absolute',
                  left: editorState.panX,
                  top: editorState.panY,
                }}
              >
                <BleedTrimOverlay
                  pageWidthPx={activePage.width * editorState.zoom}
                  pageHeightPx={activePage.height * editorState.zoom}
                  bleed={bleedScreen}
                />
              </div>
            </div>
          ) : null}

          {/* Workspace slot (Konva; injected by integrator) */}
          {renderWorkspace({
            document: editorState.document,
            activePageId: editorState.activePageId,
            selectedElementIds: editorState.selectedElementIds,
            zoom: editorState.zoom,
            panX: editorState.panX,
            panY: editorState.panY,
            gridEnabled: editorState.gridEnabled,
            gridSize: editorState.gridSize,
            snapEnabled: editorState.snapEnabled,
            showBleed: editorState.showBleed,
            canWrite,
            stack,
            activePage,
            onFitRef: fitRef,
            onZoomChange: setZoom,
            onPanChange: setPan,
            onSelectElements: setSelectedElements,
          })}
        </div>

        {/* Bottom row: PagesStrip + ZoomControls */}
        <div className="flex shrink-0 items-stretch border-t border-[var(--border-default)]">
          <div className="min-w-0 flex-1 overflow-hidden">
            <PagesStrip
              pages={editorState.document.pages}
              activePageId={editorState.activePageId}
              canWrite={canWrite}
              renderThumbnail={renderThumbnail}
              onSelectPage={setActivePage}
              onAddPage={handleAddPage}
              onDuplicatePage={handleDuplicatePage}
              onDeletePage={handleDeletePage}
              onReorderPage={handleReorderPage}
            />
          </div>
          <div className="flex shrink-0 items-center border-l border-[var(--border-default)]">
            <ZoomControls
              zoom={editorState.zoom}
              onZoom={setZoom}
              onFit={() => fitRef.current?.()}
            />
          </div>
        </div>
      </div>

      {/* Optional right agent panel */}
      {renderAgentPanel ? (
        <aside className="flex w-80 shrink-0 flex-col overflow-hidden border-l border-[var(--border-default)]">
          {renderAgentPanel({ selectedElements, activePageId: editorState.activePageId })}
        </aside>
      ) : null}

      {/* Layers panel lives in the left side panel slot by convention; products
          that want it standalone can render LayersPanel directly. */}
    </div>
  )
}

export default DesignCanvas
