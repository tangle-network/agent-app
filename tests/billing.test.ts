import { describe, it, expect } from 'vitest'
import {
  createWorkspaceKeyManager,
  createPlatformBalanceManager,
  type KeyProvisioner,
  type WorkspaceKeyStore,
  type KeyCrypto,
  type WorkspaceKeyRecord,
  type PlatformBillingClient,
  type PlanLimit,
} from '../src/billing/index'

/** In-memory store + fake tcloud + reversible crypto so the manager's
 *  mint/rotate/rollover/usage logic is exercised with no DB or network. */
function harness() {
  let rows: Array<WorkspaceKeyRecord & { workspaceId: string; status: 'active' | 'revoked' }> = []
  let idSeq = 0
  let keySeq = 0
  const revoked: string[] = []
  const keyBudgets = new Map<string, { budgetUsd: number; budgetSpent: number; expiresAt: string }>()

  const store: WorkspaceKeyStore = {
    async getActive(ws) {
      const active = rows.filter((r) => r.workspaceId === ws && r.status === 'active')
      return active.length ? active[active.length - 1]! : null
    },
    async listActive(ws) {
      return rows.filter((r) => r.workspaceId === ws && r.status === 'active').map((r) => ({ id: r.id, keyId: r.keyId }))
    },
    async insert(rec) {
      rows.push({ id: `row-${++idSeq}`, status: 'active', ...rec })
    },
    async markRevoked(id) {
      const r = rows.find((x) => x.id === id)
      if (r) r.status = 'revoked'
    },
  }
  const provisioner: KeyProvisioner = {
    async createKey({ budgetUsd, expiresAt }) {
      const id = `key-${++keySeq}`
      keyBudgets.set(id, { budgetUsd, budgetSpent: 0, expiresAt })
      return { id, key: `sk-tan-${id}` }
    },
    async revokeKey(keyId) {
      revoked.push(keyId)
    },
    async getKey(keyId) {
      return keyBudgets.get(keyId) ?? {}
    },
  }
  const crypto: KeyCrypto = {
    async encrypt(s) {
      return `enc(${s})`
    },
    async decrypt(e) {
      return e.replace(/^enc\(/, '').replace(/\)$/, '')
    },
  }
  return { store, provisioner, crypto, rows: () => rows, revoked, setSpent: (k: string, n: number) => { const b = keyBudgets.get(k); if (b) b.budgetSpent = n } }
}

const T0 = new Date('2026-06-15T12:00:00Z')

