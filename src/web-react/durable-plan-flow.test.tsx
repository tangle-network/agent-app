// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import {
  createDurablePlanDecisionClient,
  useDurablePlanFlow,
  type DurablePlanDecisionResult,
} from './durable-plan-flow'
import type { ChatPlan } from '../plans/index'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const pending: ChatPlan = {
  planId: 'plan-1',
  revision: 1,
  body: 'Research first',
  submittedAt: '2026-07-21T00:00:00.000Z',
  status: 'pending',
}

function result(idempotent = false): DurablePlanDecisionResult {
  return {
    plan: { ...pending, status: 'approved', decidedAt: '2026-07-21T00:01:00.000Z' },
    followUp: {
      receiptId: 'receipt-1',
      planId: 'plan-1',
      revision: 1,
      turnId: 'turn-1',
      state: 'running',
    },
    idempotent,
  }
}

describe('createDurablePlanDecisionClient', () => {
  it('normalizes the authority receipt and preserves idempotency', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      plan: result(true).plan,
      followUp: { receiptId: 'receipt-1', turnId: 'turn-1', state: 'running' },
      idempotent: true,
    }), { status: 200 })) as unknown as typeof fetch
    const client = createDurablePlanDecisionClient({ url: '/api/plan', fetchImpl })
    await expect(client.decide({ planId: 'plan-1', revision: 1, decision: 'approved' }))
      .resolves.toEqual(result(true))
  })

  it('preserves an absolute URL returned by a route function', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(result()), { status: 200 })) as unknown as typeof fetch
    const client = createDurablePlanDecisionClient({
      url: () => 'https://api.example.test/plan',
      fetchImpl,
    })

    await client.current({ planId: 'plan-1', revision: 1 })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.test/plan?planId=plan-1&revision=1',
      { method: 'GET' },
    )
  })

  it('normalizes the shared route replay marker as an idempotent result', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      plan: result(true).plan,
      receipt: { receiptId: 'receipt-1', turnId: 'turn-1', state: 'running' },
      replayed: true,
    }), { status: 200 })) as unknown as typeof fetch
    const client = createDurablePlanDecisionClient({ url: '/api/plan', fetchImpl })
    await expect(client.decide({ planId: 'plan-1', revision: 1, decision: 'approved' }))
      .resolves.toEqual(result(true))
  })
})

describe('useDurablePlanFlow', () => {
  it('attaches both a first decision and a later idempotent retry by receipt', async () => {
    const client = {
      current: vi.fn(async () => result(true)),
      decide: vi.fn(async () => result()),
    }
    const attach = vi.fn(async () => {})
    const { result: hook } = renderHook(() => useDurablePlanFlow({
      plan: pending,
      client,
      attachFollowUp: attach,
    }))

    await act(async () => { await hook.current.decide('approved') })
    await act(async () => { await hook.current.restore() })

    expect(attach).toHaveBeenCalledTimes(2)
    expect(attach).toHaveBeenNthCalledWith(1, expect.objectContaining({ receiptId: 'receipt-1' }))
    expect(attach).toHaveBeenNthCalledWith(2, expect.objectContaining({ receiptId: 'receipt-1' }))
  })

  it('coalesces concurrent attachment of the same receipt', async () => {
    let release!: () => void
    const attach = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const client = {
      current: vi.fn(async () => result(true)),
      decide: vi.fn(async () => result()),
    }
    const { result: hook } = renderHook(() => useDurablePlanFlow({ plan: pending, client, attachFollowUp: attach }))
    let first!: Promise<unknown>
    let second!: Promise<unknown>
    act(() => {
      first = hook.current.restore()
      second = hook.current.restore()
    })
    await act(async () => {
      await Promise.resolve()
      release()
      await Promise.all([first, second])
    })
    expect(attach).toHaveBeenCalledTimes(1)
  })

  it('coalesces decisions submitted before React commits the busy state', async () => {
    let release!: (value: DurablePlanDecisionResult) => void
    const client = {
      current: vi.fn(async () => result(true)),
      decide: vi.fn(() => new Promise<DurablePlanDecisionResult>((resolve) => { release = resolve })),
    }
    const { result: hook } = renderHook(() => useDurablePlanFlow({ plan: pending, client }))
    let first!: Promise<unknown>
    let second!: Promise<unknown>
    act(() => {
      first = hook.current.decide('approved')
      second = hook.current.decide('approved')
    })
    await act(async () => {
      release(result())
      await Promise.all([first, second])
    })
    expect(client.decide).toHaveBeenCalledTimes(1)
  })
})
