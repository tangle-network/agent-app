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

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SceneElement, ScenePage, TextElement, RectElement, EllipseElement, ImageElement } from '../../design-canvas/model'
import type { SceneAttrsPatch } from '../../design-canvas/operations'
import type { PageBleed } from '../../design-canvas/model'
import type { DesignCanvasMode } from '../contracts'
import { matchPreset, SIZE_PRESETS } from '../../design-canvas/export-presets'
import {
  AlignCenterGlyph,
  AlignLeftGlyph,
  AlignRightGlyph,
  BleedGlyph,
  BoldGlyph,
  BringFrontGlyph,
  GridGlyph,
  GroupGlyph,
  ItalicGlyph,
  LockGlyph,
  MagnetGlyph,
  RedoGlyph,
  RulerGlyph,
  SendBackGlyph,
  SlotGlyph,
  SwapGlyph,
  TrashGlyph,
  UndoGlyph,
  UngroupGlyph,
  UnlockGlyph,
} from './glyphs'
import { BTN, BTN_ACTIVE } from './icon-button'

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
  /** Field label for the page-size preset control. Overridable so a consumer
   *  can use the clearer "Page size"; defaults to "Preset" for back-compat. */
  pageSizeLabel?: string
  /** Title for the "turn on print bleed" action. Defaults to "Show print bleed"
   *  (the outcome) rather than the print-shop term "bleed". */
  enableBleedLabel?: string
}

// ---------------------------------------------------------------------------
// Font families offered by the font picker. The model's fontFamily is a free
// string (agents/templates may set anything); the picker selects from this
// curated list but always surfaces the element's current family even when it
// is not a member, so a programmatically-set font is never silently dropped.
// ---------------------------------------------------------------------------

const FONT_FAMILIES = [
  'Inter',
  'Arial',
  'Helvetica',
  'Verdana',
  'Tahoma',
  'Trebuchet MS',
  'Times New Roman',
  'Georgia',
  'Garamond',
  'Courier New',
  'Brush Script MT',
  'Impact',
] as const

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const SEP = <div className="mx-1 h-5 w-px shrink-0 bg-[var(--border-default)]" />

const POPOVER_PANEL =
  'absolute top-full left-0 z-50 mt-1 flex flex-col rounded border border-[var(--border-default)] bg-[var(--bg-input)] shadow-lg'

/**
 * Click-outside / Escape-to-close popover anchored under its trigger. The
 * trigger renders inside the relative wrapper so the panel positions against
 * it. `open`/`onClose` are owned by the caller so the trigger can stay a
 * stateful glyph button when needed.
 */
function Popover({
  open,
  onClose,
  trigger,
  children,
}: {
  open: boolean
  onClose(): void
  trigger: ReactNode
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDocPointer(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onDocPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDocPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  return (
    <div ref={ref} className="relative">
      {trigger}
      {open ? children : null}
    </div>
  )
}

const FIELD_LABEL = 'text-[9px] uppercase tracking-wide text-[var(--text-muted)]'

function NumberInput({
  label,
  value,
  onCommit,
  min,
  step = 1,
  className = 'w-16',
}: {
  label: string
  value: number
  onCommit(v: number): void
  min?: number
  step?: number
  className?: string
}) {
  const [raw, setRaw] = useState<string | null>(null)

  function commit(v: string) {
    const n = parseFloat(v)
    if (Number.isFinite(n) && (min === undefined || n >= min)) onCommit(n)
    setRaw(null)
  }

  return (
    <label className="flex flex-col items-center gap-0.5">
      <span className={FIELD_LABEL}>{label}</span>
      <input
        type="number"
        value={raw ?? value}
        min={min}
        step={step}
        onChange={(event) => setRaw(event.target.value)}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit((event.target as HTMLInputElement).value)
          if (event.key === 'Escape') setRaw(null)
        }}
        className={`${className} rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-1 py-0.5 text-center text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--brand-primary)]`}
      />
    </label>
  )
}

/**
 * Compact dropdown built on the popover pattern (replaces native <select>,
 * which the design system bans). Same value/onChange contract: `value` is the
 * current option id, `onChange` fires with the chosen id.
 */
