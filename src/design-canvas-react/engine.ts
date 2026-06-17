/**
 * Konva-free core of the design-canvas editor: seam contracts, the command-stack
 * editing engine, snap/zoom/selection geometry, export math, and insert builders.
 *
 * Import this subpath (`@tangle-network/agent-app/design-canvas-react/engine`)
 * to drive, inspect, or test a scene WITHOUT pulling the Konva renderer (~1.3 MB
 * of `konva`/`react-konva`) into the bundle — server-side layout, custom
 * renderers, headless tooling, and unit tests. The full editor lives at the
 * package root; the code-split handles live at `./design-canvas-react/lazy`.
 *
 * Invariant: nothing re-exported here may import `konva`/`react-konva` or touch
 * the DOM — that is what keeps the subpath shakeable. Adding a Konva import to
 * any of these modules silently reattaches the renderer to every engine consumer.
 */
export * from './contracts'
export * from './engine/command-stack'
export * from './engine/commands'
export * from './engine/snap'
export * from './engine/selection'
export * from './engine/zoom-pan'
export * from './export-math'
export * from './insert-builders'
