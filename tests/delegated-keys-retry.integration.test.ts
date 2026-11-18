/**
 * Platform's origin was unreachable for 84.8 s and 54.5 s across restarts on 2026-10-22, and each delegation that
 * failed then ended a member's Router turn. `retryUnavailable` keeps a turn-scoped mint asking through such a gap.
 * Since agent-container #19577, Platform also sheds a key write with 503 `PLATFORM_BUSY` and `Retry-After: 1` while
 * its one SQLite writer is backed up; every delegation, opted in or not, and `modelKey` wait that out inside 8 s.
 * Checked over real HTTP against a local server that answers 503 for a while and then mints.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createPlatformAgentSpend } from '../src/platform/agent-spend'
import { createPlatformDelegatedKeyClient, type DelegatedKeyRequest } from '../src/platform/delegated-keys'

const SOURCE = 'sk-tan-payer-linked-key-0001'
const BUSY_BUDGET_MS = 8_000

/**
 * A Platform that answers 503 to its first `down.calls` requests and to every request within `down.forMs` of its
 * first, then mints in its real 201 shape. The 503 is Platform's shed (`PLATFORM_BUSY`, `Retry-After: 1`) unless
 * `down.plain`, which answers a 503 that is not busy.
 */
async function platform(down: { calls?: number; forMs?: number; plain?: boolean } = {}) {
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
      if (attempts.length <= (down.calls ?? 0) || now - firstAt < (down.forMs ?? 0)) {
        if (down.plain) {
          res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ success: false, error: { code: 'INTERNAL_ERROR' } }))
        } else {
          res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' })
            .end(JSON.stringify({ success: false, error: { code: 'PLATFORM_BUSY', message: 'The platform is busy; retry the key write' } }))
        }
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
  const gaps = () => attempts.slice(1).map((at, index) => at - attempts[index]!)
  return { url, attempts, gaps, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

const request = (retryForMs?: number): DelegatedKeyRequest => ({
  sourceKey: SOURCE, name: 'turn:exec-1', product: 'router', allowedModels: ['gemini-3.7-flash'], budget: { usd: 5 },
  expiresAt: new Date(Date.now() + 30 * 60_000),
  ...(retryForMs === undefined ? {} : { retryUnavailable: { forMs: retryForMs } }),
})

const closers: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())) })

/** One Platform for an un-opted delegation and one for `modelKey`, each driven by its real client. */
async function bothCallers(down: Parameters<typeof platform>[0]) {
  const [delegation, spend] = await Promise.all([platform(down), platform(down)])
  closers.push(delegation.close, spend.close)
  const timed = async <T,>(run: () => Promise<T>) => {
    const started = Date.now()
    const outcome = await run()
    return { outcome, elapsedMs: Date.now() - started }
  }
  const [delegated, modelKey] = await Promise.all([
    timed(() => createPlatformDelegatedKeyClient({ platformUrl: delegation.url, serviceName: 'creative-agent', serviceToken: 'svc' })
      .delegate(request())),
    timed(() => createPlatformAgentSpend({ platformUrl: spend.url, serviceName: 'creative-agent', serviceToken: 'svc', product: 'creative-agent' })
      .modelKey({ agentKey: SOURCE, name: 'auto:turn-1', expiresAt: new Date(Date.now() + 30 * 60_000) })),
  ])
  return { delegation, spend, delegated, modelKey }
}

/** Each wait is Platform's Retry-After of 1 s times 1 + U[0, 1), plus a local round trip on a loaded gate host. */
function expectJitteredRetryAfter(gaps: number[]) {
  for (const gap of gaps) {
    expect(gap).toBeGreaterThanOrEqual(1_000)
    expect(gap).toBeLessThan(2_000 + 500)
  }
}

