/**
 * Platform's origin was unreachable for 84.8 s and 54.5 s across restarts on 2026-10-22, and each delegation that
 * failed then ended a member's Router turn. `retryUnavailable` keeps a turn-scoped mint asking through such a gap.
 * Checked over real HTTP against a local server that answers 503 for a while and then mints, scaled to milliseconds.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createPlatformDelegatedKeyClient, type DelegatedKeyRequest } from '../src/platform/delegated-keys'

const SOURCE = 'sk-tan-payer-linked-key-0001'

/** A Platform that cannot answer until `downForMs` after its first request, then mints in its real 201 shape. */
async function platform(downForMs: number) {
  let firstAt: number | undefined
  const attempts: number[] = []
  const received: Array<{ path: string | undefined; authorization: string | undefined; service: string | string[] | undefined }> = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const now = Date.now()
      firstAt ??= now
      attempts.push(now - firstAt)
      received.push({ path: req.url, authorization: req.headers.authorization, service: req.headers['x-service-name'] })
      if (now - firstAt < downForMs) {
        res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ success: false, error: { code: 'PLATFORM_BUSY' } }))
        return
      }
      const body = JSON.parse(raw) as Record<string, any>
      res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ success: true, data: {
        id: 'key_child', key: 'sk-tan-childxxxxxxxxxxxx', prefix: 'sk-tan-child', name: body.name,
        provisionedByService: 'creative-agent', product: body.product, scopes: null,
        budgetUsd: body.budgetUsd ?? null, allowedModels: body.allowedModels ?? null,
        attribution: { version: 1, targetService: body.product, delegatedFromKeyId: 'key_source', payerType: 'user',
          payerId: 'usr_payer', resourceType: null, resourceId: null, expiresAt: body.expiresAt },
      } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, attempts, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

const request = (retryForMs?: number): DelegatedKeyRequest => ({
  sourceKey: SOURCE, name: 'turn:exec-1', product: 'router', allowedModels: ['gemini-3.7-flash'], budget: { usd: 5 },
  expiresAt: new Date(Date.now() + 30 * 60_000),
  ...(retryForMs === undefined ? {} : { retryUnavailable: { forMs: retryForMs } }),
})

let close: (() => Promise<void>) | undefined
afterEach(async () => { await close?.(); close = undefined })

describe('delegate through a Platform outage', () => {
  it('uses the configured origin and current service token without caller boilerplate, and fails closed when absent', async () => {
    const p = await platform(0)
    close = p.close
    const names = ['TANGLE_PLATFORM_URL', 'TANGLE_SSO_URL', 'PLATFORM_SERVICE_TOKEN'] as const
    const previous = names.map(name => process.env[name])
    try {
      delete process.env.TANGLE_PLATFORM_URL
      process.env.TANGLE_SSO_URL = `${p.url}/auth/callback`
      delete process.env.PLATFORM_SERVICE_TOKEN
      const client = createPlatformDelegatedKeyClient({ serviceName: 'creative-agent' })
      await expect(client.delegate(request())).rejects.toThrow('PLATFORM_SERVICE_TOKEN is required')
      expect(p.received).toHaveLength(0)
      process.env.PLATFORM_SERVICE_TOKEN = 'fixture-service-one'
      expect(await client.delegate(request())).toMatchObject({ succeeded: true })
      process.env.PLATFORM_SERVICE_TOKEN = 'fixture-service-two'
      expect(await client.delegate(request())).toMatchObject({ succeeded: true })
      expect(p.received).toEqual([
        { path: '/v1/keys/delegate', authorization: 'Bearer fixture-service-one', service: 'creative-agent' },
        { path: '/v1/keys/delegate', authorization: 'Bearer fixture-service-two', service: 'creative-agent' },
      ])
      process.env.TANGLE_PLATFORM_URL = `${p.url}/platform/path`
      process.env.TANGLE_SSO_URL = 'http://127.0.0.1:1/unreachable'
      expect(await createPlatformDelegatedKeyClient({ serviceName: 'creative-agent' }).delegate(request()))
        .toMatchObject({ succeeded: true })
      expect(p.received[2]?.path).toBe('/v1/keys/delegate')
      delete process.env.TANGLE_PLATFORM_URL
      delete process.env.TANGLE_SSO_URL
      expect(() => createPlatformDelegatedKeyClient({ serviceName: 'creative-agent' })).toThrow('TANGLE_PLATFORM_URL is required')
    } finally {
      names.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name]
        else process.env[name] = previous[index]
      })
    }
  })

  it('completes the mint once Platform answers again inside the retry window', async () => {
    const p = await platform(1_200)
    close = p.close
    const client = createPlatformDelegatedKeyClient({ platformUrl: p.url, serviceName: 'creative-agent', serviceToken: 'svc' })
    const outcome = await client.delegate(request(6_000))
    expect(outcome).toMatchObject({ succeeded: true, value: { id: 'key_child' } })
    expect(p.attempts.length).toBeGreaterThan(1)
    expect(p.attempts.at(-1)).toBeGreaterThanOrEqual(1_200)
  })

  it('returns the typed unavailable refusal when the outage outlasts the window, and never retries without one', async () => {
    const p = await platform(60_000)
    close = p.close
    const client = createPlatformDelegatedKeyClient({ platformUrl: p.url, serviceName: 'creative-agent', serviceToken: 'svc' })
    const started = Date.now()
    const outcome = await client.delegate(request(800))
    expect(outcome).toMatchObject({ succeeded: false, error: { status: 503, code: 'delegated_key.unavailable' } })
    expect(Date.now() - started).toBeLessThan(800 + 1_000)
    const before = p.attempts.length
    expect(before).toBeGreaterThan(1)
    expect(await client.delegate(request())).toMatchObject({ succeeded: false, error: { code: 'delegated_key.unavailable' } })
    expect(p.attempts.length).toBe(before + 1)
  })
})
