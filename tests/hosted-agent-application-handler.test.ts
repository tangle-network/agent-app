import { describe, expect, it, vi } from 'vitest'
import type { LineApplicationRequest } from '@tangle-network/sandbox/core'
import { createApplicationLineHandler, type ApplicationLineOptions } from '../src/hosted-agent/application'

const input: LineApplicationRequest = {
  version: 1, binding: 'owner:workspace:line', messageId: 'msg_demo',
  lineId: 'ln_demo', attachmentId: 'lat_demo', memberId: 'mem_demo',
  lineThreadId: 'thread_demo', ownerUserId: 'owner_demo',
  sender: { address: '+15550100001', role: 'owner' }, transport: 'imessage',
  receivedAt: '2026-09-29T12:00:00Z', text: 'Draft a sales note',
}
function callback(overrides: Partial<LineApplicationRequest> = {}) {
  const body = { ...input, ...overrides }
  return new Request('https://gtm.example.com/api/lines/turn', {
    method: 'POST', headers: { 'content-type': 'application/json',
      'idempotency-key': `line-application:${body.messageId}` },
    body: JSON.stringify(body),
  })
}
function options(): ApplicationLineOptions<{ id: string }> {
  return {
    authenticate: async () => ({ binding: input.binding, target: { id: 'workspace_demo' } }),
    authorize: async () => {},
    read: async () => ({ state: 'missing' }),
    admit: async () => {},
  }
}

describe('application line callback', () => {
  it('admits one retained command and rechecks authority before releasing its completed result', async () => {
    const bridge = options()
    bridge.authorize = vi.fn(async () => {})
    let reads = 0
    bridge.read = vi.fn(async () => ++reads === 1
      ? { state: 'missing' } as const
      : { state: 'completed', executionId: 'exec_demo', text: 'Saved note' } as const)
    bridge.admit = vi.fn(async () => {})
    const response = await createApplicationLineHandler(bridge)(callback())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      version: 1, binding: input.binding, messageId: input.messageId,
      attachmentId: input.attachmentId, state: 'completed',
      executionId: 'exec_demo', text: 'Saved note',
    })
    expect(bridge.admit).toHaveBeenCalledTimes(1)
    expect(bridge.authorize).toHaveBeenCalledTimes(2)
  })

  it('never re-admits a native accepted execution when the application record is missing', async () => {
    const bridge = options()
    bridge.admit = vi.fn(async () => {})
    const response = await createApplicationLineHandler(bridge)(callback({ acceptedExecutionId: 'exec_prior' }))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'accepted_execution_unavailable' } })
    expect(bridge.admit).not.toHaveBeenCalled()
  })

  it('does not release a result after authority is revoked during the read', async () => {
    const bridge = options()
    let checks = 0
    bridge.authorize = vi.fn(async () => {
      if (++checks === 2) throw new Response('Revoked', { status: 403 })
    })
    bridge.read = vi.fn(async () => ({ state: 'completed', executionId: 'exec_demo', text: 'Private note' } as const))
    bridge.admit = vi.fn(async () => {})
    const response = await createApplicationLineHandler(bridge)(callback())
    expect(response.status).toBe(403)
    expect(await response.text()).toBe('Revoked')
    expect(bridge.admit).not.toHaveBeenCalled()
  })
})
