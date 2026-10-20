/** Page dimensions, background, and print bleed controls. */
import { useState } from 'react'
import type { ScenePage, PageBleed } from '../../design-canvas/model'
import { matchPreset, SIZE_PRESETS } from '../../design-canvas/export-presets'
import { BleedGlyph } from './glyphs'
import { BTN, BTN_ACTIVE } from './icon-button'
import { SEP, FIELD_LABEL, NumberInput, SelectControl, ColorSwatch } from './toolbar-fields'

interface PagePropsControlsProps {
  page: ScenePage
  canWrite: boolean
  onSetPageProps(props: { name?: string; width?: number; height?: number; background?: string; bleed?: PageBleed | null }): void
  onSetPageGuides(guides: { vertical: number[]; horizontal: number[] }): void
  pageSizeLabel?: string
  enableBleedLabel?: string
}

export function PagePropsControls({ page, canWrite, onSetPageProps, onSetPageGuides, pageSizeLabel = 'Page size', enableBleedLabel = 'Show print bleed' }: PagePropsControlsProps) {
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
        className="w-28 rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-2 py-0.5 text-xs text-[var(--text-primary)] focus:border-[var(--brand-primary)] disabled:cursor-default disabled:opacity-40"
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
        // Preset labels run long ("US Letter Landscape") — w-24 truncates them
        // to "Instagram …"; w-44 matches the listbox width and fits them all.
        buttonClassName="w-44"
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
          className="w-16 rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-1 py-0.5 text-center text-xs text-[var(--text-primary)] focus:border-[var(--brand-primary)] disabled:cursor-default disabled:opacity-40"
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
          className="w-16 rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-1 py-0.5 text-center text-xs text-[var(--text-primary)] focus:border-[var(--brand-primary)] disabled:cursor-default disabled:opacity-40"
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
          label={side[0]!.toUpperCase() + side.slice(1)}
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
        title="Remove print bleed"
        aria-label="Remove print bleed"
      >
        ×
      </button>
    </>
  )
}
