/**
 * The budget guard is what turns "silent negative balance" into "provisioning
 * stops, loudly". These pin the refusal contract, the correctable error, and the
 * two opposite failure contracts of the `/sandbox` seam — a gate whose throw
 * must propagate, and an observer whose throw must not.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ComputeBudgetExceededError,
  assertComputeBudget,
  createSandboxSpendHooks,
  type ComputeBudget,
  type ComputeBudgetRefusal,
  type SandboxSpendSeam,
} from './budget'
import { createInMemorySpendLedgerStore, createSpendLedger } from './store'
import type { SandboxSpendHooks } from '../sandbox/index'

const USD = 1_000_000_000

describe('assertComputeBudget', () => {
  it('reads nothing and allows everything when no budget is configured', async () => {
    await expect(assertComputeBudget(undefined, 'ws_1')).resolves.toBeUndefined()
  })

  it('allows provisioning under the cap', async () => {
    const settled = vi.fn().mockResolvedValue(40 * USD)
    await expect(
      assertComputeBudget({ limitNanoUsd: 50 * USD, settledNanoUsd: settled }, 'ws_1'),
    ).resolves.toBeUndefined()
    expect(settled).toHaveBeenCalledWith('ws_1')
  })

  it('refuses at the cap with every number the decision used on the error', async () => {
    const budget: ComputeBudget = {
      limitNanoUsd: 50 * USD,
      settledNanoUsd: async () => 63.5 * USD,
      now: () => 1_700_000_000_000,
    }
    const error = await assertComputeBudget(budget, 'ws_1').catch((err: unknown) => err)
    expect(error).toBeInstanceOf(ComputeBudgetExceededError)
    const typed = error as ComputeBudgetExceededError
    expect(typed.name).toBe('ComputeBudgetExceededError')
    expect(typed.workspaceId).toBe('ws_1')
    expect(typed.limitNanoUsd).toBe(50 * USD)
    expect(typed.settledNanoUsd).toBe(63.5 * USD)
    expect(typed.overageNanoUsd).toBe(13.5 * USD)
    // The message alone is enough to act on, without reading logs.
    expect(typed.message).toContain('$63.50')
    expect(typed.message).toContain('$50.00')
    expect(typed.message).toContain('No sandbox was provisioned')
  })

  it('routes every refusal to the alert seam before throwing', async () => {
    const seen: ComputeBudgetRefusal[] = []
    const budget: ComputeBudget = {
      limitNanoUsd: 10 * USD,
      settledNanoUsd: () => 10 * USD,
      onRefusal: (refusal) => seen.push(refusal),
    }
    await expect(assertComputeBudget(budget, 'ws_9')).rejects.toBeInstanceOf(
      ComputeBudgetExceededError,
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]?.overageNanoUsd).toBe(0)
    expect(seen[0]?.workspaceId).toBe('ws_9')
  })

  it('accepts a synchronous spend total as well as a promise', async () => {
    await expect(
      assertComputeBudget({ limitNanoUsd: 5 * USD, settledNanoUsd: () => 1 * USD }, 'ws_1'),
    ).resolves.toBeUndefined()
  })
})

describe('createSandboxSpendHooks', () => {
  it('records a provisioned box into the expectation ledger', async () => {
    const store = createInMemorySpendLedgerStore()
    const hooks = createSandboxSpendHooks({ ledger: createSpendLedger({ store }) })

    await hooks.onProvisioned?.({
      workspaceId: 'ws_1',
      sandboxId: 'sb_1',
      idleTimeoutSeconds: 3600,
      maxLifetimeSeconds: 86_400,
      at: 1_700_000_000_000,
    })

    const stored = await store.load('sb_1')
    expect(stored).toMatchObject({
      sandboxId: 'sb_1',
      workspaceId: 'ws_1',
      createdAt: 1_700_000_000_000,
      idleTimeoutSeconds: 3600,
      maxLifetimeSeconds: 86_400,
    })
  })

  it('lets a budget refusal propagate — refusing to provision is the point', async () => {
    const hooks = createSandboxSpendHooks({
      budget: { limitNanoUsd: USD, settledNanoUsd: () => 2 * USD },
    })
    await expect(hooks.beforeProvision?.({ workspaceId: 'ws_1' })).rejects.toBeInstanceOf(
      ComputeBudgetExceededError,
    )
  })

  it('swallows a recording failure and surfaces it on onError instead', async () => {
    const onError = vi.fn()
    const broken = {
      load: async () => {
        throw new Error('store is down')
      },
      insert: async () => {
        throw new Error('store is down')
      },
      update: async () => null,
    }
    const hooks = createSandboxSpendHooks({ ledger: createSpendLedger({ store: broken }), onError })

    await expect(
      hooks.onProvisioned?.({
        workspaceId: 'ws_1',
        sandboxId: 'sb_1',
        idleTimeoutSeconds: 3600,
        at: 1,
      }),
    ).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledOnce()
  })

  it('is a no-op observer when no ledger is wired, so a budget-only adopter pays nothing', async () => {
    const hooks = createSandboxSpendHooks({})
    await expect(
      hooks.onProvisioned?.({ workspaceId: 'ws_1', sandboxId: 'sb_1', idleTimeoutSeconds: 3600, at: 1 }),
    ).resolves.toBeUndefined()
    await expect(hooks.beforeProvision?.({ workspaceId: 'ws_1' })).resolves.toBeUndefined()
  })

  it('satisfies /sandbox\'s structural seam, so the two declarations cannot drift apart', () => {
    // `/spend` re-declares this shape rather than importing it, to keep the
    // dependency pointing one way. This assignment is what proves the copy is
    // still assignable to the original — a compile error here IS the failure.
    const hooks: SandboxSpendHooks = createSandboxSpendHooks({})
    const backToSpend: SandboxSpendSeam = hooks
    expect(typeof backToSpend.beforeProvision).toBe('function')
  })
})
