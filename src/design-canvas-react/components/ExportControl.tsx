/**
 * Compact Export control for the editor chrome's top-right slot. A single
 * button opens a small popover to choose format (PNG/JPEG) and scale (1x/2x);
 * confirming calls `onExport({ format, pixelRatio })`.
 *
 * The chrome is Konva-free, so this control does NOT render the image — it only
 * collects the format/scale and delegates to the workspace (which owns the
 * stage) via the callback the DesignCanvas shell wires through `onExportRef`.
 *
 * Tokens/glyphs follow the canvas convention: CSS-var design tokens and inline
 * SVG glyphs, no icon-library or browser-default `<select>`.
 */

import { useRef, useState } from 'react'
import type { ExportTriggerOptions } from '../contracts'
import { ChevronDownGlyph, ExportGlyph } from './glyphs'

export interface ExportControlProps {
  /** Pre-selected format/scale when the popover opens. Default PNG @ 1x. */
  defaults?: ExportTriggerOptions
  /** Called with the chosen format/scale when the user confirms. */
  onExport(opts: ExportTriggerOptions): void
  className?: string
}

const FORMATS: ReadonlyArray<{ id: 'png' | 'jpeg'; label: string }> = [
  { id: 'png', label: 'PNG' },
  { id: 'jpeg', label: 'JPEG' },
]

const SCALES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1, label: '1x' },
  { value: 2, label: '2x' },
]

export function ExportControl({ defaults, onExport, className }: ExportControlProps) {
  const [open, setOpen] = useState(false)
  const [format, setFormat] = useState<'png' | 'jpeg'>(defaults?.format ?? 'png')
  const [pixelRatio, setPixelRatio] = useState<number>(defaults?.pixelRatio ?? 1)
  const containerRef = useRef<HTMLDivElement>(null)

  function confirm() {
    onExport({ format, pixelRatio })
    setOpen(false)
  }

  return (
    <div ref={containerRef} className={`relative ${className ?? ''}`}>
      <button
        type="button"
        aria-label="Export"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        // Close the popover when focus leaves the whole control (click-away /
        // tab-away) — but not when moving between the control's own children.
        onBlur={(event) => {
          if (!containerRef.current?.contains(event.relatedTarget as Node | null)) {
            setOpen(false)
          }
        }}
        className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--border-default)] px-2.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--brand-primary)]/40"
      >
        <ExportGlyph className="h-3.5 w-3.5" />
        Export
        <ChevronDownGlyph className="h-3 w-3 text-[var(--text-muted)]" />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Export options"
          onBlur={(event) => {
            if (!containerRef.current?.contains(event.relatedTarget as Node | null)) {
              setOpen(false)
            }
          }}
          className="absolute right-0 top-full z-50 mt-1 flex w-52 flex-col gap-3 rounded-md border border-[var(--border-default)] bg-[var(--bg-input)] p-3 shadow-lg"
        >
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-[var(--text-muted)]">Format</span>
            <div className="flex gap-1.5">
              {FORMATS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={format === f.id}
                  onClick={() => setFormat(f.id)}
                  className={`flex-1 rounded border px-2 py-1 text-[11px] transition-colors ${
                    format === f.id
                      ? 'border-[var(--brand-primary)] text-[var(--brand-primary)]'
                      : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-[var(--text-muted)]">Scale</span>
            <div className="flex gap-1.5">
              {SCALES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  aria-pressed={pixelRatio === s.value}
                  onClick={() => setPixelRatio(s.value)}
                  className={`flex-1 rounded border px-2 py-1 text-[11px] transition-colors ${
                    pixelRatio === s.value
                      ? 'border-[var(--brand-primary)] text-[var(--brand-primary)]'
                      : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            aria-label="Export image"
            onClick={confirm}
            className="rounded border border-[var(--brand-primary)] px-2 py-1 text-[11px] font-medium text-[var(--brand-primary)] transition-colors hover:bg-[var(--brand-primary)]/10"
          >
            Export
          </button>
        </div>
      ) : null}
    </div>
  )
}
