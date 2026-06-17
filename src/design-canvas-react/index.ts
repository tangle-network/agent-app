/**
 * React editor surface for the design-canvas module. The package root bundles
 * the FULL editor (Konva renderer included). Two lighter subpaths exist so
 * consumers import only what they need without the ~1.3 MB Konva renderer
 * landing in their main bundle:
 *   - `./design-canvas-react/engine` — the konva-free core (contracts, command
 *     stack, snap/zoom/selection + export math, insert builders).
 *   - `./design-canvas-react/lazy` — `React.lazy` handles that keep the Konva
 *     editor in an async chunk, out of the host's main bundle.
 *
 * Never re-exported from the package root barrel — `react` and `konva` are
 * optional peers; DOM and Konva access begins only inside component render.
 */
export * from './engine'
export * from './export'
export * from './components/index'
export * from './lazy'
