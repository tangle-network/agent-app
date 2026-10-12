import { describe, expect, it, vi } from 'vitest'
import {
  canonicalDelegatedKeyName,
  createDelegatedKeyProvisioner,
  createPlatformDelegatedKeyClient,
  DelegatedKeyMissingError,
  DelegatedKeyRefusalError,
  type DelegatedKeyRequest,
} from '../src/platform/delegated-keys'

const NOW = Date.parse('2026-10-12T01:00:00Z')
const SOURCE = 'sk-tan-payer-linked-key-0001'
const EXPIRES = new Date(NOW + 30 * 60_000)

interface Call { url: string; method: string; headers: Headers; body: Record<string, unknown> | null }
type Responder = (call: Call) => { status: number; body?: unknown }

/** A fake Platform answering each request with the next queued responder. */
function platform(...responses: Responder[]) {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(url), method: init?.method ?? 'GET', headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : null }
    calls.push(call)
    const next = responses.shift()
    if (!next) throw new Error(`unexpected Platform call ${call.method} ${call.url}`)
    const { status, body } = next(call)
    return new Response(body === undefined ? null : JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  const client = createPlatformDelegatedKeyClient({ platformUrl: 'https://id.test/', serviceName: 'tax-agent',
    serviceToken: 'svc-token', fetch: fetchImpl, now: () => NOW })
  return { client, calls }
}

/**
 * Platform's 201 for POST /v1/keys/delegate, in its real shape (agent-dev-container
 * key-provisioning.ts delegate return + key-issuance-routes.ts envelope): the key row
 * and its attribution; the granted expiry is attribution.expiresAt, never top-level.
 */
const minted = (n: number, change: (data: Record<string, any>) => void = () => {}): Responder => (call) => {
  const body = call.body!
  const data: Record<string, any> = {
    id: `key_${n}`, key: `sk-tan-child${n}xxxxxxxxxxxx`, prefix: `sk-tan-child${n}`, name: body.name,
    provisionedByService: 'tax-agent', product: body.product, scopes: null,
    budgetUsd: body.budgetUsd ?? null, budgetRemaining: body.budgetUsd ?? null,
    monthlyBudgetUsd: body.monthlyBudgetUsd ?? null, monthlyBudgetRemaining: body.monthlyBudgetUsd ?? null,
    allowedModels: body.allowedModels ?? null, rpmLimit: null,
    attribution: {
      version: 1, issuerService: 'platform', targetService: body.product, originKind: 'app', originAppId: 'tax-agent',
      mintActorType: 'service', mintActorId: 'tax-agent', delegatedFromKeyId: 'key_source', lineageId: 'lin_1',
      delegationDepth: 1, budgetParentKeyId: 'key_source', payerType: 'user', payerId: 'usr_payer', actorUserId: 'usr_payer',
      teamId: null, resourceType: body.resourceType ?? null, resourceId: body.resourceId ?? null,
      issuedAt: new Date(NOW).toISOString(), expiresAt: body.expiresAt,
    },
  }
  change(data)
  return { status: 201, body: { success: true, data } }
}
const deleted: Responder = () => ({ status: 200, body: { success: true } })

const request: DelegatedKeyRequest = { sourceKey: SOURCE, name: 'turn:exec-1', product: 'router',
  resource: { type: 'tax-turn', id: 'exec-1' }, allowedModels: ['gpt-6-luna', 'kimi-k2.7'],
  budget: { usd: 1, monthlyUsd: 1 }, expiresAt: EXPIRES, expect: { payerId: 'usr_payer', sourceKeyId: 'key_source' } }

describe('canonicalDelegatedKeyName', () => {
  it('qualifies Router and Sandbox names the way Platform stores them', () => {
    expect(canonicalDelegatedKeyName({ serviceName: 'tax-agent', product: 'router', name: 'turn:1' })).toBe('auto:tax-agent:router:turn:1')
    expect(canonicalDelegatedKeyName({ serviceName: 'tax-agent', product: 'router', name: 'auto:tax-agent:turn:1' })).toBe('auto:tax-agent:router:turn:1')
    expect(canonicalDelegatedKeyName({ serviceName: 'tax-agent', product: 'router', name: 'auto:tax-agent:router:turn:1' })).toBe('auto:tax-agent:router:turn:1')
  })
})

