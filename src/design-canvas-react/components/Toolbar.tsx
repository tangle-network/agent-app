/**
 * Selection-aware toolbar. When elements are selected it shows per-kind
 * attribute controls; when nothing is selected it shows page-props controls.
 * Every number input commits on blur or Enter as a single command (not
 * per-keystroke). The toolbar is stateless beyond transient input focus;
 * the caller owns the command stack.
 *
 * Layout: the root never scrolls horizontally. Global controls (undo/redo +
 * view toggles) are pinned left; the selection/page attribute group wraps so
 * the whole bar fits the editor's center column (viewport minus the w-64 side
 * panel and w-80 agent panel) at 1024–1280px with nothing clipped.
 */

import type { SceneElement, ScenePage, PageBleed } from '../../design-canvas/model'
import type { SceneAttrsPatch } from '../../design-canvas/operations'
import type { DesignCanvasMode } from '../contracts'
import { BleedGlyph, GridGlyph, MagnetGlyph, RedoGlyph, RulerGlyph, UndoGlyph } from './glyphs'
import { BTN, BTN_ACTIVE } from './icon-button'
import { SEP, FIELD_LABEL } from './toolbar-fields'
import { SelectionControls } from './toolbar-selection-controls'
import { PagePropsControls } from './toolbar-page-controls'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolbarProps {
  page: ScenePage
  selectedElements: SceneElement[]
  canWrite: boolean
  /** Capability mode. `'review'` (the lean reviewer) hides the view toggles,
   *  page-props controls, and the destructive/structural selection controls
   *  (z-order, group/ungroup, lock, slot, delete), keeping only safe direct
   *  edits: text content, image fit/replace, opacity/rotation, undo/redo.
   *  Defaults to `'edit'` (the full authoring toolbar). */
  mode?: DesignCanvasMode
  canUndo: boolean
  canRedo: boolean
  gridEnabled: boolean
  snapEnabled: boolean
  showRulers: boolean
  showBleed: boolean
  onUndo(): void
  onRedo(): void
  onToggleGrid(): void
  onToggleSnap(): void
  onToggleRulers(): void
  onToggleBleed(): void
  /** Emit attrs patch for each selected element. */
  onSetAttrs(elementId: string, attrs: SceneAttrsPatch): void
  onSetPageProps(props: { name?: string; width?: number; height?: number; background?: string; bleed?: PageBleed | null }): void
  onSetPageGuides(guides: { vertical: number[]; horizontal: number[] }): void
  onReorder(elementId: string, toIndex: number, ownerLength: number, direction: 'front' | 'back' | 'forward' | 'backward'): void
  onGroup(elementIds: string[]): void
  onUngroup(groupId: string): void
  onDelete(elementIds: string[]): void
  onBindSlot(elementId: string, slot: string | null): void
  /** Field label for the page-size control. Defaults to the clearer "Page size";
   *  overridable for consumers that want the older "Preset" wording. */
  pageSizeLabel?: string
  /** Title for the "turn on print bleed" action. Defaults to "Show print bleed"
   *  (the outcome) rather than the print-shop term "bleed". */
  enableBleedLabel?: string
}

// ---------------------------------------------------------------------------
// Main toolbar
// ---------------------------------------------------------------------------

