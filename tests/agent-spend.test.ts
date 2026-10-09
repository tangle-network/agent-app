import { describe, expect, it, vi } from 'vitest'
import { createPlatformAgentSpend } from '../src/platform'

const PLATFORM = 'https://id.example'

function platform(answers: Record<string, { status: number; body: unknown }>) {
  const calls: Array<{ path: string; headers: Headers; body: Record<string, unknown> }> = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    calls.push({ path, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
    const answer = answers[path] ?? { status: 404, body: {} }
    return Response.json(answer.body, { status: answer.status })
  })
  const spend = createPlatformAgentSpend({
    platformUrl: `${PLATFORM}/`, serviceName: 'gtm-agent', serviceToken: () => 'svc_token', product: 'gtm-agent',
    fetch: fetchImpl as unknown as typeof fetch,
  })
  return { spend, calls }
}

const expiresAt = new Date('2026-10-10T00:00:00.000Z')

describe('agent key spend', () => {
  it('delegates a spend-through Router key from the agent key, as this service', async () => {
    const { spend, calls } = platform({ '/v1/keys/delegate': { status: 201, body: { success: true, data: { key: 'sk-tan-child', id: 'key_child' } } } })
    expect(await spend.modelKey({ agentKey: 'sk-tan-agent', name: 'auto:gtm-agent:router:turn-1', expiresAt }))
      .toEqual({ succeeded: true, value: { key: 'sk-tan-child', keyId: 'key_child' } })
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer svc_token')
    expect(calls[0]!.headers.get('x-service-name')).toBe('gtm-agent')
    expect(calls[0]!.body).toEqual({
      sourceKey: 'sk-tan-agent', name: 'auto:gtm-agent:router:turn-1', product: 'router', spendThrough: true,
      expiresAt: expiresAt.toISOString(),
    })
  })

  it('answers a spent cap with a typed 402 wherever Platform refuses it', async () => {
    const { spend } = platform({
      '/v1/keys/delegate': { status: 402, body: { success: false, error: { code: 'KEY_BUDGET_EXHAUSTED' } } },
      '/v1/billing/authorizations': { status: 403, body: { success: false, error: { code: 'KEY_BUDGET_EXCEEDED' } } },
    })
    const exhausted = { succeeded: false, error: { status: 402, code: 'agent_key.budget_exhausted' } }
    expect(await spend.modelKey({ agentKey: 'sk-tan-agent', name: 'auto:x', expiresAt })).toMatchObject(exhausted)
    expect(await spend.hold({ keyId: 'key_agent', amountUsd: 0.5, referenceId: 'turn-1', expiresAt })).toMatchObject(exhausted)
  })

  it('holds a key-cap amount and spends what the work measured', async () => {
    const { spend, calls } = platform({
      '/v1/billing/authorizations': { status: 201, body: { success: true, data: { id: 'auth_1' } } },
      '/v1/billing/authorizations/auth_1/consume': { status: 200, body: { success: true, data: { consumedAmount: 0.12 } } },
      '/v1/billing/authorizations/auth_2/consume': { status: 409, body: { success: false, error: { code: 'AUTHORIZATION_CONFLICT' } } },
    })
    expect(await spend.hold({ keyId: 'key_agent', amountUsd: 0.5, referenceId: 'turn-1', expiresAt }))
      .toEqual({ succeeded: true, value: { authorizationId: 'auth_1' } })
    expect(calls[0]!.body).toEqual({
      keyId: 'key_agent', amount: 0.5, type: 'key_cap', product: 'gtm-agent', referenceId: 'turn-1',
      expiresAt: expiresAt.toISOString(),
    })
    expect(await spend.consume({ authorizationId: 'auth_1', amountUsd: 0.12 })).toEqual({ succeeded: true, value: { consumedUsd: 0.12 } })
    expect(calls[1]!.body).toEqual({ amount: 0.12 })
    expect(await spend.consume({ authorizationId: 'auth_2', amountUsd: 0.12 }))
      .toMatchObject({ succeeded: false, error: { status: 403, code: 'agent_key.spend_refused' } })
  })

  it('reports an unreachable Platform as retryable rather than as success', async () => {
    const spend = createPlatformAgentSpend({
      platformUrl: PLATFORM, serviceName: 'gtm-agent', serviceToken: 'svc', product: 'gtm-agent',
      fetch: (async () => { throw new TypeError('network down') }) as unknown as typeof fetch,
    })
    expect(await spend.hold({ keyId: 'key_agent', amountUsd: 0.5, referenceId: 'turn-1', expiresAt }))
      .toMatchObject({ succeeded: false, error: { status: 503, code: 'agent_key.spend_unavailable' } })
    expect(await spend.release('auth_1')).toMatchObject({ succeeded: false, error: { status: 503 } })
  })
})
