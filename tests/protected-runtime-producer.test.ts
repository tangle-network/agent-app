import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentCandidateModelPort } from '@tangle-network/agent-runtime/candidate-execution'
import { createRouterProtectedModelPort } from '../src/runtime/protected-model'
import { createProtectedRuntimeChatProducer, type ProtectedRuntimeChatOptions } from '../src/chat-routes/protected-runtime-producer'

const digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const
const model = 'anthropic/claude-haiku-4-5-20251001'

function fixture() {
  const resolved = { requested: model, model, snapshot: model, provider: 'anthropic', reasoningEffort: 'none' as const }
  const settle = vi.fn<AgentCandidateModelPort['settleGrant']>(async input => ({
    preparationId: input.preparationId, grantDigest: digest, closed: true, usageWithinLimits: true,
    calls: [{ callId: 'call-1', generationId: 'generation-1', traceSpanId: 'generation-1',
      model, status: 'succeeded', startedAtMs: 1, endedAtMs: 2,
      inputTokens: 3, accountedInputTokens: 3, outputTokens: 2, cachedInputTokens: 0,
      reasoningTokens: 0, costUsdNanos: 100_000, costProvenance: 'observed' }],
  }))
  const port: AgentCandidateModelPort = {
    resolve: async () => resolved,
    reserveGrant: async input => ({ preparationId: input.preparationId, digest,
      expiresAtMs: input.expiresAtMs, enforcedLimits: input.limits,
      network: { mode: 'gateway-only', domains: ['candidate-router.tangle.tools'] } }),
    activateGrant: async () => ({ env: { OPENAI_API_KEY: 'scoped-fixture-token',
      OPENAI_BASE_URL: 'https://candidate-router.tangle.tools/v1' } }),
    settleGrant: settle,
  }
  const options: ProtectedRuntimeChatOptions = {
    profile: { name: 'protected-test', harness: 'cli-base', prompt: { systemPrompt: 'Use the available tools.' },
      model: { provider: 'tangle-router', default: model, reasoningEffort: 'none', maxVisibleOutputTokens: 100 } },
    prompt: 'Read the current brief and save a useful finding.', tools: [], maxToolCalls: 2,
    grant: { port, resolve: { requested: model, harness: 'cli-base', reasoningEffort: 'none' },
      reserve: { executionId: 'execution-1', preparationId: 'preparation-1', bundleDigest: digest,
        expiresAtMs: Date.now() + 30_000, attempt: { number: 1, maxAttempts: 1, retryPolicy: 'none' },
        limits: { maxModelCalls: 3, maxInputTokens: 1000, maxOutputTokens: 100, maxCostUsd: 1 } },
      deadlineAtMs: Date.now() + 20_000 },
  }
  return { options, settle }
}

function response(message: Record<string, unknown>) {
  return Response.json({ id: 'completion-1', object: 'chat.completion', model,
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }, cost: 0.0001 })
}