describe('delegate through a Platform outage', () => {
  it('uses the configured origin and current service token without caller boilerplate, and fails closed when absent', async () => {
    const p = await platform()
    closers.push(p.close)
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
    const p = await platform({ forMs: 1_200 })
    closers.push(p.close)
    const client = createPlatformDelegatedKeyClient({ platformUrl: p.url, serviceName: 'creative-agent', serviceToken: 'svc' })
    const outcome = await client.delegate(request(6_000))
    expect(outcome).toMatchObject({ succeeded: true, value: { id: 'key_child' } })
    expect(p.attempts.length).toBeGreaterThan(1)
    expect(p.attempts.at(-1)).toBeGreaterThanOrEqual(1_200)
  })

  it('returns the typed unavailable refusal when the outage outlasts the window', async () => {
    const p = await platform({ forMs: 60_000 })
    closers.push(p.close)
    const client = createPlatformDelegatedKeyClient({ platformUrl: p.url, serviceName: 'creative-agent', serviceToken: 'svc' })
    const started = Date.now()
    const outcome = await client.delegate(request(800))
    expect(outcome).toMatchObject({ succeeded: false, error: { status: 503, code: 'delegated_key.unavailable' } })
    expect(Date.now() - started).toBeLessThan(800 + 1_000)
    expect(p.attempts.length).toBeGreaterThan(1)
  })
})

describe('wait out a busy Platform by default', () => {
  it('mints for an un-opted delegation and for modelKey once a short backlog clears', async () => {
    const { delegation, spend, delegated, modelKey } = await bothCallers({ calls: 2 })
    expect(delegated.outcome).toMatchObject({ succeeded: true, value: { id: 'key_child' } })
    expect(modelKey.outcome).toEqual({ succeeded: true, value: { key: 'sk-tan-childxxxxxxxxxxxx', keyId: 'key_child' } })
    for (const p of [delegation, spend]) {
      expect(p.attempts).toHaveLength(3)
      expectJitteredRetryAfter(p.gaps())
    }
    for (const { elapsedMs } of [delegated, modelKey]) expect(elapsedMs).toBeLessThan(BUSY_BUDGET_MS)
  }, 20_000)

  it('keeps the unavailable refusal when the backlog outlasts the budget, and never runs past it', async () => {
    const { delegation, spend, delegated, modelKey } = await bothCallers({ calls: Number.POSITIVE_INFINITY })
    expect(delegated.outcome).toMatchObject({ succeeded: false, error: { status: 503, code: 'delegated_key.unavailable' } })
    expect(modelKey.outcome).toMatchObject({ succeeded: false, error: { status: 503, code: 'agent_key.spend_unavailable' } })
    for (const p of [delegation, spend]) {
      // 8 s holds four to seven waits of 1-2 s, each followed by an attempt with at least 250 ms left.
      expect(p.attempts.length).toBeGreaterThanOrEqual(4)
      expect(p.attempts.length).toBeLessThanOrEqual(8)
      expectJitteredRetryAfter(p.gaps())
    }
    for (const { elapsedMs } of [delegated, modelKey]) {
      expect(elapsedMs).toBeGreaterThan(BUSY_BUDGET_MS - 2_000 - 250)
      // An attempt still in flight at the deadline is cut off there; 100 ms covers timers on a loaded host.
      expect(elapsedMs).toBeLessThan(BUSY_BUDGET_MS + 100)
    }
    // Waits drawn from U[0, 1) are spread, so a shed burst does not come back in lockstep.
    const gaps = [...delegation.gaps(), ...spend.gaps()]
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeGreaterThan(100)
  }, 20_000)

  it('answers a 5xx that is not busy at once, with one request', async () => {
    const { delegation, spend, delegated, modelKey } = await bothCallers({ calls: Number.POSITIVE_INFINITY, plain: true })
    expect(delegated.outcome).toMatchObject({ succeeded: false, error: { status: 503, code: 'delegated_key.unavailable' } })
    expect(modelKey.outcome).toMatchObject({ succeeded: false, error: { status: 503, code: 'agent_key.spend_unavailable' } })
    expect(delegation.attempts).toHaveLength(1)
    expect(spend.attempts).toHaveLength(1)
  })
})