export function Toolbar({
  page,
  selectedElements,
  canWrite,
  mode = 'edit',
  canUndo,
  canRedo,
  gridEnabled,
  snapEnabled,
  showRulers,
  showBleed,
  onUndo,
  onRedo,
  onToggleGrid,
  onToggleSnap,
  onToggleRulers,
  onToggleBleed,
  onSetAttrs,
  onSetPageProps,
  onSetPageGuides,
  onReorder,
  onGroup,
  onUngroup,
  onDelete,
  onBindSlot,
  pageSizeLabel = 'Page size',
  enableBleedLabel = 'Show print bleed',
}: ToolbarProps) {
  const hasSelection = selectedElements.length > 0
  const single = selectedElements.length === 1 ? selectedElements[0]! : null
  const allSameKind = selectedElements.length > 0 && selectedElements.every((e) => e.kind === selectedElements[0]!.kind)
  const firstKind = selectedElements[0]?.kind

  // Shared multi-element patch helper.
  function patchAll(attrs: SceneAttrsPatch) {
    for (const el of selectedElements) onSetAttrs(el.id, attrs)
  }

  // Z-order helpers operate on the single selection only (multi-element
  // z-order is a complex multi-step operation; single is the common case).
  function reorderSingle(direction: 'front' | 'back' | 'forward' | 'backward') {
    if (!single) return
    // ownerLength requires knowing the owner; we use page.elements length for
    // root-level elements. Group children are handled via the layers panel.
    onReorder(single.id, 0, page.elements.length, direction)
  }

  const selectedIds = selectedElements.map((e) => e.id)
  const isGroup = single?.kind === 'group'
  const groupable = selectedElements.length >= 2
  const review = mode === 'review'

  // ----

  return (
    <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--border-default)] bg-[var(--bg-input)] px-3 py-1">
      {/* Global controls: pinned first, never wrap away from the left edge.
          Grouped by intent so history reads apart from the view utilities:
          Undo/Redo (history) | a labelled View cluster (rulers/grid/snap/bleed). */}
      <div className="flex shrink-0 items-center gap-2">
        {/* History: Undo / Redo */}
        <div className="flex items-center gap-1" role="group" aria-label="History">
          <button type="button" aria-label="Undo" disabled={!canUndo || !canWrite} onClick={onUndo} className={BTN}>
            <UndoGlyph className="h-3.5 w-3.5" />
          </button>
          <button type="button" aria-label="Redo" disabled={!canRedo || !canWrite} onClick={onRedo} className={BTN}>
            <RedoGlyph className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* View toggles (grid/snap/ruler/bleed) are view utilities, not creation
            actions — a quiet "View" label sets them apart by intent. The review
            surface hides them so the bar stays lean. */}
        {!review ? (
          <>
            {SEP}
            <div className="flex items-center gap-1" role="group" aria-label="View">
              <span className={`${FIELD_LABEL} mr-0.5 hidden md:inline`} aria-hidden>
                View
              </span>
              <button type="button" aria-label="Toggle rulers" aria-pressed={showRulers} onClick={onToggleRulers} className={showRulers ? BTN_ACTIVE : BTN} title="Rulers">
                <RulerGlyph className="h-3.5 w-3.5" />
              </button>
              <button type="button" aria-label="Toggle grid" aria-pressed={gridEnabled} onClick={onToggleGrid} className={gridEnabled ? BTN_ACTIVE : BTN} title="Grid">
                <GridGlyph className="h-3.5 w-3.5" />
              </button>
              <button type="button" aria-label="Toggle snap" aria-pressed={snapEnabled} onClick={onToggleSnap} className={snapEnabled ? BTN_ACTIVE : BTN} title="Snap to guides">
                <MagnetGlyph className="h-3.5 w-3.5" />
              </button>
              <button type="button" aria-label="Toggle bleed overlay" aria-pressed={showBleed} onClick={onToggleBleed} className={showBleed ? BTN_ACTIVE : BTN} disabled={!page.bleed} title="Show print bleed">
                <BleedGlyph className="h-3.5 w-3.5" />
              </button>
            </div>
          </>
        ) : null}
      </div>

      {/* Selection attributes: this group wraps to the next line when the column
          is narrow so nothing is ever clipped or scrolled away. In review mode
          the page-props controls (no-selection authoring) are omitted entirely
          and the selection controls drop structural/destructive actions. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {hasSelection ? (
          <>
            {SEP}
            <SelectionControls
              elements={selectedElements}
              single={single}
              isGroup={isGroup}
              groupable={groupable}
              allSameKind={allSameKind}
              firstKind={firstKind}
              canWrite={canWrite}
              review={review}
              patchAll={patchAll}
              reorderSingle={reorderSingle}
              onGroup={() => onGroup(selectedIds)}
              onUngroup={() => { if (single) onUngroup(single.id) }}
              onDelete={() => onDelete(selectedIds)}
              onBindSlot={single ? (slot) => onBindSlot(single.id, slot) : undefined}
              currentSlot={single?.slot ?? null}
            />
          </>
        ) : !review ? (
          <>
            {SEP}
            <PagePropsControls
              page={page}
              canWrite={canWrite}
              onSetPageProps={onSetPageProps}
              onSetPageGuides={onSetPageGuides}
              pageSizeLabel={pageSizeLabel}
              enableBleedLabel={enableBleedLabel}
            />
          </>
        ) : null}
      </div>
    </div>
  )
}
