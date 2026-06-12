/**
 * React editor surface for the design-canvas module: seam contracts, the
 * command-stack editing engine, export utilities, the component set, and the
 * code-split `React.lazy` entry.
 *
 * Never re-exported from the package root — `react` and `konva` are optional
 * peers. Engine and export-math modules are import-safe in server bundles; DOM
 * and Konva access begins only inside component render calls.
 */
export * from './contracts'
export * from './engine/command-stack'
export * from './engine/commands'
export * from './engine/snap'
export * from './engine/selection'
export * from './engine/zoom-pan'
export * from './export-math'
export * from './export'
export * from './components/index'
export * from './lazy'
