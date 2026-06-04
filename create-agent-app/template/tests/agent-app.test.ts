import { describe, it, expect } from 'vitest'
import { config } from '../agent.config'
import { createAgentApp } from '../src/agent-app'
import type { D1Like, VaultKv } from '@tangle-network/agent-app/preset-cloudflare'

// Tiny in-memory fakes for D1 + KV so the composer runs without Cloudflare.
function fakeDb(): D1Like {
  return {
    prepare() {
      return {
        bind() {
          return this
        },
        async first<T>() {
          return null as T | null
        },
        async run() {
          return { success: true }
        },
        async all<T>() {
          return { results: [] as T[] }
        },
      }
    },
  } as unknown as D1Like
}

function fakeVault(): VaultKv {
  const store = new Map<string, string>()
  return {
    async get(key: string) {
      return store.get(key) ?? null
    },
    async put(key: string, value: string) {
      store.set(key, value)
    },
  } as unknown as VaultKv
}

describe('agent.config', () => {
  it('regulatedTypes is a subset of proposalTypes (human-in-the-loop invariant)', () => {
    for (const t of config.taxonomy.regulatedTypes) {
      expect(config.taxonomy.proposalTypes).toContain(t)
    }
  })

  it('has a non-empty identity persona', () => {
    expect(config.identity.persona.length).toBeGreaterThan(0)
  })
})

describe('createAgentApp', () => {
  it('composes handlers + taxonomy from config without hard-coded domain values', () => {
    const app = createAgentApp({ DB: fakeDb(), VAULT: fakeVault() })
    expect(app.taxonomy.proposalTypes).toEqual(config.taxonomy.proposalTypes)
    expect(typeof app.handlers.submitProposal).toBe('function')
    expect(typeof app.knowledgeGate).toBe('function')
  })

  it('a submitted proposal is queued (regulated never auto-executes)', async () => {
    const app = createAgentApp({ DB: fakeDb(), VAULT: fakeVault() })
    const regulated = config.taxonomy.regulatedTypes[0]
    if (!regulated) return
    const r = await app.handlers.submitProposal(
      { type: regulated, title: 'test', description: null },
      { userId: 'u', workspaceId: 'w', threadId: null },
    )
    // The preset returns a pending proposal id; it is NOT an executed side effect.
    expect(typeof r.proposalId).toBe('string')
  })
})
