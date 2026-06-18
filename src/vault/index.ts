/**
 * `@tangle-network/agent-app/vault` — the shared 3-pane VaultPane (tree |
 * artifact viewer | optional agent dock) every Tangle agent product otherwise
 * hand-rolls. Pure shell mechanism: selection, the dirty-guard state machine,
 * rich/source editor modes, create/delete, skeletons, and an error boundary.
 * The product supplies the data (`VaultDataPort`) and the renderers; the pane
 * imports no file tree, no artifact viewer, and no dialog library.
 *
 * Never re-exported from the package root barrel — `react` is an optional peer
 * and DOM access begins only inside component render. A `React.lazy` code-split
 * entry lives at `./vault/lazy`.
 */
export * from './contracts'
export { VaultPane } from './VaultPane'
export { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog'
