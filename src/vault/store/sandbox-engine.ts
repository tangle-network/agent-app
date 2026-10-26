/**
 * The box↔Vault sync engine a product binds once: hydrate the workspace Vault
 * into a box, reconcile what the box changed back into the Vault, and detect a
 * box that lost its Vault directory. Products supply their Vault store and the
 * box directory; the engine owns the baseline, the manifest diff, conflict
 * parking, rename-only deletes and the request-size limits.
 */
import { hydrateSandboxVault, type VaultHydrationBox, type VaultHydrationOptions } from './sandbox-hydrate'
import {
  assertSandboxVaultReconciliation,
  probeSandboxVaultLoss,
  reconcileSandboxVault,
  type SandboxVaultSyncOptions,
  type VaultReconcileBox,
} from './sandbox-reconcile'
import type { SandboxVaultSyncConfig } from './sandbox-sync'

/** Bind the sync engine to a product's Vault store and box directory. */
export function createSandboxVaultSync(config: SandboxVaultSyncConfig) {
  return {
    root: config.root,
    hydrate: (box: VaultHydrationBox, workspaceId: string, options?: VaultHydrationOptions) =>
      hydrateSandboxVault(config, box, workspaceId, options),
    reconcile: (box: VaultReconcileBox, workspaceId: string, options?: SandboxVaultSyncOptions) =>
      reconcileSandboxVault(config, box, workspaceId, options),
    probeLoss: (box: VaultReconcileBox, workspaceId: string) => probeSandboxVaultLoss(config, box, workspaceId),
    assertReconciliation: assertSandboxVaultReconciliation,
  }
}

export type SandboxVaultSync = ReturnType<typeof createSandboxVaultSync>
