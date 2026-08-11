/**
 * Load the canonical Tangle knot only when an intakes surface renders it.
 * `/brand` imports the optional `@tangle-network/brand` peer, so a failed load
 * renders a fixed-size spacer instead of crashing the panel.
 */

import { lazy, Suspense } from 'react'
import type { ComponentType } from 'react'

export interface BrandMarkProps {
  size: number
  className?: string
}

/** Preserve the mark's footprint while its optional package loads or is absent. */
function MarkSpacer({ size }: { size: number }) {
  return <span aria-hidden style={{ display: 'inline-block', width: size, height: size }} />
}

const LazyKnot = lazy(async () => {
  try {
    const mod = await import('../../brand')
    return { default: mod.TangleKnot as ComponentType<BrandMarkProps> }
  } catch {
    return { default: MarkSpacer as ComponentType<BrandMarkProps> }
  }
})

export function BrandMark({ size, className }: BrandMarkProps) {
  return (
    <Suspense fallback={<MarkSpacer size={size} />}>
      <LazyKnot size={size} className={className} />
    </Suspense>
  )
}