async function drain(producer: ReturnType<typeof createProtectedRuntimeChatProducer>) {
  const events = []
  for await (const event of producer.stream) events.push(event)
  return events
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('protected Runtime chat producer', () => {
  it('uses the real Runtime executor and publishes only settled usage', async () => {
    const { options, settle } = fixture()
    const inference = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://candidate-router.tangle.tools/v1/chat/completions')
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer scoped-fixture-token')
      return response({ content: 'A useful finding.' })
    })
    vi.stubGlobal('fetch', inference)
    const producer = createProtectedRuntimeChatProducer(options)
    expect(producer.usage?.()).toEqual({})
    const events = await drain(producer)
    expect(inference).toHaveBeenCalledOnce()
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ reason: 'completed' }))
    expect(events.some(event => event.type === 'error')).toBe(false)
    expect(producer.finalText()).toBe('A useful finding.')
    expect(producer.usage?.()).toEqual({ inputTokens: 3, outputTokens: 2, reasoningTokens: 0, costUsd: 0.0001 })
  })

  it('retains the validated charge when the real transport audit callback fails after settlement', async () => {
    const { options } = fixture()
    const fixturePort = options.grant.port
    const audit = vi.fn(async () => { throw new Error('Synthetic audit database unavailable') })
    const token = `sk-tgr-${'x'.repeat(48)}`
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      requests.push(url)
      if (url === 'https://candidate-router.tangle.tools/v1/chat/completions') {
        expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${token}`)
        return response({ content: 'Charged work completed.' })
      }
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-parent-key')
      const body = JSON.parse(String(init.body))
      if (url.endsWith('/resolve')) return Response.json(await fixturePort.resolve(body))
      if (url.endsWith('/reserve')) return Response.json(await fixturePort.reserveGrant(body))
      if (url.endsWith('/activate')) return Response.json({ env: {
        MODEL_GATEWAY_TOKEN: token, MODEL_GATEWAY_BASE_URL: 'https://candidate-router.tangle.tools/v1',
        OPENAI_API_KEY: token, OPENAI_BASE_URL: 'https://candidate-router.tangle.tools/v1',
        ANTHROPIC_API_KEY: token, ANTHROPIC_AUTH_TOKEN: token,
        ANTHROPIC_BASE_URL: 'https://candidate-router.tangle.tools',
      } })
      if (url.endsWith('/settle')) {
        const settlement = await fixturePort.settleGrant(body)
        return Response.json({ ...settlement,
          calls: settlement.calls.map(({ costProvenance: _provenance, ...call }) => ({ ...call,
            cacheWriteTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 })),
          billing: { status: 'settled', authorizationId: 'synthetic-authorization', transactionId: 'synthetic-transaction',
            reservedCostUsdNanos: 1_000_000_000, settledCostUsdNanos: 100_000 },
        })
      }
      throw new Error(`Unexpected fixture URL ${url}`)
    }))
    options.grant = { ...options.grant, port: createRouterProtectedModelPort({ apiKey: 'synthetic-parent-key', maxCostUsd: 1, onSettlement: audit }) }
    const producer = createProtectedRuntimeChatProducer(options)
    const events = await drain(producer)
    expect(requests.map(url => url.split('/').at(-1))).toEqual(['resolve', 'reserve', 'activate', 'completions', 'settle'])
    expect(audit).toHaveBeenCalledOnce()
    expect(producer.usage?.()).toEqual({ inputTokens: 3, outputTokens: 2, reasoningTokens: 0, costUsd: 0.0001 })
    expect(events.some(event => event.type === 'error')).toBe(true)
    expect(JSON.stringify(events)).toContain('audit record could not be saved')
    expect(JSON.stringify(events)).not.toContain('synthetic-parent-key')
    expect(events).toContainEqual({ type: 'usage', usage: { promptTokens: 3, completionTokens: 2,
      reasoningTokens: 0, toolTokens: 0, providerCostUsd: 0.0001, toolCallCount: 0, budgetEnforced: true } })
  })

  it('refuses tool calls beyond the cap before executing their effects', async () => {
    const { options, settle } = fixture()
    const effect = vi.fn(async () => ({ saved: true }))
    options.tools = [{ name: 'save', description: 'Save a finding.', inputSchema: { type: 'object' }, run: effect }]
    options.profile.tools = { save: true }
    options.maxToolCalls = 1
    vi.stubGlobal('fetch', vi.fn(async () => response({ content: null, tool_calls: [
      { id: 'first', type: 'function', function: { name: 'save', arguments: '{}' } },
      { id: 'second', type: 'function', function: { name: 'save', arguments: '{}' } },
    ] })))
    const producer = createProtectedRuntimeChatProducer(options)
    const events = await drain(producer)
    expect(events.findIndex(event => event.type === 'usage')).toBeLessThan(events.findIndex(event => event.type === 'error'))
    expect(effect).toHaveBeenCalledOnce()
    expect(events.some(event => event.type === 'error')).toBe(true)
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ reason: 'failed' }))
    expect(producer.usage?.()).toEqual({ inputTokens: 3, outputTokens: 2, reasoningTokens: 0, costUsd: 0.0001 })
  })

  it('preserves an over-limit charge without certifying budget enforcement', async () => {
    const { options, settle } = fixture()
    const original = settle.getMockImplementation()!
    settle.mockImplementation(async input => ({ ...await original(input), usageWithinLimits: false }))
    vi.stubGlobal('fetch', vi.fn(async () => response({ content: 'Completed work.' })))
    const producer = createProtectedRuntimeChatProducer(options)
    const events = await drain(producer)
    expect(producer.usage?.()).toEqual({ inputTokens: 3, outputTokens: 2, reasoningTokens: 0, costUsd: 0.0001 })
    expect(events).toContainEqual({ type: 'usage', usage: { promptTokens: 3, completionTokens: 2,
      reasoningTokens: 0, toolTokens: 0, providerCostUsd: 0.0001, toolCallCount: 0, budgetEnforced: false } })
    expect(events.some(event => event.type === 'error')).toBe(true)
  })

  it('does no preparation or inference after cancellation', async () => {
    const { options, settle } = fixture()
    const reserve = vi.spyOn(options.grant.port, 'reserveGrant')
    options.signal = AbortSignal.abort()
    vi.stubGlobal('fetch', vi.fn())
    const events = await drain(createProtectedRuntimeChatProducer(options))
    expect(events.some(event => event.type === 'error')).toBe(true)
    expect(reserve).not.toHaveBeenCalled()
    expect(settle).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('retains paid usage when cancellation interrupts an active tool', async () => {
    const { options, settle } = fixture()
    const controller = new AbortController()
    options.signal = controller.signal
    options.profile.tools = { read: true }
    const tool = vi.fn(async () => {
      controller.abort()
      throw new Error('Read cancelled')
    })
    options.tools = [{ name: 'read', description: 'Read a brief.', inputSchema: { type: 'object' }, run: tool }]
    const inference = vi.fn(async () => response({ content: null, tool_calls: [
      { id: 'read-1', type: 'function', function: { name: 'read', arguments: '{}' } },
    ] }))
    vi.stubGlobal('fetch', inference)
    const producer = createProtectedRuntimeChatProducer(options)
    const events = await drain(producer)
    expect(tool).toHaveBeenCalledOnce()
    expect(inference).toHaveBeenCalledOnce()
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ reason: 'failed' }))
    expect(producer.usage?.()).toEqual({ inputTokens: 3, outputTokens: 2, reasoningTokens: 0, costUsd: 0.0001 })
    expect(events.some(event => event.type === 'error')).toBe(true)
    expect(events).toContainEqual({ type: 'usage', usage: { promptTokens: 3, completionTokens: 2,
      providerCostUsd: 0.0001, reasoningTokens: 0, toolTokens: 0, toolCallCount: 1, budgetEnforced: true } })
  })

  it('settles without dispatch when preparation outlives the deadline', async () => {
    const { options, settle } = fixture()
    const activate = options.grant.port.activateGrant
    options.grant.port.activateGrant = async input => {
      vi.spyOn(Date, 'now').mockReturnValue(options.grant.deadlineAtMs + 1)
      return activate(input)
    }
    vi.stubGlobal('fetch', vi.fn())
    const events = await drain(createProtectedRuntimeChatProducer(options))
    expect(fetch).not.toHaveBeenCalled()
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ reason: 'failed' }))
    expect(events.some(event => event.type === 'error')).toBe(true)
  })

  it('keeps settled usage when the caller stops reading after a tool event', async () => {
    const { options, settle } = fixture()
    options.profile.tools = { read: true }
    options.tools = [{ name: 'read', description: 'Read.', inputSchema: { type: 'object' }, run: async () => 'brief' }]
    vi.stubGlobal('fetch', vi.fn(async () => response({ content: null, tool_calls: [
      { id: 'read-1', type: 'function', function: { name: 'read', arguments: '{}' } },
    ] })))
    const producer = createProtectedRuntimeChatProducer(options)
    for await (const event of producer.stream) {
      if (event.type === 'tool_call') break
    }
    expect(settle).toHaveBeenCalledOnce()
    expect(producer.usage?.()).toEqual({ inputTokens: 3, outputTokens: 2, reasoningTokens: 0, costUsd: 0.0001 })
  })
})
