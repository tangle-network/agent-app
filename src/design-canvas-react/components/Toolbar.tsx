/**
 * Selection-aware toolbar. When elements are selected it shows per-kind
 * attribute controls; when nothing is selected it shows page-props controls.
 * Every number input commits on blur or Enter as a single command (not
 * per-keystroke). The toolbar is stateless beyond transient input focus;
 * the caller owns the command stack.
 */

import { useRef, useState } from 'react'
import type { SceneElement, ScenePage, TextElement, RectElement, EllipseElement, ImageElement } from '../../design-canvas/model'
import type { SceneAttrsPatch } from '../../design-canvas/operations'
import type { PageBleed } from '../../design-canvas/model'
import { matchPreset, SIZE_PRESETS } from '../../design-canvas/export-presets'
import {
  AlignCenterGlyph,
  AlignLeftGlyph,
  AlignRightGlyph,
  BleedGlyph,
  BoldGlyph,
  BringFrontGlyph,
  DuplicateGlyph,
  FitGlyph,
  GridGlyph,
  GroupGlyph,
  ItalicGlyph,
  LockGlyph,
  MagnetGlyph,
  RedoGlyph,
  RulerGlyph,
  SendBackGlyph,
  SlotGlyph,
  TrashGlyph,
  UndoGlyph,
  UngroupGlyph,
  UnlockGlyph,
} from './glyphs'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolbarProps {
  page: ScenePage
  selectedElements: SceneElement[]
  canWrite: boolean
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
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const BTN =
  'flex h-7 w-7 items-center justify-center rounded border border-[var(--border-default)] text-[var(--text-secondary)] transition hover:text-[var(--text-primary)] disabled:cursor-default disabled:opacity-40'

const BTN_ACTIVE = `${BTN} border-[var(--brand-primary)] text-[var(--brand-primary)] hover:text-[var(--brand-primary)]`

const SEP = <div className="mx-1 h-5 w-px bg-[var(--border-default)]" />

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
      <span className="text-[9px] uppercase tracking-wide text-[var(--text-muted)]">{label}</span>
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

function ColorSwatch({ label, value, onCommit }: { label: string; value: string; onCommit(v: string): void }) {
  return (
    <label className="flex flex-col items-center gap-0.5 cursor-pointer">
      <span className="text-[9px] uppercase tracking-wide text-[var(--text-muted)]">{label}</span>
      <input
        type="color"
        value={value.startsWith('#') ? value : '#ffffff'}
        onChange={(event) => onCommit(event.target.value)}
        className="h-6 w-10 cursor-pointer rounded border border-[var(--border-default)] p-0.5"
      />
    </label>
  )
}

// ---------------------------------------------------------------------------
// Main toolbar
// ---------------------------------------------------------------------------

export function Toolbar({
  page,
  selectedElements,
  canWrite,
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

  // ----

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 overflow-x-auto border-b border-[var(--border-default)] bg-[var(--bg-input)] px-3">
      {/* Undo / Redo */}
      <button type="button" aria-label="Undo" disabled={!canUndo || !canWrite} onClick={onUndo} className={BTN}>
        <UndoGlyph className="h-3.5 w-3.5" />
      </button>
      <button type="button" aria-label="Redo" disabled={!canRedo || !canWrite} onClick={onRedo} className={BTN}>
        <RedoGlyph className="h-3.5 w-3.5" />
      </button>

      {SEP}

      {/* View toggles */}
      <button type="button" aria-label="Toggle rulers" aria-pressed={showRulers} onClick={onToggleRulers} className={showRulers ? BTN_ACTIVE : BTN}>
        <RulerGlyph className="h-3.5 w-3.5" />
      </button>
      <button type="button" aria-label="Toggle grid" aria-pressed={gridEnabled} onClick={onToggleGrid} className={gridEnabled ? BTN_ACTIVE : BTN}>
        <GridGlyph className="h-3.5 w-3.5" />
      </button>
      <button type="button" aria-label="Toggle snap" aria-pressed={snapEnabled} onClick={onToggleSnap} className={snapEnabled ? BTN_ACTIVE : BTN}>
        <MagnetGlyph className="h-3.5 w-3.5" />
      </button>
      <button type="button" aria-label="Toggle bleed overlay" aria-pressed={showBleed} onClick={onToggleBleed} className={showBleed ? BTN_ACTIVE : BTN} disabled={!page.bleed}>
        <BleedGlyph className="h-3.5 w-3.5" />
      </button>

      {SEP}

      {hasSelection ? (
        <SelectionControls
          elements={selectedElements}
          single={single}
          isGroup={isGroup}
          groupable={groupable}
          allSameKind={allSameKind}
          firstKind={firstKind}
          canWrite={canWrite}
          patchAll={patchAll}
          reorderSingle={reorderSingle}
          onGroup={() => onGroup(selectedIds)}
          onUngroup={() => { if (single) onUngroup(single.id) }}
          onDelete={() => onDelete(selectedIds)}
          onBindSlot={single ? (slot) => onBindSlot(single.id, slot) : undefined}
          currentSlot={single?.slot ?? null}
        />
      ) : (
        <PagePropsControls
          page={page}
          canWrite={canWrite}
          onSetPageProps={onSetPageProps}
          onSetPageGuides={onSetPageGuides}
        />
      )}
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
          disabled={!canWrite}
          onClick={() => patchAll({ locked: !single.locked })}
          className={single.locked ? BTN_ACTIVE : BTN}
        >
          {single.locked ? <LockGlyph className="h-3.5 w-3.5" /> : <UnlockGlyph className="h-3.5 w-3.5" />}
        </button>
      ) : null}

      {/* Slot binding (single element only) */}
      {single && onBindSlot ? (
        <div className="relative">
          <button
            type="button"
            aria-label={currentSlot ? `Slot: ${currentSlot}` : 'Bind slot'}
            onClick={() => { setSlotInput(currentSlot ?? ''); setSlotPopoverOpen((v) => !v) }}
            className={currentSlot ? BTN_ACTIVE : BTN}
            title={currentSlot ? `Slot: ${currentSlot}` : 'Bind slot'}
          >
            <SlotGlyph className="h-3.5 w-3.5" />
          </button>
          {slotPopoverOpen ? (
            <div className="absolute top-full left-0 z-50 mt-1 flex w-48 flex-col gap-2 rounded border border-[var(--border-default)] bg-[var(--bg-input)] p-2 shadow-lg">
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
          ) : null}
        </div>
      ) : null}

      {SEP}

      {/* Delete */}
      <button type="button" aria-label="Delete selection" disabled={!canWrite} onClick={onDelete} className={BTN}>
        <TrashGlyph className="h-3.5 w-3.5 text-rose-400" />
      </button>
    </>
  )
}