describe('createWorkspaceKeyManager', () => {
  it('mints a child key on first ensure, stores it encrypted, returns the secret', async () => {
    const h = harness()
    const mgr = createWorkspaceKeyManager({ ...h, defaultBudgetUsd: 100, now: () => T0 })
    const secret = await mgr.ensureKey('ws1')
    expect(secret).toBe('sk-tan-key-1')
    const rows = h.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.keyEncrypted).toBe('enc(sk-tan-key-1)')
    expect(rows[0]!.budgetUsd).toBe(100)
    // Expires at the next period boundary (2026-07-01).
    expect(rows[0]!.expiresAt!.toISOString()).toBe('2026-07-01T00:00:00.000Z')
  })

  it('is idempotent — a second ensure within the period returns the same key, no new mint', async () => {
    const h = harness()
    const mgr = createWorkspaceKeyManager({ ...h, defaultBudgetUsd: 100, now: () => T0 })
    const a = await mgr.ensureKey('ws1')
    const b = await mgr.ensureKey('ws1')
    expect(a).toBe(b)
    expect(h.rows().filter((r) => r.status === 'active')).toHaveLength(1)
  })

  it('rotate mints fresh + revokes the prior (only one live key per workspace)', async () => {
    const h = harness()
    const mgr = createWorkspaceKeyManager({ ...h, defaultBudgetUsd: 100, now: () => T0 })
    await mgr.ensureKey('ws1')
    const next = await mgr.rotateKey('ws1')
    expect(next).toBe('sk-tan-key-2')
    expect(h.revoked).toEqual(['key-1'])
    expect(h.rows().filter((r) => r.status === 'active')).toHaveLength(1)
    expect(h.rows().find((r) => r.status === 'active')!.keyId).toBe('key-2')
  })

  it('rollover carries the prior unused budget, bounded by rolloverCapUsd', async () => {
    const h = harness()
    const mgr = createWorkspaceKeyManager({ ...h, defaultBudgetUsd: 100, now: () => T0 })
    await mgr.ensureKey('ws1') // key-1, budget 100
    h.setSpent('key-1', 30) // 70 remaining
    await mgr.rotateKey('ws1', { rollover: true }) // 100 + 70 = 170
    expect(h.rows().find((r) => r.keyId === 'key-2')!.budgetUsd).toBe(170)

    h.setSpent('key-2', 0) // 170 remaining
    await mgr.rotateKey('ws1', { rollover: true, rolloverCapUsd: 200 }) // 100 + 170 = 270 → capped 200
    expect(h.rows().find((r) => r.keyId === 'key-3')!.budgetUsd).toBe(200)
  })

  it('re-mints when the active key has expired (fails closed on a forgotten rotation)', async () => {
    const h = harness()
    let now = T0
    const mgr = createWorkspaceKeyManager({ ...h, defaultBudgetUsd: 100, now: () => now })
    await mgr.ensureKey('ws1') // expires 2026-07-01
    now = new Date('2026-08-02T00:00:00Z') // past expiry
    const secret = await mgr.ensureKey('ws1')
    expect(secret).toBe('sk-tan-key-2')
    expect(h.revoked).toContain('key-1')
  })

  it('reports live usage from the provisioner (drives the budget panel)', async () => {
    const h = harness()
    const mgr = createWorkspaceKeyManager({ ...h, defaultBudgetUsd: 100, now: () => T0 })
    await mgr.ensureKey('ws1')
    h.setSpent('key-1', 42)
    const usage = await mgr.getUsage('ws1')
    expect(usage).toMatchObject({ keyId: 'key-1', budgetUsd: 100, budgetSpent: 42, budgetRemaining: 58, exhausted: false })
  })

  it('returns null usage when no key is provisioned', async () => {
    const h = harness()
    const mgr = createWorkspaceKeyManager({ ...h, defaultBudgetUsd: 100, now: () => T0 })
    expect(await mgr.getUsage('nope')).toBeNull()
  })
})

type Plan = 'free' | 'pro' | 'enterprise'
const PLAN_LIMITS: Record<Plan, PlanLimit> = {
  free: { monthlyBalanceUsd: 2, concurrency: 1, overageAllowed: false },
  pro: { monthlyBalanceUsd: 100, concurrency: Number.POSITIVE_INFINITY, overageAllowed: true },
  enterprise: { monthlyBalanceUsd: 500, concurrency: Number.POSITIVE_INFINITY, overageAllowed: true },
}

function billingClient(overrides: Partial<PlatformBillingClient<Plan>> = {}): { client: PlatformBillingClient<Plan>; deducts: any[] } {
  const deducts: any[] = []
  const client: PlatformBillingClient<Plan> = {
    async resolveIdentity(userId) {
      if (userId === 'unlinked') return null
      if (userId === 'linked-no-key') return { platformUserId: 'p-nokey', apiKey: null }
      return { platformUserId: `p-${userId}`, apiKey: `key-${userId}` }
    },
    async getPlan() {
      return 'pro'
    },
    async getBalance() {
      return { balance: 50, lifetimeSpent: 10 }
    },
    async getUsageByProduct() {
      return [{ product: 'tax-agent', totalSpent: 7.5, count: 3 }]
    },
    async deduct(input) {
      deducts.push(input)
    },
    ...overrides,
  }
  return { client, deducts }
}