describe('createPlatformDelegatedKeyClient.delegate', () => {
  it('mints a scoped child and returns the expiry Platform granted in its attribution', async () => {
    const granted = new Date(NOW + 20 * 60_000).toISOString()
    const { client, calls } = platform(minted(1, data => { data.attribution.expiresAt = granted }))
    const out = await client.delegate(request)
    expect(out).toMatchObject({ succeeded: true, value: { id: 'key_1', name: 'auto:tax-agent:router:turn:exec-1', product: 'router',
      allowedModels: ['gpt-6-luna', 'kimi-k2.7'], budgetUsd: 1 } })
    expect(out.succeeded && out.value.expiresAt.toISOString()).toBe(granted)
    expect(calls[0]!.url).toBe('https://id.test/v1/keys/delegate')
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer svc-token')
    expect(calls[0]!.headers.get('x-service-name')).toBe('tax-agent')
    expect(calls[0]!.body).toEqual({ sourceKey: SOURCE, name: 'auto:tax-agent:router:turn:exec-1', product: 'router',
      resourceType: 'tax-turn', resourceId: 'exec-1', budgetUsd: 1, monthlyBudgetUsd: 1,
      allowedModels: ['gpt-6-luna', 'kimi-k2.7'], scopes: [], expiresAt: EXPIRES.toISOString() })
  })

  it('accepts a child that inherits the source restrictions and a personal source with no origin app', async () => {
    const { client } = platform(minted(4, d => { d.allowedModels = ['gpt-6-luna']; d.attribution.originAppId = null }))
    const { allowedModels: _omitted, ...withoutModels } = request
    await expect(client.delegate(withoutModels)).resolves.toMatchObject({ succeeded: true, value: { id: 'key_4' } })
  })

  it.each([
    ['a different model set', (d: Record<string, any>) => { d.allowedModels = ['gpt-6-luna'] }],
    ['a different name', (d: Record<string, any>) => { d.name = 'auto:tax-agent:router:other' }],
    ['control-plane scopes', (d: Record<string, any>) => { d.scopes = ['keys:write'] }],
    ['a budget larger than requested', (d: Record<string, any>) => { d.budgetUsd = 5 }],
    ['attribution to another payer', (d: Record<string, any>) => { d.attribution.payerId = 'usr_someone_else' }],
    ['attribution for another source key', (d: Record<string, any>) => { d.attribution.delegatedFromKeyId = 'key_other' }],
    ['attribution for another resource', (d: Record<string, any>) => { d.attribution.resourceId = 'exec-2' }],
    ['an expiry in the past or past the request', (d: Record<string, any>) => { d.attribution.expiresAt = new Date(EXPIRES.getTime() + 1).toISOString() }],
    ['the source key itself', (d: Record<string, any>) => { d.key = SOURCE }],
  ])('revokes and refuses a child with %s, without leaking either key', async (problem, change) => {
    const { client, calls } = platform(minted(2, change), deleted)
    const out = await client.delegate(request)
    expect(out).toEqual({ succeeded: false, error: { status: 502, code: 'delegated_key.response_invalid', message: `Platform returned ${problem}.` } })
    expect(JSON.stringify(out)).not.toMatch(/sk-tan-/)
    expect(calls[1]).toMatchObject({ method: 'DELETE', url: 'https://id.test/v1/keys/key_2' })
    expect(calls[1]!.headers.get('authorization')).toBe(`Bearer ${SOURCE}`)
  })

  it('names an untrusted child it could not revoke so the app can retire it', async () => {
    const { client } = platform(minted(3, d => { d.allowedModels = [] }), () => ({ status: 503, body: {} }))
    await expect(client.delegate(request)).resolves.toEqual({ succeeded: false, error: { status: 502,
      code: 'delegated_key.response_invalid', message: 'Platform returned a different model set.', unrevokedKeyId: 'key_3' } })
  })

  it('types Platform refusals by code and never carries the response body', async () => {
    const { client } = platform(
      () => ({ status: 402, body: { success: false, error: { code: 'INSUFFICIENT_BALANCE', message: 'secret detail' } } }),
      () => ({ status: 503, body: {} }),
      () => ({ status: 200, body: { success: true, data: {} } }),
    )
    const poor = await client.delegate(request)
    expect(poor).toMatchObject({ succeeded: false, error: { status: 402, code: 'delegated_key.payment_required' } })
    expect(JSON.stringify(poor)).not.toContain('secret detail')
    await expect(client.delegate(request)).resolves.toMatchObject({ succeeded: false, error: { code: 'delegated_key.unavailable' } })
    // Only Platform's 201 is a mint.
    await expect(client.delegate(request)).resolves.toMatchObject({ succeeded: false, error: { code: 'delegated_key.refused' } })
    await expect(client.delegate({ ...request, sourceKey: 'app-shared-key' }))
      .resolves.toMatchObject({ succeeded: false, error: { code: 'delegated_key.invalid_request' } })
  })
})

