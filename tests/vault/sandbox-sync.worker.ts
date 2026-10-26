// The production shape of a workspace Vault coordinator: agent-app's
// coordinator hosted in a Durable Object over that object's own storage and the
// Vault KV. The sync engine test bundles this with Wrangler and runs it in workerd.
import type { KVStore } from '../../src/store'
import { createVaultCoordinator, type VaultCoordinatorStorage } from '../../src/vault/store/coordinator'

interface Env { VAULT_KV: KVStore }

export class VaultCoordinatorDO {
  private readonly coordinator: ReturnType<typeof createVaultCoordinator>

  constructor(state: { storage: unknown }, env: Env) {
    this.coordinator = createVaultCoordinator({
      storage: state.storage as unknown as VaultCoordinatorStorage,
      kv: env.VAULT_KV,
    })
  }

  async fetch(request: Request): Promise<Response> {
    return await this.coordinator.handle(request) ?? new Response('Not found', { status: 404 })
  }
}

export default {
  fetch(): Response {
    return new Response('Vault coordinator fixture')
  },
}
