/** Canvas toolbar fields: single-commit numbers and transient selection popovers. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDownGlyph } from './glyphs'

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

export const SEP = <div className="mx-1 h-5 w-px shrink-0 bg-[var(--border-default)]" />

export const POPOVER_PANEL =
  'absolute top-full left-0 z-50 mt-1 flex flex-col rounded border border-[var(--card-edge)] bg-[hsl(var(--popover))] shadow-[var(--shadow-overlay)]'

/**
 * Click-outside / Escape-to-close popover anchored under its trigger. The
 * trigger renders inside the relative wrapper so the panel positions against
 * it. `open`/`onClose` are owned by the caller so the trigger can stay a
 * stateful glyph button when needed.
 */
export function Popover({
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

export const FIELD_LABEL = 'text-xs font-semibold uppercase tracking-[0.05em] text-[var(--text-muted)]'

export function NumberInput({
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
        className={`${className} rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-1 py-0.5 text-center text-xs text-[var(--text-primary)] focus:border-[var(--brand-primary)]`}
      />
    </label>
  )
}

/**
 * Compact dropdown built on the popover pattern (replaces native <select>,
 * which the design system bans). Same value/onChange contract: `value` is the
 * current option id, `onChange` fires with the chosen id.
 */
export function SelectControl<T extends string>({
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
            className={`${buttonClassName} flex items-center justify-between gap-1 rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-2 py-0.5 text-left text-xs text-[var(--text-primary)] hover:border-[var(--brand-primary)] disabled:cursor-default disabled:opacity-40`}
          >
            <span className="truncate">{current?.label ?? value}</span>
            <ChevronDownGlyph className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
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
              className={`px-3 py-1 text-left text-xs hover:bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] ${
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
export function FontPicker({
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
            className="flex w-28 items-center justify-between gap-1 rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-2 py-0.5 text-left text-xs text-[var(--text-primary)] hover:border-[var(--brand-primary)] disabled:cursor-default disabled:opacity-40"
            style={{ fontFamily: value }}
          >
            <span className="truncate">{value}</span>
            <ChevronDownGlyph className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
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
            className="m-1 rounded border border-[var(--border-default)] bg-transparent px-2 py-1 text-xs text-[var(--text-primary)] focus:border-[var(--brand-primary)]"
          />
          <div role="listbox" className="max-h-60 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-[var(--text-muted)]">No matches</div>
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
                  className={`block w-full px-3 py-1 text-left text-sm hover:bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] ${
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
 * `none` renders the no-color idiom (white swatch with a diagonal slash) for
 * values that are set but not in effect — e.g. a stroke whose width is 0.
 */
export function ColorSwatch({ label, value, onCommit, disabled, none = false }: { label: string; value: string; onCommit(v: string): void; disabled?: boolean; none?: boolean }) {
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
            aria-label={none ? `${label} color (none)` : `${label} color`}
            title={none ? 'None' : undefined}
            onClick={() => setOpen((v) => !v)}
            className="relative h-6 w-10 overflow-hidden rounded border border-[var(--border-default)] disabled:cursor-default disabled:opacity-40"
            style={{ backgroundColor: none ? '#ffffff' : normalized }}
          >
            {none ? (
              <svg className="absolute inset-0 h-full w-full" viewBox="0 0 40 24" preserveAspectRatio="none" aria-hidden>
                <line x1="1" y1="23" x2="39" y2="1" stroke="var(--text-danger)" strokeWidth="1.5" />
              </svg>
            ) : null}
          </button>
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
            className="rounded border border-[var(--border-default)] bg-transparent px-2 py-1 text-xs text-[var(--text-primary)] focus:border-[var(--brand-primary)]"
          />
        </div>
      </Popover>
    </div>
  )
}