describe('createPlatformDelegatedKeyClient.verify, revoke and listChildren', () => {
  it("returns Platform's verify-by-id verdict for this key and fails closed on anything else", async () => {
    const { client, calls } = platform(
      () => ({ status: 200, body: { valid: true, keyId: 'key_1', budgetUsd: 10, budgetRemaining: 6, expiresAt: EXPIRES.toISOString() } }),
      () => ({ status: 200, body: { valid: false, invalidReason: 'key_revoked', keyId: 'key_1' } }),
      () => ({ status: 200, body: { valid: true } }),
      () => ({ status: 200, body: { success: false } }),
      () => ({ status: 502, body: {} }),
    )
    await expect(client.verify({ keyId: 'key_1', product: 'router' })).resolves.toEqual({ succeeded: true,
      value: { valid: true, budgetUsd: 10, budgetRemaining: 6, expiresAt: EXPIRES.toISOString() } })
    await expect(client.verify({ keyId: 'key_1', product: 'router' })).resolves.toEqual({ succeeded: true, value: { valid: false, invalidReason: 'key_revoked' } })
    // A valid verdict that does not name this key is not evidence about it.
    await expect(client.verify({ keyId: 'key_1', product: 'router' })).resolves.toMatchObject({ succeeded: false, error: { code: 'delegated_key.response_invalid' } })
    await expect(client.verify({ keyId: 'key_1', product: 'router' })).resolves.toMatchObject({ succeeded: false, error: { code: 'delegated_key.response_invalid' } })
    await expect(client.verify({ keyId: 'key_1', product: 'router' })).resolves.toMatchObject({ succeeded: false, error: { code: 'delegated_key.unavailable' } })
    expect(calls[0]!.body).toEqual({ keyId: 'key_1', expectedProduct: 'router' })
    expect(calls[0]!.headers.get('x-service-name')).toBe('tax-agent')
  })

  it('treats a key Platform no longer holds as revoked, and retires an SSO-source child through revoke-slot', async () => {
    const { client, calls } = platform(
      () => ({ status: 404, body: {} }),
      () => ({ status: 403, body: { success: false, error: { code: 'FORBIDDEN' } } }),
      () => ({ status: 200, body: { success: true, data: { revoked: 1 } } }),
      () => ({ status: 403, body: { success: false, error: { code: 'FORBIDDEN' } } }),
    )
    await expect(client.revoke({ sourceKey: SOURCE, keyId: 'key_9' })).resolves.toEqual({ succeeded: true, value: null })
    const slot = { userId: 'usr_payer', name: 'auto:tax-agent:router:ws-1:op-1', product: 'router', sourceKeyId: 'key_source' }
    await expect(client.revoke({ sourceKey: SOURCE, keyId: 'key_9', slot })).resolves.toEqual({ succeeded: true, value: null })
    expect(calls[2]).toMatchObject({ method: 'POST', url: 'https://id.test/v1/keys/auto-provisioned/revoke-slot' })
    expect(calls[2]!.body).toEqual({ ...slot, childKeyId: 'key_9' })
    expect(calls[2]!.headers.get('authorization')).toBe('Bearer svc-token')
    // Without a slot, a refused DELETE is reported, never assumed done.
    await expect(client.revoke({ sourceKey: SOURCE, keyId: 'key_9' })).resolves.toMatchObject({ succeeded: false })
  })

  it('lists live children in one canonical slot', async () => {
    const { client } = platform(() => ({ status: 200, body: { success: true, data: [
      { id: 'key_1', name: 'auto:tax-agent:router:ws-1:op-1', product: 'router' },
      { id: 'key_2', name: 'auto:tax-agent:router:ws-1:op-1', product: 'router', revokedAt: '2026-10-12T00:00:00Z' },
      { id: 'key_3', name: 'auto:tax-agent:router:ws-1:op-2', product: 'router' },
      { id: 'key_4', name: 'auto:tax-agent:sandbox:ws-1:op-1', product: 'sandbox' },
    ] } }))
    await expect(client.listChildren({ sourceKey: SOURCE, name: 'ws-1:op-1', product: 'router' }))
      .resolves.toEqual({ succeeded: true, value: [{ id: 'key_1' }] })
  })
})

