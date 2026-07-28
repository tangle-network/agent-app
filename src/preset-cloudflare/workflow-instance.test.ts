import { describe, expect, it, vi } from 'vitest'
import { ensureCloudflareWorkflowInstance } from './workflow-instance'

interface Params {
  deliveryId: string
}

function instance(status = 'running') {
  return { status: vi.fn(async () => ({ status })) }
}

describe('ensureCloudflareWorkflowInstance', () => {
  it('returns a newly created instance without a lookup', async () => {
    const created = instance()
    const binding = {
      create: vi.fn(async () => created),
      get: vi.fn(async () => instance()),
    }

    await expect(
      ensureCloudflareWorkflowInstance(binding, {
        id: 'delivery-1',
        params: { deliveryId: 'delivery-1' } satisfies Params,
      }),
    ).resolves.toEqual({ instance: created, created: true })
    expect(binding.get).not.toHaveBeenCalled()
  })

  it('accepts a create error only after the same instance is readable', async () => {
    const existing = instance('queued')
    const binding = {
      create: vi.fn(async () => {
        throw new Error('opaque create failure')
      }),
      get: vi.fn(async () => existing),
    }

    await expect(
      ensureCloudflareWorkflowInstance(binding, {
        id: 'delivery-1',
        params: { deliveryId: 'delivery-1' } satisfies Params,
      }),
    ).resolves.toEqual({
      instance: existing,
      created: false,
      status: { status: 'queued' },
    })
    expect(binding.get).toHaveBeenCalledWith('delivery-1')
    expect(existing.status).toHaveBeenCalledTimes(1)
  })

  it('rethrows the create error when no durable instance can be proven', async () => {
    const createError = new Error('workflow service unavailable')
    const binding = {
      create: vi.fn(async () => {
        throw createError
      }),
      get: vi.fn(async () => {
        throw new Error('not found')
      }),
    }

    await expect(
      ensureCloudflareWorkflowInstance(binding, {
        id: 'delivery-1',
        params: { deliveryId: 'delivery-1' } satisfies Params,
      }),
    ).rejects.toBe(createError)
  })
})
