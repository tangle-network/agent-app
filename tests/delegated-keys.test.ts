import { describe, expect, it, vi } from 'vitest'
import {
  createDelegatedKeyProvider,
  createPlatformDelegatedKeyClient,
  type DelegatedKeySlot,
} from '../src/platform/delegated-keys'

const NOW = Date.parse('2026-10-12T01:00:00Z')
const SOURCE = 'sk-tan-payer-linked-key-0001'

interface Call { url: string; method: string; headers: Headers; body: Record<string, unknown> | null }

/** A fake Platform: answers each request with the next queued response. */
function platform(...responses: Array<(call: Call) => { status: number; body?: unknown }>) {
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

/** Platform's 201 for a delegate call, echoing the request unless overridden. */
const minted = (n: number, override: Record<string, unknown> = {}) => (call: Call) => ({ status: 201, body: { success: true, data: {
  id: `key_${n}`, key: `sk-tan-child-${n}-xxxxxxxx`, name: call.body!.name, product: call.body!.product,
  allowedModels: call.body!.allowedModels, expiresAt: call.body!.expiresAt, ...override,
} } })
const gone = () => ({ status: 404, body: { success: false } })

const slot: DelegatedKeySlot = { sourceKey: SOURCE, name: 'auto:tax-agent:router:turn-1', product: 'router',
  allowedModels: ['gpt-6-luna', 'kimi-k2.7'], budget: { usd: 1, monthlyUsd: 1 }, ttlMs: 30 * 60_000 }

describe('createPlatformDelegatedKeyClient', () => {
  it('delegates a scoped child with no control-plane scopes and returns the expiry Platform granted', async () => {
    const granted = new Date(NOW + 20 * 60_000).toISOString()
    const { client, calls } = platform(minted(1, { expiresAt: granted }))
    const out = await client.delegate({ ...slot, resource: { type: 'tax-turn', id: 'exec-1' }, expiresAt: new Date(NOW + 30 * 60_000) })
    expect(out).toMatchObject({ succeeded: true, value: { key: 'sk-tan-child-1-xxxxxxxx', id: 'key_1', product: 'router' } })
    expect(out.succeeded && out.value.expiresAt.toISOString()).toBe(granted)
    expect(calls[0]!.url).toBe('https://id.test/v1/keys/delegate')
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer svc-token')
    expect(calls[0]!.headers.get('x-service-name')).toBe('tax-agent')
    expect(calls[0]!.body).toEqual({ sourceKey: SOURCE, name: 'auto:tax-agent:router:turn-1', product: 'router',
      resourceType: 'tax-turn', resourceId: 'exec-1', budgetUsd: 1, monthlyBudgetUsd: 1,
      allowedModels: ['gpt-6-luna', 'kimi-k2.7'], scopes: [], expiresAt: new Date(NOW + 30 * 60_000).toISOString() })
  })

  it('revokes and refuses a child that does not match the request, without leaking it', async () => {
    const { client, calls } = platform(minted(2, { allowedModels: ['gpt-6-luna'] }), () => ({ status: 200, body: { success: true } }))
    const out = await client.delegate({ ...slot, expiresAt: new Date(NOW + 60_000) })
    expect(out).toEqual({ succeeded: false, error: { status: 502, code: 'delegated_key.response_invalid',
      message: 'Platform returned a different model set.' } })
    expect(JSON.stringify(out)).not.toContain('sk-tan-child')
    expect(calls[1]).toMatchObject({ method: 'DELETE', url: 'https://id.test/v1/keys/key_2' })
    expect(calls[1]!.headers.get('authorization')).toBe(`Bearer ${SOURCE}`)
  })

  it('types Platform refusals by code and never carries the response body', async () => {
    const { client } = platform(
      () => ({ status: 402, body: { success: false, error: { code: 'INSUFFICIENT_BALANCE', message: 'secret detail' } } }),
      () => ({ status: 503, body: {} }),
    )
    const poor = await client.delegate({ ...slot, expiresAt: new Date(NOW + 60_000) })
    expect(poor).toMatchObject({ succeeded: false, error: { status: 402, code: 'delegated_key.payment_required' } })
    expect(JSON.stringify(poor)).not.toContain('secret detail')
    await expect(client.delegate({ ...slot, expiresAt: new Date(NOW + 60_000) }))
      .resolves.toMatchObject({ succeeded: false, error: { code: 'delegated_key.unavailable' } })
    await expect(client.delegate({ ...slot, sourceKey: 'app-shared-key', expiresAt: new Date(NOW + 60_000) }))
      .resolves.toMatchObject({ succeeded: false, error: { code: 'delegated_key.invalid_request' } })
  })

  it('treats a key Platform no longer holds as revoked, and reads a revoked or expired key as not live', async () => {
    const { client } = platform(gone,
      () => ({ status: 200, body: { success: true, data: { expiresAt: new Date(NOW + 60_000).toISOString(), revokedAt: '2026-10-12T00:59:00Z' } } }),
      () => ({ status: 200, body: { success: true, data: { expiresAt: new Date(NOW - 1).toISOString() } } }))
    await expect(client.revoke({ sourceKey: SOURCE, keyId: 'key_9' })).resolves.toEqual({ succeeded: true, value: null })
    await expect(client.status({ sourceKey: SOURCE, keyId: 'key_9' })).resolves.toMatchObject({ value: { live: false } })
    await expect(client.status({ sourceKey: SOURCE, keyId: 'key_9' })).resolves.toMatchObject({ value: { live: false } })
  })
})

describe('createDelegatedKeyProvider', () => {
  it('reuses a slot key while it has its minimum life left, then mints a fresh one', async () => {
    let now = NOW
    const { client, calls } = platform(minted(1), minted(2))
    const provider = createDelegatedKeyProvider({ client, now: () => now, minRemainingMs: 5 * 60_000 })
    const first = await provider.keyFor(slot)
    expect((await provider.keyFor(slot))).toEqual(first)
    now = NOW + 26 * 60_000 // 4 minutes left: under the 5-minute margin
    const second = await provider.keyFor(slot)
    expect(second.succeeded && second.value.id).toBe('key_2')
    expect(calls).toHaveLength(2)
  })

  it('refuses a revoked, rejected or expired key on its next use and never hands it out again', async () => {
    let now = NOW
    const { client, calls } = platform(minted(1), () => ({ status: 200, body: { success: true } }), minted(2), minted(3))
    const provider = createDelegatedKeyProvider({ client, now: () => now })
    const first = await provider.keyFor(slot)
    if (!first.succeeded) throw new Error('mint failed')
    expect(provider.assertUsable(first.value)).toMatchObject({ succeeded: true })

    await provider.revoke({ sourceKey: SOURCE, key: first.value })
    expect(provider.assertUsable(first.value)).toMatchObject({ succeeded: false, error: { code: 'delegated_key.revoked' } })
    const second = await provider.keyFor(slot)
    expect(second.succeeded && second.value.id).toBe('key_2')

    // Router answered 401 for the second key: the app reports it and gets a fresh one.
    provider.reject(second.succeeded ? second.value.key : '')
    const third = await provider.keyFor(slot)
    expect(third.succeeded && third.value.id).toBe('key_3')

    now = NOW + 31 * 60_000
    expect(third.succeeded && provider.assertUsable(third.value)).toMatchObject({ succeeded: false, error: { code: 'delegated_key.expired' } })
    expect(calls.map(call => call.method)).toEqual(['POST', 'DELETE', 'POST', 'POST'])
  })

  it('with verifyOnReuse, a key revoked elsewhere is detected before it is handed out', async () => {
    const { client, calls } = platform(minted(1), gone, minted(2))
    const provider = createDelegatedKeyProvider({ client, now: () => NOW, verifyOnReuse: true })
    await provider.keyFor(slot)
    const next = await provider.keyFor(slot)
    expect(next.succeeded && next.value.id).toBe('key_2')
    expect(calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual(
      ['POST /v1/keys/delegate', 'GET /v1/keys/key_1', 'POST /v1/keys/delegate'])
  })

  it('keeps separate slots per payer, model set and budget', async () => {
    const { client } = platform(minted(1), minted(2), minted(3))
    const provider = createDelegatedKeyProvider({ client, now: () => NOW })
    const a = await provider.keyFor(slot)
    const b = await provider.keyFor({ ...slot, allowedModels: ['gpt-6-luna'] })
    const c = await provider.keyFor({ ...slot, sourceKey: 'sk-tan-another-payer-0002' })
    expect([a, b, c].map(out => out.succeeded && out.value.id)).toEqual(['key_1', 'key_2', 'key_3'])
  })
})
