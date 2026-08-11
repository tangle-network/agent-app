/**
 * Shared role dropdown for the teams panels — the popover-listbox pattern the
 * design system requires in place of a native `<select>` (same contract as the
 * design-canvas Toolbar's SelectControl: bordered trigger, chevron glyph, and a
 * `role="listbox"` panel on the L3 popover surface with click-outside /
 * Escape-to-close). Both panels assign from the same workspace-role set, so the
 * options live here too.
 */

import { useEffect, useRef, useState } from 'react'
import type { WorkspaceRole } from '../../teams/roles'

const ASSIGNABLE_ROLES: ReadonlyArray<{ value: WorkspaceRole; label: string }> = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'editor', label: 'Editor' },
  { value: 'admin', label: 'Admin' },
]

function ChevronDownGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

export interface RoleSelectProps {
  value: WorkspaceRole
  onChange(role: WorkspaceRole): void
  /** Accessible name (no visible label — the panels label the row). */
  ariaLabel: string
  disabled?: boolean
}

export function RoleSelect({ value, onChange, ariaLabel, disabled }: RoleSelectProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = ASSIGNABLE_ROLES.find((option) => option.value === value)

  useEffect(() => {
    if (!open) return
    function onDocPointer(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDocPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDocPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between gap-1.5 rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-2 py-1.5 text-xs text-[var(--text-secondary)] hover:border-[var(--brand-primary)] disabled:cursor-default disabled:opacity-40"
      >
        <span>{current?.label ?? value}</span>
        <ChevronDownGlyph className="h-3 w-3 text-[var(--text-muted)]" />
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className="absolute right-0 top-full z-50 mt-1 flex w-32 flex-col rounded border border-[var(--card-edge)] bg-[hsl(var(--popover))] py-1 shadow-[var(--shadow-overlay)]"
        >
          {ASSIGNABLE_ROLES.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
              className={`px-3 py-1.5 text-left text-xs hover:bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] ${
                option.value === value ? 'text-[var(--brand-primary)]' : 'text-[var(--text-primary)]'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
