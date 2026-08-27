/**
 * Shared icon-button contract for the canvas chrome (Toolbar, ZoomControls,
 * PagesStrip). One definition so the focus ring, disabled affordance, and
 * active state can never drift between surfaces.
 *
 * The focus ring uses the `--ring` token (defined in src/theme/tokens.css) and
 * is keyboard-only (`focus-visible`) so mouse clicks don't draw a ring.
 */

import { forwardRef } from 'react'
import type { ButtonHTMLAttributes } from 'react'

const BTN_BASE =
  'items-center justify-center rounded border border-[var(--border-default)] text-[var(--text-secondary)] transition hover:text-[var(--text-primary)] focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg-input)] disabled:cursor-default disabled:opacity-40'

const BTN_ACTIVE_EXTRA =
  ' border-[var(--brand-primary)] text-[var(--brand-primary)] hover:text-[var(--brand-primary)]'

/** 28px square (h-7) — used by the main toolbar. */
export const BTN = `flex h-7 w-7 ${BTN_BASE}`
export const BTN_ACTIVE = BTN + BTN_ACTIVE_EXTRA

/** 24px square (h-6) — used by the zoom controls and pages strip. */
export const BTN_SM = `flex h-6 w-6 ${BTN_BASE}`
export const BTN_SM_ACTIVE = BTN_SM + BTN_ACTIVE_EXTRA

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Render the active (brand-colored) variant. */
  active?: boolean
  /** 'md' = 28px (toolbar), 'sm' = 24px (zoom/pages). */
  size?: 'md' | 'sm'
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { active = false, size = 'md', className = '', type = 'button', ...rest },
  ref,
) {
  const base = size === 'sm' ? (active ? BTN_SM_ACTIVE : BTN_SM) : active ? BTN_ACTIVE : BTN
  return <button ref={ref} type={type} className={className ? `${base} ${className}` : base} {...rest} />
})
