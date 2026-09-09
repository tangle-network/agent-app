import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRouterProtectedModelPort, type RouterProtectedModelPortOptions } from './protected-model'

const model = 'anthropic/claude-haiku-4-5-20251001'
const grantDigest = `sha256:${'a'.repeat(64)}`
const token = `sk-tgr-${'b'.repeat(48)}`
const candidateOrigin = 'https://candidate-router.tangle.tools'
const activationEnv = {
  MODEL_GATEWAY_TOKEN: token, MODEL_GATEWAY_BASE_URL: `${candidateOrigin}/v1`,
  OPENAI_API_KEY: token, OPENAI_BASE_URL: `${candidateOrigin}/v1`,
  ANTHROPIC_API_KEY: token, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_BASE_URL: candidateOrigin,
}
const resolved = { requested: model, provider: 'anthropic', model, snapshot: model, reasoningEffort: 'none' }
function input(): Pick<RouterProtectedModelPortOptions, 'signal' | 'onSettlement'> { return {} }
function grantOptions(options = input()) {
  return {
    port: createRouterProtectedModelPort({ apiKey: 'parent-secret-must-stay-server-side', maxCostUsd: 0.1, signal: options.signal, onSettlement: options.onSettlement }),
    resolve: { requested: model, harness: 'cli-base' as const, reasoningEffort: 'none' as const },
    reserve: { executionId: 'execution', preparationId: 'preparation', bundleDigest: grantDigest as `sha256:${string}`, expiresAtMs: Date.now() + 60000, attempt: { number: 1, maxAttempts: 1, retryPolicy: 'none' as const }, limits: { maxModelCalls: 3, maxInputTokens: 1000000, maxOutputTokens: 384, maxCostUsd: 0.1 } },
    deadlineAtMs: Date.now() + 30000,
  }
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllGlobals())

async function activeGrant(options = input(), env: Record<string, string> = activationEnv, settlement: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    if (url.endsWith('/resolve')) return Response.json(resolved)
    if (url.endsWith('/reserve')) return Response.json({ preparationId: body.preparationId, digest: grantDigest, expiresAtMs: body.expiresAtMs, enforcedLimits: body.limits, network: { mode: 'gateway-only', domains: ['candidate-router.tangle.tools'] } })
    if (url.endsWith('/activate')) return Response.json({ env })
    return Response.json({ preparationId: body.preparationId, grantDigest, closed: true, usageWithinLimits: true, billing: { status: 'settled', authorizationId: 'hold-1', reservedCostUsdNanos: 100_000_000, settledCostUsdNanos: 0 }, calls: [], ...settlement })
  })
  vi.stubGlobal('fetch', fetchMock)
  const grant = grantOptions(options)
  const resolution = await grant.port.resolve(grant.resolve)
  const reservation = await grant.port.reserveGrant({ ...grant.reserve, resolved: resolution })
  const identity = { executionId: grant.reserve.executionId, preparationId: grant.reserve.preparationId, grantDigest: reservation.digest, resolved: resolution }
  return { grant, fetchMock, identity, activate: () => grant.port.activateGrant({ ...identity, deadlineAtMs: grant.deadlineAtMs }) }
}

describe('Router protected model transport', () => {
  it('sends the parent only to fixed control URLs and returns only the scoped token', async () => {
    const { activate, fetchMock } = await activeGrant()
    const activation = await activate()
    expect(activation.env.OPENAI_API_KEY).toBe(token)
    expect(JSON.stringify(activation)).not.toContain('parent-secret')
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toMatch(/^https:\/\/router\.tangle\.tools\/v1\/candidate-model-grants\/(resolve|reserve|activate)$/)
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer parent-secret-must-stay-server-side')
      expect(init?.redirect).toBe('error')
    }
  })

  it.each([
    { ...activationEnv, OPENAI_BASE_URL: 'https://attacker.example/v1' },
    { ...activationEnv, OPENAI_API_KEY: 'parent-secret-must-stay-server-side' },
    { ...activationEnv, EXTRA_SECRET: 'unexpected-secret' },
  ])('rejects changed gateway, token, or environment names', async (env) => {
    const { activate } = await activeGrant(input(), env)
    await expect(activate()).rejects.toThrow()
  })

  it('settles the grant after caller cancellation without forwarding the aborted signal', async () => {
    const controller = new AbortController()
    const { activate, grant, identity, fetchMock } = await activeGrant({ ...input(), signal: controller.signal })
    await activate()
    controller.abort(new Error('caller left'))
    await grant.port.settleGrant({ ...identity, reason: 'failed' })
    const request = fetchMock.mock.calls.at(-1)
    expect(request?.[0]).toMatch(/\/settle$/)
    expect(request?.[1]?.signal?.aborted).toBe(false)
  })

  it('keeps the draining retry code while hiding provider response text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'candidate_grant_draining', message: 'parent-secret-must-stay-server-side' } }, { status: 409 })))
    const grant = grantOptions(input())
    await expect(grant.port.resolve(grant.resolve)).rejects.toThrow('candidate_grant_draining')
    await expect(grant.port.resolve(grant.resolve)).rejects.not.toThrow('parent-secret')
  })
  it('validates paid usage before retaining the complete Router billing receipt', async () => {
    const onSettlement = vi.fn()
    const call = { callId: 'call-1', generationId: 'generation-1', traceSpanId: 'generation-1', status: 'succeeded', model, startedAtMs: Date.now() - 10, endedAtMs: Date.now(), inputTokens: 12, accountedInputTokens: 20, outputTokens: 5, cachedInputTokens: 0, cacheWriteTokens: 8, cacheWrite5mTokens: 8, cacheWrite1hTokens: 0, reasoningTokens: 0, costUsdNanos: 1000 }
    const billing = { status: 'settled', authorizationId: 'hold-1', transactionId: 'transaction-1', reservedCostUsdNanos: 100_000_000, settledCostUsdNanos: 1000 }
    const { activate, grant, identity } = await activeGrant({ onSettlement }, activationEnv, { calls: [call], billing })
    await activate()
    const result = await grant.port.settleGrant({ ...identity, reason: 'completed' })
    expect(result.calls[0]).toMatchObject({ accountedInputTokens: 20, costUsdNanos: 1000 })
    expect(result.calls[0]).not.toHaveProperty('cacheWriteTokens')
    expect(onSettlement).toHaveBeenCalledWith(expect.objectContaining({ calls: [call], billing }))
  })

  it.each([
    { status: 'settled', authorizationId: 'hold-1', reservedCostUsdNanos: 100_000_000, settledCostUsdNanos: 0, unknown: true },
    { status: 'settled', authorizationId: 'hold-1', reservedCostUsdNanos: 100_000_000, settledCostUsdNanos: 1 },
    { status: 'reserved', authorizationId: 'hold-1', reservedCostUsdNanos: 100_000_000, settledCostUsdNanos: 0 },
    { status: 'settled', authorizationId: 'hold-1', reservedCostUsdNanos: 200_000_000, settledCostUsdNanos: 0 },
  ])('refuses an unreconciled or incomplete billing receipt', async (billing) => {
    const onSettlement = vi.fn()
    const { activate, grant, identity } = await activeGrant({ onSettlement }, activationEnv, { billing })
    await activate()
    await expect(grant.port.settleGrant({ ...identity, reason: 'completed' })).rejects.toThrow()
    expect(onSettlement).not.toHaveBeenCalled()
  })

})
