/**
 * Seams between the design-canvas editor's engine and components, mirroring
 * the sequences-react pattern: interface-only so layers build independently.
 *
 * Persistence: the command stack executes optimistically against local state
 * and emits `SceneOperation[]` through `DesignCanvasProps.onApplyOperations`.
 * The host's apply returns the new revision (and the server document when it
 * re-minted ids); a rejected promise rolls the command back. Drag gestures
 * coalesce: pointer moves mutate volatile state, ONE command (final attrs,
 * inverse = pre-gesture attrs) executes on release — undo is per-gesture,
 * never per-pixel.
 */

import type { Bounds, SceneDocument, SceneElement } from '../design-canvas/model'
import type { SceneOperation } from '../design-canvas/operations'

// ---------------------------------------------------------------------------
// Engine: state + command stack
// ---------------------------------------------------------------------------

export interface EditorSceneState {
  document: SceneDocument
  activePageId: string
  selectedElementIds: string[]
  /** Pixels per document px. */
  zoom: number
  panX: number
  panY: number
  gridEnabled: boolean
  /** Document px between grid lines. */
  gridSize: number
  snapEnabled: boolean
  showRulers: boolean
  showBleed: boolean
}

export interface SceneCommand {
  label: string
  execute(state: EditorSceneState): EditorSceneState
  undo(state: EditorSceneState): EditorSceneState
  operations(): SceneOperation[]
  /**
   * The inverse operation sequence for server-side persistence of an undo.
   * Most commands return an exact inverse (e.g. set_attrs → prior set_attrs,
   * add_element → delete_element). deletePageCommand returns add_page +
   * per-element add_element ops restoring the full page snapshot.
   */
  inverseOperations(): SceneOperation[]
}

export interface SceneCommandStack {
  execute(command: SceneCommand): void
  /** Apply the top-of-done-stack inverse and return the command (callers use
   *  `command.inverseOperations()` to persist the undo to the server). */
  undo(): SceneCommand
  /** Re-execute the top-of-redo-stack and return the command (callers use
   *  `command.operations()` to persist the redo to the server). */
  redo(): SceneCommand
  canUndo(): boolean
  canRedo(): boolean
  subscribe(listener: () => void): () => void
  getState(): EditorSceneState
  /** Update volatile view state (zoom/pan/selection/toggles) without touching
   *  history — view changes are never undo steps. */
  setView(patch: Partial<Omit<EditorSceneState, 'document'>>): void
  /** Rebase onto a server refresh WITHOUT clearing history (history holds
   *  operations, not snapshots). */
  reset(document: SceneDocument): void
}

// ---------------------------------------------------------------------------
// Engine: snapping
// ---------------------------------------------------------------------------

export type SnapTargetKind = 'grid' | 'element-edge' | 'element-center' | 'page-edge' | 'page-center' | 'guide'

export interface SnapTarget {
  /** Page-coordinate position of the snap line. */
  position: number
  kind: SnapTargetKind
}

export interface SnapTargets {
  vertical: SnapTarget[]
  horizontal: SnapTarget[]
}

export interface SnapResult {
  x: number
  y: number
  /** Lines to render while the gesture holds the snap. */
  activeVertical: SnapTarget | null
  activeHorizontal: SnapTarget | null
}

export interface SnapEngine {
  /** Collect targets for a gesture: other elements' edges/centers, page
   *  edges/center, saved guides, and grid lines when enabled. `excludeIds`
   *  removes the dragged elements' own geometry. */
  collectTargets(state: EditorSceneState, excludeIds: string[]): SnapTargets
  /** Snap a moving AABB. Threshold is SCREEN pixels, divided by zoom. */
  apply(bounds: Bounds, targets: SnapTargets, thresholdPx: number, zoom: number): SnapResult
}

// ---------------------------------------------------------------------------
// Engine: zoom + pan
// ---------------------------------------------------------------------------

export interface ZoomPanMath {
  minZoom: number
  maxZoom: number
  /** Zoom about a screen point so the document point under the cursor stays
   *  fixed (wheel-zoom-to-cursor). Returns the clamped new view. */
  zoomAtPoint(state: { zoom: number; panX: number; panY: number }, factor: number, screenX: number, screenY: number): { zoom: number; panX: number; panY: number }
  /** Fit the active page into a viewport with padding. */
  fitPage(page: { width: number; height: number }, viewport: { width: number; height: number }, paddingPx?: number): { zoom: number; panX: number; panY: number }
  documentToScreen(state: { zoom: number; panX: number; panY: number }, x: number, y: number): { x: number; y: number }
  screenToDocument(state: { zoom: number; panX: number; panY: number }, x: number, y: number): { x: number; y: number }
}

// ---------------------------------------------------------------------------
// Components: the editor's public props
// ---------------------------------------------------------------------------

export interface ApplySceneResult {
  rev: number
  /** Present when the server re-minted ids or normalized the document; the
   *  editor rebases onto it. */
  document?: SceneDocument
}

export interface DesignCanvasProps {
  document: SceneDocument
  /** Revision the document was loaded at; threaded through saves. */
  rev: number
  canWrite: boolean
  /** Persist operations. Resolve with the new revision; reject to roll back.
   *  A stale-revision failure should resolve AFTER refetch with the fresh
   *  document so the editor rebases instead of fighting. */
  onApplyOperations(operations: SceneOperation[]): Promise<ApplySceneResult>
  onSelectionChange?(elements: SceneElement[]): void
  /** Host panels: agent chat (right), asset/template browser (left). */
  renderAgentPanel?(ctx: { selectedElements: SceneElement[]; activePageId: string }): React.ReactNode
  renderSidePanel?(): React.ReactNode
  /** Export hook — host persists the rendered blob (upload → asset row). */
  onExport?(result: { pageId: string; format: 'png' | 'jpeg'; dataUrl: string; pixelRatio: number }): Promise<void>
  className?: string
}
