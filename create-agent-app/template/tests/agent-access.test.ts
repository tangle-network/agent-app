import { describe, expect, it } from 'vitest'
import worker, { createWorker } from '../src/worker'
import type { AppBindings } from '../src/agent-app'

const env = {} as AppBindings

describe('headless external-agent boundary', () => {
  it('serves discovery without credentials but never trusts request-body identity', async () => {
    const manifest = await worker.fetch(new Request('https://product.example/.well-known/tangle-agent.json'), env)
    expect(manifest.status).toBe(200)
    expect((await manifest.json() as { ready: boolean }).ready).toBe(false)
    const response = await worker.fetch(new Request('https://product.example/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'run', userId: 'owner', workspaceId: 'other-owner' }),
    }), env)
    expect(response.status).toBe(503)
    const denied = createWorker({ authenticate: async () => null })
    expect((await denied.fetch(new Request('https://product.example/chat', { method: 'POST', body: '{}' }), env)).status).toBe(401)
  })
})
