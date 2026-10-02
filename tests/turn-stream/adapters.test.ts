import { describe, expect, it, vi } from 'vitest'

import { createTurnStreamUpgradeHandler } from '../../src/turn-stream/adapters'
import { TURN_STREAM_TOKEN_HEADER, verifyTurnStreamToken } from '../../src/turn-stream/core'
import { MEMORY_TURN_STREAM_AUTH_SECRET } from '../../src/turn-stream/memory'

function forwarding() {
  const fetch = vi.fn(async (_request: Request | string) => new Response('forwarded'))
  const namespace = { idFromName: (name: string) => name, get: () => ({ fetch }) }
  return { fetch, namespace }
}

const authSecret = MEMORY_TURN_STREAM_AUTH_SECRET

describe('workspace WebSocket forwarding', () => {
  it('authorizes first and replaces client token fields with an internal header', async () => {
    const { namespace, fetch } = forwarding()
    const authorize = vi.fn(async () => ({ ok: true as const }))
    const forward = createTurnStreamUpgradeHandler({ namespace, authSecret, authorize })
    const request = new Request('https://app.test/api/session-stream?workspaceId=customer.example&token=stale', {
      headers: { Upgrade: 'WebSocket', [TURN_STREAM_TOKEN_HEADER]: 'stale' },
    })
    const response = await forward(request)
    expect(response?.status).toBe(200)
    expect(authorize).toHaveBeenCalledWith(request, { workspaceId: 'customer.example' })
    const forwarded = fetch.mock.calls[0]?.[0]
    expect(forwarded).toBeInstanceOf(Request)
    if (!(forwarded instanceof Request)) throw new Error('Expected a forwarded request')
    expect(new URL(forwarded.url).searchParams.has('token')).toBe(false)
    expect(await verifyTurnStreamToken('customer.example', forwarded.headers.get(TURN_STREAM_TOKEN_HEADER) ?? '', authSecret)).toBe(true)
  })

  it('does not touch the Durable Object when workspace access is refused', async () => {
    const { namespace, fetch } = forwarding()
    const forward = createTurnStreamUpgradeHandler({
      namespace, authSecret, authorize: async () => ({ ok: false, response: new Response('Forbidden', { status: 403 }) }),
    })
    const response = await forward(new Request('https://app.test/api/session-stream?workspaceId=ws', {
      headers: { Upgrade: 'websocket' },
    }))
    expect(response?.status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses the removed thread viewer route instead of subscribing to workspace signals', async () => {
    const { namespace, fetch } = forwarding()
    const forward = createTurnStreamUpgradeHandler({ namespace, authSecret, authorize: async () => ({ ok: true }) })
    const response = await forward(new Request('https://app.test/api/session-stream?workspaceId=ws&threadId=thread', {
      headers: { Upgrade: 'websocket' },
    }))
    expect(response?.status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })
})