function SelectControl<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
  buttonClassName = 'w-24',
}: {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  disabled?: boolean
  onChange(value: T): void
  buttonClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value)

  return (
    <label className="flex flex-col items-center gap-0.5">
      <span className={FIELD_LABEL}>{label}</span>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        trigger={
          <button
            type="button"
            disabled={disabled}
            aria-haspopup="listbox"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className={`${buttonClassName} flex items-center justify-between gap-1 rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-2 py-0.5 text-left text-[12px] text-[var(--text-primary)] outline-none hover:border-[var(--brand-primary)] disabled:cursor-default disabled:opacity-40`}
          >
            <span className="truncate">{current?.label ?? value}</span>
            <span className="text-[8px] text-[var(--text-muted)]">▾</span>
          </button>
        }
      >
        <div role="listbox" className={`${POPOVER_PANEL} max-h-64 w-44 overflow-y-auto py-1`}>
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              onClick={() => {
                onChange(opt.value)
                setOpen(false)
              }}
              className={`px-3 py-1 text-left text-[12px] hover:bg-[var(--brand-primary)]/10 ${
                opt.value === value ? 'text-[var(--brand-primary)]' : 'text-[var(--text-primary)]'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </Popover>
    </label>
  )
}

/**
 * Searchable font dropdown. Each option previews in its own family. The
 * element's current family is always present in the list (prepended when it
 * is not one of the curated families) so a typed/agent-set font is never lost.
 */
function FontPicker({
  value,
  disabled,
  onChange,
}: {
  value: string
  disabled?: boolean
  onChange(value: string): void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const families: string[] = FONT_FAMILIES.includes(value as (typeof FONT_FAMILIES)[number])
    ? [...FONT_FAMILIES]
    : [value, ...FONT_FAMILIES]
  const filtered = families.filter((f) => f.toLowerCase().includes(query.trim().toLowerCase()))

  return (
    <label className="flex flex-col items-center gap-0.5">
      <span className={FIELD_LABEL}>Font</span>
      <Popover
        open={open}
        onClose={() => {
          setOpen(false)
          setQuery('')
        }}
        trigger={
          <button
            type="button"
            disabled={disabled}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label="Font family"
            onClick={() => setOpen((v) => !v)}
            className="flex w-28 items-center justify-between gap-1 rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-2 py-0.5 text-left text-[12px] text-[var(--text-primary)] outline-none hover:border-[var(--brand-primary)] disabled:cursor-default disabled:opacity-40"
            style={{ fontFamily: value }}
          >
            <span className="truncate">{value}</span>
            <span className="text-[8px] text-[var(--text-muted)]">▾</span>
          </button>
        }
      >
        <div className={`${POPOVER_PANEL} w-52`}>
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search fonts"
            aria-label="Search fonts"
            className="m-1 rounded border border-[var(--border-default)] bg-transparent px-2 py-1 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--brand-primary)]"
          />
          <div role="listbox" className="max-h-60 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-[var(--text-muted)]">No matches</div>
            ) : (
              filtered.map((family) => (
                <button
                  key={family}
                  type="button"
                  role="option"
                  aria-selected={family === value}
                  onClick={() => {
                    onChange(family)
                    setOpen(false)
                    setQuery('')
                  }}
                  style={{ fontFamily: family }}
                  className={`block w-full px-3 py-1 text-left text-[13px] hover:bg-[var(--brand-primary)]/10 ${
                    family === value ? 'text-[var(--brand-primary)]' : 'text-[var(--text-primary)]'
                  }`}
                >
                  {family}
                </button>
              ))
            )}
          </div>
        </div>
      </Popover>
    </label>
  )
}

/**
 * Color control: a swatch button (showing the current color) that opens a
 * popover with a native color picker + hex field. Replaces the bare
 * <input type="color"> chrome while keeping the string value/onChange contract.
 */
function ColorSwatch({ label, value, onCommit, disabled }: { label: string; value: string; onCommit(v: string): void; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const normalized = value.startsWith('#') ? value : '#ffffff'

  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className={FIELD_LABEL}>{label}</span>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        trigger={
          <button
            type="button"
            disabled={disabled}
            aria-label={`${label} color`}
            onClick={() => setOpen((v) => !v)}
            className="h-6 w-10 rounded border border-[var(--border-default)] disabled:cursor-default disabled:opacity-40"
            style={{ backgroundColor: normalized }}
          />
        }
      >
        <div className={`${POPOVER_PANEL} w-40 gap-2 p-2`}>
          <input
            type="color"
            aria-label={`${label} color picker`}
            value={normalized}
            onChange={(event) => onCommit(event.target.value)}
            className="h-8 w-full cursor-pointer rounded border border-[var(--border-default)] p-0.5"
          />
          <input
            type="text"
            aria-label={`${label} hex value`}
            value={value}
            onChange={(event) => onCommit(event.target.value)}
            className="rounded border border-[var(--border-default)] bg-transparent px-2 py-1 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--brand-primary)]"
          />
        </div>
      </Popover>
    </div>
  )
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
  pageSizeLabel = 'Preset',
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

// ---------------------------------------------------------------------------
// Selection controls
// ---------------------------------------------------------------------------

interface SelectionControlsProps {
  elements: SceneElement[]
  single: SceneElement | null
  isGroup: boolean
  groupable: boolean
  allSameKind: boolean
  firstKind: SceneElement['kind'] | undefined
  canWrite: boolean
  /** Review mode drops z-order, group/ungroup, lock, slot-bind, and delete. */
  review: boolean
  patchAll(attrs: SceneAttrsPatch): void
  reorderSingle(direction: 'front' | 'back' | 'forward' | 'backward'): void
  onGroup(): void
  onUngroup(): void
  onDelete(): void
  onBindSlot?(slot: string | null): void
  currentSlot: string | null
}

function SelectionControls({
  elements,
  single,
  isGroup,
  groupable,
  allSameKind,
  firstKind,
  canWrite,
  review,
  patchAll,
  reorderSingle,
  onGroup,
  onUngroup,
  onDelete,
  onBindSlot,
  currentSlot,
}: SelectionControlsProps) {
  const [slotPopoverOpen, setSlotPopoverOpen] = useState(false)
  const [slotInput, setSlotInput] = useState('')
  const firstEl = elements[0]!

  return (
    <>
      {/* Kind-specific attrs */}
      {allSameKind && firstKind === 'text' && single ? (
        <TextControls element={single as TextElement} canWrite={canWrite} onPatch={(attrs) => patchAll(attrs)} />
      ) : null}

      {allSameKind && (firstKind === 'rect') && single ? (
        <ShapeControls element={single as RectElement} canWrite={canWrite} onPatch={(attrs) => patchAll(attrs)} showCornerRadius />
      ) : null}

      {allSameKind && firstKind === 'ellipse' && single ? (
        <ShapeControls element={single as EllipseElement} canWrite={canWrite} onPatch={(attrs) => patchAll(attrs)} showCornerRadius={false} />
      ) : null}

      {allSameKind && firstKind === 'image' && single ? (
        <ImageControls element={single as ImageElement} canWrite={canWrite} onPatch={(attrs) => patchAll(attrs)} />
      ) : null}

      {SEP}

      {/* Shared: opacity + rotation */}
      <NumberInput
        label="Opacity"
        value={Math.round((firstEl.opacity ?? 1) * 100)}
        min={0}
        onCommit={(v) => patchAll({ opacity: Math.max(0, Math.min(1, v / 100)) })}
        className="w-14"
      />
      <NumberInput
        label="Rotation"
        value={Math.round(firstEl.rotation ?? 0)}
        onCommit={(v) => patchAll({ rotation: v })}
        className="w-14"
      />

      {/* Structural + destructive controls: hidden on the review surface, which
          allows only direct attribute edits and reposition (drag). */}
      {review ? null : (
      <>
      {SEP}

      {/* Z-order (single selection) */}
      {single ? (
        <>
          <button type="button" aria-label="Bring to front" disabled={!canWrite} onClick={() => reorderSingle('front')} className={BTN}>
            <BringFrontGlyph className="h-3.5 w-3.5" />
          </button>
          <button type="button" aria-label="Send to back" disabled={!canWrite} onClick={() => reorderSingle('back')} className={BTN}>
            <SendBackGlyph className="h-3.5 w-3.5" />
          </button>
          {SEP}
        </>
      ) : null}

      {/* Group / Ungroup */}
      {groupable ? (
        <button type="button" aria-label="Group elements" disabled={!canWrite} onClick={onGroup} className={BTN}>
          <GroupGlyph className="h-3.5 w-3.5" />
        </button>
      ) : null}
      {isGroup ? (
        <button type="button" aria-label="Ungroup" disabled={!canWrite} onClick={onUngroup} className={BTN}>
          <UngroupGlyph className="h-3.5 w-3.5" />
        </button>
      ) : null}

      {/* Lock */}
      {single ? (
        <button
          type="button"
          aria-label={single.locked ? 'Unlock element' : 'Lock element'}
          aria-pressed={!!single.locked}
          disabled={!canWrite}
          onClick={() => patchAll({ locked: !single.locked })}
          className={single.locked ? BTN_ACTIVE : BTN}
        >
          {single.locked ? <LockGlyph className="h-3.5 w-3.5" /> : <UnlockGlyph className="h-3.5 w-3.5" />}
        </button>
      ) : null}

      {/* Slot binding (single element only) */}
      {single && onBindSlot ? (
        <Popover
          open={slotPopoverOpen}
          onClose={() => setSlotPopoverOpen(false)}
          trigger={
            <button
              type="button"
              aria-label={currentSlot ? `Slot: ${currentSlot}` : 'Bind slot'}
              aria-pressed={!!currentSlot}
              aria-haspopup="dialog"
              aria-expanded={slotPopoverOpen}
              onClick={() => { setSlotInput(currentSlot ?? ''); setSlotPopoverOpen((v) => !v) }}
              className={currentSlot ? BTN_ACTIVE : BTN}
              title={currentSlot ? `Slot: ${currentSlot}` : 'Bind slot'}
            >
              <SlotGlyph className="h-3.5 w-3.5" />
            </button>
          }
        >
          <div className={`${POPOVER_PANEL} w-48 gap-2 p-2`}>
            <input
              autoFocus
              value={slotInput}
              onChange={(event) => setSlotInput(event.target.value)}
              placeholder="slot-name"
              className="rounded border border-[var(--border-default)] bg-transparent px-2 py-1 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--brand-primary)]"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { onBindSlot(slotInput.trim() || null); setSlotPopoverOpen(false) }}
                className="flex-1 rounded border border-[var(--brand-primary)] px-2 py-0.5 text-[11px] text-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/10"
              >
                {slotInput.trim() ? 'Bind' : 'Unbind'}
              </button>
              <button
                type="button"
                onClick={() => setSlotPopoverOpen(false)}
                className="rounded border border-[var(--border-default)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)]"
              >
                Cancel
              </button>
            </div>
          </div>
        </Popover>
      ) : null}

      {SEP}

      {/* Delete — destructive, marked apart with a danger-tinted hover. */}
      <button
        type="button"
        aria-label="Delete selection"
        disabled={!canWrite}
        onClick={onDelete}
        className={`${BTN} text-[var(--text-danger)] hover:border-[var(--text-danger)] hover:text-[var(--text-danger)]`}
      >
        <TrashGlyph className="h-3.5 w-3.5" />
      </button>
      </>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Kind-specific controls
// ---------------------------------------------------------------------------

function TextControls({ element, canWrite, onPatch }: { element: TextElement; canWrite: boolean; onPatch(attrs: SceneAttrsPatch): void }) {
  return (
    <>
      <FontPicker value={element.fontFamily} disabled={!canWrite} onChange={(fontFamily) => onPatch({ fontFamily })} />
      <NumberInput label="Size" value={element.fontSize} min={1} onCommit={(v) => onPatch({ fontSize: v })} className="w-12" />
      <button
        type="button"
        aria-label="Bold"
        aria-pressed={!!element.fontStyle?.includes('bold')}
        disabled={!canWrite}
        onClick={() => onPatch({ fontStyle: element.fontStyle === 'bold' || element.fontStyle === 'bold italic' ? (element.fontStyle === 'bold italic' ? 'italic' : 'normal') : (element.fontStyle === 'italic' ? 'bold italic' : 'bold') })}
        className={element.fontStyle?.includes('bold') ? BTN_ACTIVE : BTN}
      >
        <BoldGlyph className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label="Italic"
        aria-pressed={!!element.fontStyle?.includes('italic')}
        disabled={!canWrite}
        onClick={() => onPatch({ fontStyle: element.fontStyle === 'italic' || element.fontStyle === 'bold italic' ? (element.fontStyle === 'bold italic' ? 'bold' : 'normal') : (element.fontStyle === 'bold' ? 'bold italic' : 'italic') })}
        className={element.fontStyle?.includes('italic') ? BTN_ACTIVE : BTN}
      >
        <ItalicGlyph className="h-3.5 w-3.5" />
      </button>
      <div role="radiogroup" aria-label="Text alignment" className="flex items-center gap-2">
        {(['left', 'center', 'right'] as const).map((align) => (
          <button
            key={align}
            type="button"
            role="radio"
            aria-label={`Align ${align}`}
            aria-checked={element.align === align}
            disabled={!canWrite}
            onClick={() => onPatch({ align })}
            className={element.align === align ? BTN_ACTIVE : BTN}
          >
            {align === 'left' ? <AlignLeftGlyph className="h-3.5 w-3.5" /> : align === 'center' ? <AlignCenterGlyph className="h-3.5 w-3.5" /> : <AlignRightGlyph className="h-3.5 w-3.5" />}
          </button>
        ))}
      </div>
      <NumberInput label="Line H" value={element.lineHeight} step={0.1} min={0.5} onCommit={(v) => onPatch({ lineHeight: v })} className="w-12" />
      <NumberInput label="Spacing" value={element.letterSpacing} step={0.5} onCommit={(v) => onPatch({ letterSpacing: v })} className="w-14" />
      <ColorSwatch label="Fill" value={element.fill} onCommit={(v) => onPatch({ fill: v })} disabled={!canWrite} />
    </>
  )
}

function ShapeControls({ element, canWrite, onPatch, showCornerRadius }: { element: RectElement | EllipseElement; canWrite: boolean; onPatch(attrs: SceneAttrsPatch): void; showCornerRadius: boolean }) {
  return (
    <>
      <ColorSwatch label="Fill" value={element.fill} onCommit={(v) => onPatch({ fill: v })} disabled={!canWrite} />
      <ColorSwatch label="Stroke" value={element.stroke ?? '#000000'} onCommit={(v) => onPatch({ stroke: v })} disabled={!canWrite} />
      <NumberInput label="Stroke W" value={element.strokeWidth ?? 0} min={0} onCommit={(v) => onPatch({ strokeWidth: v })} className="w-14" />
      {showCornerRadius && 'cornerRadius' in element ? (
        <NumberInput label="Corner R" value={(element as RectElement).cornerRadius ?? 0} min={0} onCommit={(v) => onPatch({ cornerRadius: v })} className="w-14" />
      ) : null}
    </>
  )
}

function ImageControls({ element, canWrite, onPatch }: { element: ImageElement; canWrite: boolean; onPatch(attrs: SceneAttrsPatch): void }) {
  const [swapOpen, setSwapOpen] = useState(false)
  const [swapUrl, setSwapUrl] = useState('')

  return (
    <>
      <SelectControl
        label="Fit"
        value={element.fit}
        disabled={!canWrite}
        onChange={(fit) => onPatch({ fit })}
        buttonClassName="w-24"
        options={[
          { value: 'fill', label: 'Fill' },
          { value: 'cover', label: 'Cover' },
          { value: 'contain', label: 'Contain' },
        ]}
      />
      {/* Image swap: replace the source in place (size/position preserved). A
          safe direct edit, available in review mode. */}
      <Popover
        open={swapOpen}
        onClose={() => setSwapOpen(false)}
        trigger={
          <button
            type="button"
            aria-label="Replace image"
            disabled={!canWrite}
            onClick={() => { setSwapUrl(element.src); setSwapOpen((v) => !v) }}
            className={BTN}
            title="Replace image"
          >
            <SwapGlyph className="h-3.5 w-3.5" />
          </button>
        }
      >
        <div className={`${POPOVER_PANEL} w-64 gap-2 p-2`}>
          <input
            autoFocus
            value={swapUrl}
            onChange={(event) => setSwapUrl(event.target.value)}
            placeholder="https://… image URL"
            aria-label="New image URL"
            className="rounded border border-[var(--border-default)] bg-transparent px-2 py-1 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--brand-primary)]"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!swapUrl.trim() || swapUrl.trim() === element.src}
              onClick={() => { onPatch({ src: swapUrl.trim() }); setSwapOpen(false) }}
              className="flex-1 rounded border border-[var(--brand-primary)] px-2 py-0.5 text-[11px] text-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/10 disabled:cursor-default disabled:opacity-40"
            >
              Replace
            </button>
            <button
              type="button"
              onClick={() => setSwapOpen(false)}
              className="rounded border border-[var(--border-default)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)]"
            >
              Cancel
            </button>
          </div>
        </div>
      </Popover>
    </>
  )
}

// ---------------------------------------------------------------------------
// Page props controls (no selection)
// ---------------------------------------------------------------------------

interface PagePropsControlsProps {
  page: ScenePage
  canWrite: boolean
  onSetPageProps(props: { name?: string; width?: number; height?: number; background?: string; bleed?: PageBleed | null }): void
  onSetPageGuides(guides: { vertical: number[]; horizontal: number[] }): void
  pageSizeLabel?: string
  enableBleedLabel?: string
}

function PagePropsControls({ page, canWrite, onSetPageProps, onSetPageGuides, pageSizeLabel = 'Preset', enableBleedLabel = 'Show print bleed' }: PagePropsControlsProps) {
  const matchedPreset = matchPreset(page.width, page.height)
  const [customW, setCustomW] = useState<string | null>(null)
  const [customH, setCustomH] = useState<string | null>(null)

  function commitDimension(dim: 'width' | 'height', raw: string) {
    const v = parseFloat(raw)
    if (Number.isFinite(v) && v > 0) onSetPageProps({ [dim]: v })
    if (dim === 'width') setCustomW(null)
    else setCustomH(null)
  }

  const presetOptions = [
    { value: 'custom', label: 'Custom' },
    ...SIZE_PRESETS.map((p) => ({ value: p.id, label: p.label })),
  ]

  return (
    <>
      {/* Page name */}
      <input
        type="text"
        aria-label="Page name"
        value={page.name}
        disabled={!canWrite}
        onChange={(event) => onSetPageProps({ name: event.target.value })}
        className="w-28 rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-2 py-0.5 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--brand-primary)]"
      />

      {SEP}

      {/* Size preset */}
      <SelectControl
        label={pageSizeLabel}
        value={matchedPreset?.id ?? 'custom'}
        disabled={!canWrite}
        onChange={(id) => {
          const preset = SIZE_PRESETS.find((p) => p.id === id)
          if (preset) onSetPageProps({ width: preset.width, height: preset.height })
        }}
        options={presetOptions}
      />

      {/* Custom W × H */}
      <label className="flex flex-col items-center gap-0.5">
        <span className={FIELD_LABEL}>W</span>
        <input
          type="number"
          value={customW ?? page.width}
          min={1}
          disabled={!canWrite}
          onChange={(event) => setCustomW(event.target.value)}
          onBlur={(event) => commitDimension('width', event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitDimension('width', (event.target as HTMLInputElement).value)
            if (event.key === 'Escape') setCustomW(null)
          }}
          className="w-16 rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-1 py-0.5 text-center text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--brand-primary)]"
        />
      </label>
      <span className="text-[var(--text-muted)]">×</span>
      <label className="flex flex-col items-center gap-0.5">
        <span className={FIELD_LABEL}>H</span>
        <input
          type="number"
          value={customH ?? page.height}
          min={1}
          disabled={!canWrite}
          onChange={(event) => setCustomH(event.target.value)}
          onBlur={(event) => commitDimension('height', event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitDimension('height', (event.target as HTMLInputElement).value)
            if (event.key === 'Escape') setCustomH(null)
          }}
          className="w-16 rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-1 py-0.5 text-center text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--brand-primary)]"
        />
      </label>

      {SEP}

      <ColorSwatch label="BG" value={page.background} onCommit={(v) => onSetPageProps({ background: v })} disabled={!canWrite} />

      {SEP}

      {/* Bleed controls */}
      <BleedControls page={page} canWrite={canWrite} onSetPageProps={onSetPageProps} enableBleedLabel={enableBleedLabel} />
    </>
  )
}

// ---------------------------------------------------------------------------
// Bleed sub-controls
// ---------------------------------------------------------------------------

function BleedControls({ page, canWrite, onSetPageProps, enableBleedLabel = 'Show print bleed' }: { page: ScenePage; canWrite: boolean; onSetPageProps: PagePropsControlsProps['onSetPageProps']; enableBleedLabel?: string }) {
  const bleed = page.bleed

  function setBleedSide(side: keyof PageBleed, value: number) {
    const current = bleed ?? { top: 0, right: 0, bottom: 0, left: 0 }
    onSetPageProps({ bleed: { ...current, [side]: value } })
  }

  if (!bleed) {
    return (
      <button
        type="button"
        aria-label={enableBleedLabel}
        disabled={!canWrite}
        onClick={() => onSetPageProps({ bleed: { top: 3, right: 3, bottom: 3, left: 3 } })}
        className={BTN}
        title={enableBleedLabel}
      >
        <BleedGlyph className="h-3.5 w-3.5" />
      </button>
    )
  }

  return (
    <>
      {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
        <NumberInput
          key={side}
          label={`Bleed ${side[0]!.toUpperCase()}`}
          value={bleed[side]}
          min={0}
          onCommit={(v) => setBleedSide(side, v)}
          className="w-12"
        />
      ))}
      <button
        type="button"
        disabled={!canWrite}
        onClick={() => onSetPageProps({ bleed: null })}
        className={BTN}
        title="Remove bleed"
      >
        ×
      </button>
    </>
  )
}