// ---------------------------------------------------------------------------
// Kind-specific controls
// ---------------------------------------------------------------------------

function TextControls({ element, canWrite, onPatch }: { element: TextElement; canWrite: boolean; onPatch(attrs: SceneAttrsPatch): void }) {
  return (
    <>
      <input
        type="text"
        aria-label="Font family"
        value={element.fontFamily}
        disabled={!canWrite}
        onChange={(event) => onPatch({ fontFamily: event.target.value })}
        className="w-28 rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-2 py-0.5 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--brand-primary)]"
        placeholder="Font"
      />
      <NumberInput label="Size" value={element.fontSize} min={1} onCommit={(v) => onPatch({ fontSize: v })} className="w-12" />
      <button
        type="button"
        aria-label="Bold"
        disabled={!canWrite}
        onClick={() => onPatch({ fontStyle: element.fontStyle === 'bold' || element.fontStyle === 'bold italic' ? (element.fontStyle === 'bold italic' ? 'italic' : 'normal') : (element.fontStyle === 'italic' ? 'bold italic' : 'bold') })}
        className={element.fontStyle?.includes('bold') ? BTN_ACTIVE : BTN}
      >
        <BoldGlyph className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label="Italic"
        disabled={!canWrite}
        onClick={() => onPatch({ fontStyle: element.fontStyle === 'italic' || element.fontStyle === 'bold italic' ? (element.fontStyle === 'bold italic' ? 'bold' : 'normal') : (element.fontStyle === 'bold' ? 'bold italic' : 'italic') })}
        className={element.fontStyle?.includes('italic') ? BTN_ACTIVE : BTN}
      >
        <ItalicGlyph className="h-3.5 w-3.5" />
      </button>
      {(['left', 'center', 'right'] as const).map((align) => (
        <button
          key={align}
          type="button"
          aria-label={`Align ${align}`}
          disabled={!canWrite}
          onClick={() => onPatch({ align })}
          className={element.align === align ? BTN_ACTIVE : BTN}
        >
          {align === 'left' ? <AlignLeftGlyph className="h-3.5 w-3.5" /> : align === 'center' ? <AlignCenterGlyph className="h-3.5 w-3.5" /> : <AlignRightGlyph className="h-3.5 w-3.5" />}
        </button>
      ))}
      <NumberInput label="Line H" value={element.lineHeight} step={0.1} min={0.5} onCommit={(v) => onPatch({ lineHeight: v })} className="w-12" />
      <NumberInput label="Spacing" value={element.letterSpacing} step={0.5} onCommit={(v) => onPatch({ letterSpacing: v })} className="w-14" />
      <ColorSwatch label="Fill" value={element.fill} onCommit={(v) => onPatch({ fill: v })} />
    </>
  )
}

