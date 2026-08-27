/**
 * Lazy boundary around the Tangle knot from `../brand`.
 *
 * `/brand` re-exports the mark from `@tangle-network/sandbox-ui`, an OPT-IN
 * peer. Static-importing it here would pull that peer into the eagerly-evaluated
 * `web-react` graph — breaking the dependency-light contract this module relies
 * on (it must import cleanly in environments, and tests, that haven't installed
 * the peer). Code-splitting keeps the peer out of the static graph: the knot
 * streams in only when a branded surface actually renders, and a missing peer
 * degrades to reserved space rather than crashing the chat shell.
 */

import { lazy, Suspense } from 'react'
import type { ComponentType } from 'react'

export interface BrandMarkProps {
  size?: number
  className?: string
}

/** Reserve the mark's footprint so its async arrival doesn't shift layout, and
 *  serve as the graceful fallback when the opt-in peer isn't installed. */
function MarkSpacer({ size = 24, className }: BrandMarkProps) {
  return <span aria-hidden style={{ display: 'inline-block', width: size, height: size }} className={className} />
}

const LazyKnot = lazy(async () => {
  try {
    const mod = await import('../brand')
    return { default: mod.TangleKnot as ComponentType<BrandMarkProps> }
  } catch {
    return { default: MarkSpacer as ComponentType<BrandMarkProps> }
  }
})

export function BrandMark({ size = 24, className }: BrandMarkProps) {
  return (
    <Suspense fallback={<MarkSpacer size={size} className={className} />}>
      <LazyKnot size={size} className={className} />
    </Suspense>
  )
}