describe('createDelegatedKeyProvisioner (for createIdentityBoundWorkspaceKeyManager)', () => {
  const provisioner = (client: ReturnType<typeof platform>['client']) => createDelegatedKeyProvisioner({ client, sourceKey: SOURCE,
    product: 'router', resource: { type: 'workspace', id: 'ws-1' }, monthlyBudgetUsd: 25, expect: { payerId: 'usr_payer' } })

  it('mints through the client with the manager-chosen name, budget and expiry', async () => {
    const { client, calls } = platform(minted(1))
    const created = await provisioner(client).createKey({ name: 'ws-1:op-1', product: 'router', budgetUsd: 25,
      expiresAt: EXPIRES.toISOString(), idempotencyKey: 'workspace-key:row-1' })
    expect(created).toMatchObject({ id: 'key_1', budgetUsd: 25, expiresAt: EXPIRES.toISOString() })
    expect(calls[0]!.body).toMatchObject({ name: 'auto:tax-agent:router:ws-1:op-1', budgetUsd: 25, monthlyBudgetUsd: 25,
      resourceType: 'workspace', resourceId: 'ws-1' })
  })

  it("maps Platform's verdict: gone is missing, spent is exhausted, a funding lapse is a temporary refusal", async () => {
    const { client } = platform(
      () => ({ status: 200, body: { valid: true, keyId: 'key_1', budgetUsd: 10, budgetRemaining: 6, expiresAt: EXPIRES.toISOString() } }),
      () => ({ status: 200, body: { valid: false, invalidReason: 'key_revoked', keyId: 'key_1' } }),
      () => ({ status: 200, body: { valid: false, invalidReason: 'budget_exhausted', keyId: 'key_1', budgetUsd: 10 } }),
      () => ({ status: 200, body: { valid: false, invalidReason: 'paid_access_required', keyId: 'key_1' } }),
    )
    const keys = provisioner(client)
    await expect(keys.getKey('key_1')).resolves.toEqual({ budgetUsd: 10, budgetSpent: 4, expiresAt: EXPIRES.toISOString() })
    const gone = await keys.getKey('key_1').catch((e: unknown) => e)
    expect(gone).toBeInstanceOf(DelegatedKeyMissingError)
    expect(gone).toMatchObject({ status: 404, code: 'not_found' })
    await expect(keys.getKey('key_1')).resolves.toEqual({ budgetUsd: 10, budgetSpent: 10 })
    const lapse = await keys.getKey('key_1').catch((e: unknown) => e)
    expect(lapse).toBeInstanceOf(DelegatedKeyRefusalError)
    expect(lapse).not.toBeInstanceOf(DelegatedKeyMissingError)
  })

  it('retires a key through revoke-slot when the SSO source may not DELETE it, even after a restart', async () => {
    const { client, calls } = platform(
      () => ({ status: 403, body: {} }),
      () => ({ status: 200, body: { success: true, data: { id: 'key_7', name: 'auto:tax-agent:router:ws-1:op-1', product: 'router' } } }),
      () => ({ status: 200, body: { success: true, data: { revoked: 1 } } }),
    )
    // A fresh provisioner: it never saw this key minted, so the slot name comes from Platform.
    const keys = createDelegatedKeyProvisioner({ client, sourceKey: SOURCE, product: 'router', payerId: 'usr_payer', expect: { sourceKeyId: 'key_source' } })
    await expect(keys.revokeKey('key_7')).resolves.toBeNull()
    expect(calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual(
      ['DELETE /v1/keys/key_7', 'GET /v1/keys/key_7', 'POST /v1/keys/auto-provisioned/revoke-slot'])
    expect(calls[2]!.body).toEqual({ userId: 'usr_payer', name: 'auto:tax-agent:router:ws-1:op-1', product: 'router',
      childKeyId: 'key_7', sourceKeyId: 'key_source' })
  })

  it('surfaces a refused mint as a typed error without a key', async () => {
    const { client } = platform(() => ({ status: 402, body: { success: false, error: { code: 'KEY_BUDGET_EXHAUSTED' } } }))
    const error = await provisioner(client).createKey({ name: 'ws-1:op-2', product: 'router', budgetUsd: 25,
      expiresAt: EXPIRES.toISOString(), idempotencyKey: 'k' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DelegatedKeyRefusalError)
    expect((error as DelegatedKeyRefusalError).refusal.code).toBe('delegated_key.budget_exhausted')
  })
})
