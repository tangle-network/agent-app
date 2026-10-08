/**
 * `@tangle-network/agent-app/vault` — the shared 3-pane VaultPane (tree |
 * artifact viewer | optional agent dock) every Tangle agent product otherwise
 * hand-rolls: selection, the dirty-guard state machine, rich/source editor
 * modes, create/delete, skeletons, an error boundary, and the vault's file tree
 * (`VaultTree`, owned by `@tangle-network/sandbox-ui/vault-tree` and re-exported here). The product supplies the data (`VaultDataPort`) and the artifact
 * renderer; the pane imports no artifact viewer and no dialog library.
 *
 * Never re-exported from the package root barrel — `react` is an optional peer
 * and DOM access begins only inside component render. A `React.lazy` code-split
 * entry lives at `./vault/lazy`.
 */
export * from './contracts'
export { VaultPane } from './VaultPane'
export { VaultTree, VAULT_TREE_CHILD_PAGE, type VaultTreeProps } from '@tangle-network/sandbox-ui/vault-tree'
export { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog'