describe('createPlatformBalanceManager (shared-platform-balance)', () => {
  it('resolves plan + balance for a linked user', async () => {
    const { client } = billingClient()
    const mgr = createPlatformBalanceManager({ client, planLimits: PLAN_LIMITS, freePlan: 'free', productSlug: 'tax-agent' })
    const state = await mgr.getState('u1')
    expect(state).toMatchObject({ platformUserId: 'p-u1', plan: 'pro', remainingBalanceUsd: 50, lifetimeSpentUsd: 10, monthlyBalanceUsd: 100, overageAllowed: true })
  })

  it('fails CLOSED for an unlinked user (free plan, zero balance, no allow)', async () => {
    const { client } = billingClient()
    const mgr = createPlatformBalanceManager({ client, planLimits: PLAN_LIMITS, freePlan: 'free', productSlug: 'tax-agent' })
    const state = await mgr.getState('unlinked')
    expect(state).toMatchObject({ platformUserId: null, plan: 'free', remainingBalanceUsd: 0 })
    const gate = await mgr.canStartBillableTurn('unlinked')
    expect(gate.allowed).toBe(false)
  })

  it('linked-without-key falls to free with zero balance (never reads empty key)', async () => {
    const { client } = billingClient()
    const mgr = createPlatformBalanceManager({ client, planLimits: PLAN_LIMITS, freePlan: 'free', productSlug: 'tax-agent' })
    const state = await mgr.getState('linked-no-key')
    expect(state).toMatchObject({ platformUserId: 'p-nokey', plan: 'free', remainingBalanceUsd: 0 })
  })

  it('gates a billable turn: overage plan allowed even at zero balance', async () => {
    const { client } = billingClient({ async getBalance() { return { balance: 0, lifetimeSpent: 0 } } })
    const mgr = createPlatformBalanceManager({ client, planLimits: PLAN_LIMITS, freePlan: 'free', productSlug: 'tax-agent' })
    const gate = await mgr.canStartBillableTurn('u1') // pro → overage
    expect(gate.allowed).toBe(true)
  })

  it('gates a billable turn: no-overage plan blocked at zero, allowed with balance', async () => {
    const free = billingClient({ async getPlan() { return 'free' }, async getBalance() { return { balance: 0, lifetimeSpent: 0 } } })
    const mgrA = createPlatformBalanceManager({ client: free.client, planLimits: PLAN_LIMITS, freePlan: 'free', productSlug: 'tax-agent' })
    expect((await mgrA.canStartBillableTurn('u1')).allowed).toBe(false)

    const withBal = billingClient({ async getPlan() { return 'free' }, async getBalance() { return { balance: 1.5, lifetimeSpent: 0 } } })
    const mgrB = createPlatformBalanceManager({ client: withBal.client, planLimits: PLAN_LIMITS, freePlan: 'free', productSlug: 'tax-agent' })
    expect((await mgrB.canStartBillableTurn('u1')).allowed).toBe(true)
  })

  it('deducts against the platform user id', async () => {
    const { client, deducts } = billingClient()
    const mgr = createPlatformBalanceManager({ client, planLimits: PLAN_LIMITS, freePlan: 'free', productSlug: 'tax-agent' })
    await mgr.deduct('u1', { amountUsd: 0.42, type: 'turn', description: 'chat', referenceId: 'sess-1' })
    expect(deducts).toEqual([{ platformUserId: 'p-u1', amountUsd: 0.42, type: 'turn', description: 'chat', referenceId: 'sess-1' }])
  })

  it('deduct throws for an unlinked user', async () => {
    const { client } = billingClient()
    const mgr = createPlatformBalanceManager({ client, planLimits: PLAN_LIMITS, freePlan: 'free', productSlug: 'tax-agent' })
    await expect(mgr.deduct('unlinked', { amountUsd: 1, type: 't', description: 'd', referenceId: 'r' })).rejects.toThrow(/platform-linked/)
  })

  it('aggregates product usage for the configured slug', async () => {
    const { client } = billingClient()
    const mgr = createPlatformBalanceManager({ client, planLimits: PLAN_LIMITS, freePlan: 'free', productSlug: 'tax-agent' })
    expect(await mgr.getProductUsage('u1')).toEqual({ spentUsd: 7.5, transactionCount: 3 })
  })

  it('product usage is zero for an unlinked user', async () => {
    const { client } = billingClient()
    const mgr = createPlatformBalanceManager({ client, planLimits: PLAN_LIMITS, freePlan: 'free', productSlug: 'tax-agent' })
    expect(await mgr.getProductUsage('unlinked')).toEqual({ spentUsd: 0, transactionCount: 0 })
  })
})
