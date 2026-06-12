/**
 * Lazy-loaded entry points for the design canvas editor. Products that do not
 * need the editor on initial load import `DesignCanvasLazy` (the batteries-
 * included composition) or `DesignCanvasChromeLazy` (raw chrome only) instead
 * of importing the components directly. Each chunk loads on first render; a
 * Suspense boundary in the product provides the fallback.
 *
 * `DesignCanvasLazy` — `DesignCanvasEditor`: chrome + workspace sharing one
 *   command stack. This is what products mount.
 *
 * `DesignCanvasChromeLazy` — `DesignCanvas`: raw chrome with render-prop API.
 *   Use when the product supplies its own `renderWorkspace` and `renderThumbnail`.
 */

import { lazy } from 'react'
import type { DesignCanvasFullProps } from './components/DesignCanvas'
import type { DesignCanvasProps } from './contracts'

export type { DesignCanvasFullProps }
export type { DesignCanvasProps }

/** Batteries-included editor: chrome + workspace on one shared stack. */
export const DesignCanvasLazy = lazy(
  () =>
    import('./components/DesignCanvasEditor').then((m) => ({ default: m.DesignCanvasEditor })),
)

/** Raw chrome only — use when supplying a custom renderWorkspace/renderThumbnail. */
export const DesignCanvasChromeLazy = lazy(
  () =>
    import('./components/DesignCanvas').then((m) => ({ default: m.DesignCanvas })),
)
