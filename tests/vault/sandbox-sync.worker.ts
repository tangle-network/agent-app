// The production shape of a workspace Vault coordinator: agent-app's
// coordinator hosted in a Durable Object over that object's own storage and the
// Vault KV. The sync engine test bundles this with Wrangler and runs it in workerd.
import type { KVStore } from '../../src/store'
import { createVaultCoordinator, type VaultCoordinatorStorage } from '../../src/vault/store/coordinator'

interface Env { VAULT_KV: KVStore }

export class VaultCoordinatorDO {
  private readonly coordinator: ReturnType<typeof createVaultCoordinator>
  private readonly storage: VaultCoordinatorStorage

  constructor(state: { storage: unknown }, env: Env) {
    this.storage = state.storage as unknown as VaultCoordinatorStorage
    this.coordinator = createVaultCoordinator({ storage: this.storage, kv: env.VAULT_KV })
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    // Test seam: store a box state as a request that died mid-mutation would have left it.
    if (pathname === '/test/box-state') {
      await this.storage.put('vaultBoxState', await request.json())
      return new Response(null, { status: 204 })
    }
    // Test seam: the serialized size of each stored baseline value. Miniflare does not
    // enforce the production per-value limit, so the test reads the layout it stored.
    if (pathname === '/test/baseline-values') {
      const values = await this.storage.list<unknown>({ prefix: 'vaultBaseline' })
      return Response.json(Object.fromEntries([...values].map(([key, value]) => [key, JSON.stringify(value).length])))
    }
    return await this.coordinator.handle(request) ?? new Response('Not found', { status: 404 })
  }
}

export default {
  fetch(): Response {
    return new Response('Vault coordinator fixture')
  },
}
