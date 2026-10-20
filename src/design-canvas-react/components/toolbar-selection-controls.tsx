/** Attribute and structure controls for the selected scene elements. */
import { useState } from 'react'
import type { SceneElement, TextElement, RectElement, EllipseElement, ImageElement } from '../../design-canvas/model'
import type { SceneAttrsPatch } from '../../design-canvas/operations'
import { AlignCenterGlyph, AlignLeftGlyph, AlignRightGlyph, BoldGlyph, BringFrontGlyph, GroupGlyph, ItalicGlyph, LockGlyph, SendBackGlyph, SlotGlyph, SwapGlyph, TrashGlyph, UngroupGlyph, UnlockGlyph } from './glyphs'
import { BTN, BTN_ACTIVE } from './icon-button'
import { SEP, POPOVER_PANEL, FIELD_LABEL, Popover, NumberInput, SelectControl, FontPicker, ColorSwatch } from './toolbar-fields'

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

export function SelectionControls({
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
              className="rounded border border-[var(--border-default)] bg-transparent px-2 py-1 text-xs text-[var(--text-primary)] focus:border-[var(--brand-primary)]"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { onBindSlot(slotInput.trim() || null); setSlotPopoverOpen(false) }}
                className="flex-1 rounded border border-[var(--brand-primary)] px-2 py-0.5 text-xs text-[var(--brand-primary)] hover:bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)]"
              >
                {slotInput.trim() ? 'Bind' : 'Unbind'}
              </button>
              <button
                type="button"
                onClick={() => setSlotPopoverOpen(false)}
                className="rounded border border-[var(--border-default)] px-2 py-0.5 text-xs text-[var(--text-secondary)]"
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
      <ColorSwatch label="Stroke" value={element.stroke ?? '#000000'} onCommit={(v) => onPatch({ stroke: v })} disabled={!canWrite} none={(element.strokeWidth ?? 0) === 0} />
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
            className="rounded border border-[var(--border-default)] bg-transparent px-2 py-1 text-xs text-[var(--text-primary)] focus:border-[var(--brand-primary)]"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!swapUrl.trim() || swapUrl.trim() === element.src}
              onClick={() => { onPatch({ src: swapUrl.trim() }); setSwapOpen(false) }}
              className="flex-1 rounded border border-[var(--brand-primary)] px-2 py-0.5 text-xs text-[var(--brand-primary)] hover:bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] disabled:cursor-default disabled:opacity-40"
            >
              Replace
            </button>
            <button
              type="button"
              onClick={() => setSwapOpen(false)}
              className="rounded border border-[var(--border-default)] px-2 py-0.5 text-xs text-[var(--text-secondary)]"
            >
              Cancel
            </button>
          </div>
        </div>
      </Popover>
    </>
  )
}
