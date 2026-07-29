/**
 * Tangle brand components for Agent App surfaces.
 *
 * The visual mark stays owned by `@tangle-network/brand`; this module only
 * preserves Agent App's existing `Logo` properties and supplies `BrandHeader`.
 *
 *   import { Logo, TangleKnot, BrandHeader } from '@tangle-network/agent-app/brand'
 */
import {
  Logo as CanonicalLogo,
  TangleKnot,
} from '@tangle-network/brand'
import type { ReactNode } from 'react'

/** Render the canonical, theme-independent Tangle knot mark. */
export { TangleKnot }

/** Define properties to customize the logo variant, size, style, and icon display options. */
export interface LogoProps {
  /** Preserved for compatibility; the canonical Tangle lockup is used. */
  variant?: 'sandbox'
  size?: 'sm' | 'md' | 'lg' | 'xl'
  className?: string
  /** Render the knot mark alone, without the wordmark. */
  iconOnly?: boolean
}

/** Render the canonical Tangle lockup through Agent App's existing API. */
export function Logo({
  variant = 'sandbox',
  size = 'md',
  className,
  iconOnly = false,
}: LogoProps) {
  void variant
  return (
    <CanonicalLogo
      size={size}
      variant={iconOnly ? 'icon' : 'full'}
      className={className}
    />
  )
}

/** Define properties for a brand header including optional title, children, and CSS class name. */
export interface BrandHeaderProps {
  /** Product name rendered next to the knot. Omit for a mark-only header. */
  title?: string
  /** Right-aligned slot for nav, actions, theme toggles. */
  children?: ReactNode
  className?: string
}

/** Shared app-shell header with the canonical Tangle mark. */
export function BrandHeader({ title, children, className }: BrandHeaderProps) {
  return (
    <header
      className={`flex shrink-0 items-center gap-3 border-b border-border bg-card px-4 py-2${
        className ? ` ${className}` : ''
      }`}
    >
      <span className="flex items-center gap-2">
        <TangleKnot size={24} className="shrink-0" />
        {title ? <span className="text-sm font-semibold text-foreground">{title}</span> : null}
      </span>
      {children ? <div className="flex flex-1 items-center justify-end gap-1">{children}</div> : null}
    </header>
  )
}
