/**
 * Lazy Tangle knot for the canvas surfaces.
 *
 * The brand mark lives in `../../brand`, which re-exports `TangleKnot` from the
 * `@tangle-network/sandbox-ui` barrel — a heavy, opt-in peer. Importing it
 * statically would drag that whole chain into the eagerly-evaluated canvas
 * module graph (Workspace / DesignCanvasEditor), which must stay importable in
 * environments that don't have the peer wired (SSR, tests). Pulling the mark
 * through a dynamic `import()` behind Suspense keeps the dependency lazy — the
 * same reason `lazy.tsx` defers the Konva editor chunk — so module-load stays
 * dependency-light and the mark resolves only when a surface actually renders it.
 */

import { lazy, Suspense } from 'react'

const LazyKnot = lazy(() => import('../../brand').then((m) => ({ default: m.TangleKnot })))

export interface BrandKnotProps {
  size?: number
  className?: string
}

export function BrandKnot({ size = 24, className }: BrandKnotProps) {
  return (
    <Suspense fallback={<span aria-hidden style={{ display: 'inline-block', width: size, height: size }} className={className} />}>
      <LazyKnot size={size} className={className} />
    </Suspense>
  )
}
