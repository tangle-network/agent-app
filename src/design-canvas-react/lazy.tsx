/**
 * Lazy-loaded entry point for the design canvas editor. Products that do not
 * need the editor on initial load import `DesignCanvasLazy` instead of
 * `DesignCanvas` directly to keep it out of the critical bundle. The chunk
 * loads on first render; a Suspense boundary in the product provides the
 * fallback. `DesignCanvasFullProps` is re-exported for typed wiring.
 */

import { lazy } from 'react'
import type { DesignCanvasFullProps } from './components/DesignCanvas'

export type { DesignCanvasFullProps }

export const DesignCanvasLazy = lazy(
  () =>
    import('./components/DesignCanvas').then((m) => ({ default: m.DesignCanvas })),
)
