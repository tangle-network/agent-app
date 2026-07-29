/**
 * Load the canonical Tangle knot only when a canvas surface renders it.
 * `/brand` imports the optional `@tangle-network/brand` peer, so a failed load
 * renders a fixed-size spacer instead of crashing the editor.
 */

import { lazy, Suspense } from 'react'
import type { ComponentType } from 'react'

interface BrandKnotProps {
  size?: number
  className?: string
}

function MarkSpacer({ size = 24, className }: BrandKnotProps) {
  return <span aria-hidden style={{ display: 'inline-block', width: size, height: size }} className={className} />
}

const LazyKnot = lazy(async () => {
  try {
    const mod = await import('../../brand')
    return { default: mod.TangleKnot as ComponentType<BrandKnotProps> }
  } catch {
    return { default: MarkSpacer as ComponentType<BrandKnotProps> }
  }
})

export function BrandKnot({ size = 24, className }: BrandKnotProps) {
  return (
    <Suspense fallback={<MarkSpacer size={size} className={className} />}>
      <LazyKnot size={size} className={className} />
    </Suspense>
  )
}
