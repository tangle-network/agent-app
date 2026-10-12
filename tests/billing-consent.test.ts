import { describe, expect, it, vi } from 'vitest'
import { createPlatformBillingConsent } from '../src/platform'

const PLATFORM = 'https://id.example'

function platform(grant: { status: number; body: unknown } | 'down', self: { status: number; body: unknown } = {
  status: 200, body: { success: true, data: { id: 'key_service' } },
}) {
  const calls: Array<{ path: string; headers: Headers; body: unknown }> = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    calls.push({ path, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (path === '/v1/keys/self') return Response.json(self.body, { status: self.status })
    if (grant === 'down') throw new TypeError('fetch failed')
    return Response.json(grant.body, { status: grant.status })
  })
  const consent = createPlatformBillingConsent({
    platformUrl: `${PLATFORM}/`, serviceName: 'creative-agent', serviceToken: () => 'svc_token',
    fetch: fetchImpl as unknown as typeof fetch,
  })
  return { consent, calls }
}

describe('billing consent', () => {
  it("records the person's grant to the service key Platform names, as this service", async () => {
    const { consent, calls } = platform({ status: 201, body: { success: true, data: { grantId: 'key_grant' } } })
    expect(await consent.consent({ payerKey: 'sk-tan-person', serviceKey: 'sk-tan-service' }))
      .toEqual({ succeeded: true, value: { created: true } })
    expect(await consent.consent({ payerKey: 'sk-tan-person', serviceKey: 'sk-tan-service' }))
      .toEqual({ succeeded: true, value: { created: true } })
    expect(calls.map(call => call.path)).toEqual([
      '/v1/keys/self', '/v1/keys/billing-delegation-grants', '/v1/keys/billing-delegation-grants',
    ])
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer sk-tan-service')
    expect(calls[1]!.headers.get('authorization')).toBe('Bearer svc_token')
    expect(calls[1]!.headers.get('x-service-name')).toBe('creative-agent')
    expect(calls[1]!.body).toEqual({ sourceKey: 'sk-tan-person', delegateKeyId: 'key_service' })
  })

  it('tells an unfunded person what to do, not a Platform code', async () => {
    const { consent } = platform({ status: 402, body: { success: false, error: { code: 'PAYER_NOT_CHARGEABLE', message: 'x' } } })
    const outcome = await consent.consent({ payerKey: 'sk-tan-person', serviceKey: 'sk-tan-service' })
    expect(outcome).toMatchObject({ succeeded: false, error: { status: 402, code: 'billing_consent.payer_not_chargeable' } })
    if (outcome.succeeded) throw new Error('expected a refusal')
    expect(outcome.error.message).toMatch(/Add credit/)
    expect(outcome.error.message).not.toMatch(/PAYER_|_/)
  })

  it('treats the service account paying for itself as consent', async () => {
    const { consent } = platform({ status: 409, body: { success: false, error: { code: 'PAYER_IS_DELEGATE_OWNER' } } })
    expect(await consent.consent({ payerKey: 'sk-tan-owner', serviceKey: 'sk-tan-service' }))
      .toEqual({ succeeded: true, value: { created: false } })
  })

  it('separates a refused sign-in from Platform being unreachable', async () => {
    expect(await platform({ status: 403, body: { success: false, error: { code: 'PAYER_KEY_INVALID' } } })
      .consent.consent({ payerKey: 'sk-tan-x', serviceKey: 'sk-tan-service' }))
      .toMatchObject({ succeeded: false, error: { status: 403, code: 'billing_consent.refused', platformCode: 'PAYER_KEY_INVALID' } })
    expect(await platform('down').consent.consent({ payerKey: 'sk-tan-x', serviceKey: 'sk-tan-service' }))
      .toMatchObject({ succeeded: false, error: { status: 503, code: 'billing_consent.unavailable' } })
    expect(await platform({ status: 201, body: {} }, { status: 401, body: {} })
      .consent.consent({ payerKey: 'sk-tan-x', serviceKey: 'sk-tan-service' }))
      .toMatchObject({ succeeded: false, error: { status: 503 } })
  })
})
