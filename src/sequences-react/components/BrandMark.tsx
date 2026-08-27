/**
 * Lazy boundary around the Tangle knot from `../../brand`.
 *
 * `/brand` re-exports the mark from `@tangle-network/sandbox-ui`, an OPT-IN peer
 * (see brand/index.tsx). Static-importing it would pull the peer into every
 * module that renders the timeline — breaking substrate-free environments (and
 * products that haven't installed the peer) at module-eval time. Code-splitting
 * it (the repo's `lazy.tsx` convention) keeps the peer out of the editor's
 * static graph: the knot streams in only when an empty/phone state actually
 * renders, and its absence degrades to empty space rather than a crash.
 */

import { lazy, Suspense } from 'react'
import type { ComponentType } from 'react'

export interface BrandMarkProps {
  size: number
  className?: string
}

/** Reserve the mark's footprint so its async arrival doesn't shift layout, and
 *  serve as the graceful fallback when the opt-in peer isn't installed. */
function MarkSpacer({ size }: { size: number }) {
  return <span aria-hidden style={{ display: 'inline-block', width: size, height: size }} />
}

// The peer (`@tangle-network/sandbox-ui`, behind `/brand`) is optional. A
// missing peer must degrade to reserved space, never crash the editor — so the
// dynamic import resolves to the spacer on rejection instead of letting
// Suspense throw the load error up through the timeline.
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