function ShapeControls({ element, canWrite, onPatch, showCornerRadius }: { element: RectElement | EllipseElement; canWrite: boolean; onPatch(attrs: SceneAttrsPatch): void; showCornerRadius: boolean }) {
  return (
    <>
      <ColorSwatch label="Fill" value={element.fill} onCommit={(v) => onPatch({ fill: v })} />
      <ColorSwatch label="Stroke" value={element.stroke ?? '#000000'} onCommit={(v) => onPatch({ stroke: v })} />
      <NumberInput label="Stroke W" value={element.strokeWidth ?? 0} min={0} onCommit={(v) => onPatch({ strokeWidth: v })} className="w-14" />
      {showCornerRadius && 'cornerRadius' in element ? (
        <NumberInput label="Corner R" value={(element as RectElement).cornerRadius ?? 0} min={0} onCommit={(v) => onPatch({ cornerRadius: v })} className="w-14" />
      ) : null}
    </>
  )
}

function ImageControls({ element, canWrite, onPatch }: { element: ImageElement; canWrite: boolean; onPatch(attrs: SceneAttrsPatch): void }) {
  return (
    <label className="flex flex-col items-center gap-0.5">
      <span className="text-[9px] uppercase tracking-wide text-[var(--text-muted)]">Fit</span>
      <select
        value={element.fit}
        disabled={!canWrite}
        onChange={(event) => onPatch({ fit: event.target.value as ImageElement['fit'] })}
        className="rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-1 py-0.5 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--brand-primary)]"
      >
        <option value="fill">Fill</option>
        <option value="cover">Cover</option>
        <option value="contain">Contain</option>
      </select>
    </label>
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
}

function PagePropsControls({ page, canWrite, onSetPageProps, onSetPageGuides }: PagePropsControlsProps) {
  const matchedPreset = matchPreset(page.width, page.height)
  const [customW, setCustomW] = useState<string | null>(null)
  const [customH, setCustomH] = useState<string | null>(null)

  function commitDimension(dim: 'width' | 'height', raw: string) {
    const v = parseFloat(raw)
    if (Number.isFinite(v) && v > 0) onSetPageProps({ [dim]: v })
    if (dim === 'width') setCustomW(null)
    else setCustomH(null)
  }

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
      <label className="flex flex-col items-center gap-0.5">
        <span className="text-[9px] uppercase tracking-wide text-[var(--text-muted)]">Preset</span>
        <select
          value={matchedPreset?.id ?? 'custom'}
          disabled={!canWrite}
          onChange={(event) => {
            const preset = SIZE_PRESETS.find((p) => p.id === event.target.value)
            if (preset) onSetPageProps({ width: preset.width, height: preset.height })
          }}
          className="rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-1 py-0.5 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--brand-primary)]"
        >
          <option value="custom">Custom</option>
          {SIZE_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </label>

      {/* Custom W × H */}
      <label className="flex flex-col items-center gap-0.5">
        <span className="text-[9px] uppercase tracking-wide text-[var(--text-muted)]">W</span>
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
        <span className="text-[9px] uppercase tracking-wide text-[var(--text-muted)]">H</span>
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

      <ColorSwatch label="BG" value={page.background} onCommit={(v) => onSetPageProps({ background: v })} />

      {SEP}

      {/* Bleed controls */}
      <BleedControls page={page} canWrite={canWrite} onSetPageProps={onSetPageProps} />
    </>
  )
}

// ---------------------------------------------------------------------------
// Bleed sub-controls
// ---------------------------------------------------------------------------

function BleedControls({ page, canWrite, onSetPageProps }: { page: ScenePage; canWrite: boolean; onSetPageProps: PagePropsControlsProps['onSetPageProps'] }) {
  const bleed = page.bleed

  function setBleedSide(side: keyof PageBleed, value: number) {
    const current = bleed ?? { top: 0, right: 0, bottom: 0, left: 0 }
    onSetPageProps({ bleed: { ...current, [side]: value } })
  }

  if (!bleed) {
    return (
      <button
        type="button"
        disabled={!canWrite}
        onClick={() => onSetPageProps({ bleed: { top: 3, right: 3, bottom: 3, left: 3 } })}
        className={BTN}
        title="Enable bleed"
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
