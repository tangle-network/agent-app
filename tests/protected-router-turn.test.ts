import { describe, expect, it, vi } from 'vitest'
import { runProtectedRouterTurn, type RouterTurnGrant } from '../src/runtime/protected-router-turn'
import type { RouterTurnTool } from '../src/runtime/router-turn'

/** One buffered Router chat completion. */
const completion = (message: Record<string, unknown>) => Response.json({ model: 'served/model',
  choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2 } })
const calls = (...names: string[]) => names.map((name, index) => ({ id: `call-${index + 1}`, type: 'function',
  function: { name, arguments: JSON.stringify({ title: `Task ${index + 1}` }) } }))
const createTask: RouterTurnTool = {
  name: 'staff.task.create',
  description: 'Create a task.',
  inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  run: vi.fn(async (args: Record<string, unknown>) => ({ taskId: 'task-1', title: args.title })),
}

describe('runProtectedRouterTurn', () => {
  const digest = `sha256:${'a'.repeat(64)}` as const
  function grant(options: { usageWithinLimits?: boolean; deadlineAtMs?: number } = {}) {
    const settle = vi.fn<RouterTurnGrant['port']['settleGrant']>(async input => ({
      preparationId: input.preparationId, grantDigest: digest, closed: true, usageWithinLimits: options.usageWithinLimits ?? true,
      calls: [{ callId: 'call-1', generationId: 'g-1', traceSpanId: 'g-1', model: 'openai/m', status: 'succeeded',
        startedAtMs: 1, endedAtMs: 2, inputTokens: 3, accountedInputTokens: 3, outputTokens: 2, cachedInputTokens: 0,
        reasoningTokens: 0, costUsdNanos: 100_000, costProvenance: 'observed' }],
    }))
    const value: RouterTurnGrant = {
      port: {
        resolve: async () => ({ requested: 'openai/m', model: 'openai/m', snapshot: 'openai/m', provider: 'openai', reasoningEffort: 'none' }),
        reserveGrant: async input => ({ preparationId: input.preparationId, digest, expiresAtMs: input.expiresAtMs,
          enforcedLimits: input.limits, network: { mode: 'gateway-only', domains: ['candidate-router.test'] } }),
        activateGrant: async () => ({ env: { OPENAI_API_KEY: 'scoped-key', OPENAI_BASE_URL: 'https://candidate-router.test/v1' } }),
        settleGrant: settle,
      },
      resolve: { requested: 'openai/m', harness: 'cli-base', reasoningEffort: 'none' },
      reserve: { executionId: 'e-1', preparationId: 'p-1', bundleDigest: digest, expiresAtMs: Date.now() + 60_000,
        attempt: { number: 1, maxAttempts: 1, retryPolicy: 'none' },
        limits: { maxModelCalls: 3, maxInputTokens: 1000, maxOutputTokens: 100, maxCostUsd: 1 } },
      deadlineAtMs: options.deadlineAtMs ?? Date.now() + 60_000,
    }
    return { grant: value, settle }
  }
  function grantedRouter(...responses: Response[]) {
    const seen: Array<{ url: string; authorization: string | null }> = []
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') })
      const next = responses.shift()
      if (!next) throw new Error('unexpected model call')
      return next
    })
    return { fetchImpl: fetchImpl as unknown as typeof fetch, seen, calls: fetchImpl }
  }

  it('calls the model with the activated scoped key, settles completed, and carries the settled usage', async () => {
    const { grant: value, settle } = grant()
    const { fetchImpl, seen } = grantedRouter(completion({ content: 'A finding.' }))
    const outcome = await runProtectedRouterTurn({ grant: value, model: 'openai/m', fetchImpl, stream: false, systemPrompt: 's', userMessage: 'u' })
    expect(seen).toEqual([{ url: 'https://candidate-router.test/v1/chat/completions', authorization: 'Bearer scoped-key' }])
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ reason: 'completed' }))
    expect(outcome.failure).toBeUndefined()
    expect(outcome.text).toBe('A finding.')
    expect(outcome.settlement).toMatchObject({ model: 'openai/m', budgetEnforced: true,
      usage: { inputTokens: 3, outputTokens: 2, reasoningTokens: 0, costUsd: 0.0001 } })
  })

  it('settles a failed model call as failed after one request and returns its code', async () => {
    const { grant: value, settle } = grant()
    const { fetchImpl, calls: modelCalls } = grantedRouter(new Response('busy', { status: 503 }), completion({ content: 'Never read.' }))
    const outcome = await runProtectedRouterTurn({ grant: value, model: 'openai/m', fetchImpl, stream: false, systemPrompt: 's', userMessage: 'u' })
    expect(modelCalls).toHaveBeenCalledOnce()
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ reason: 'failed' }))
    expect(outcome.failure).toMatchObject({ code: 'model_http_503', status: 503 })
    expect(outcome.settlement?.usage.costUsd).toBe(0.0001)
  })

  it('keeps the answer but fails the turn when the settlement exceeded the grant limits', async () => {
    const { grant: value } = grant({ usageWithinLimits: false })
    const { fetchImpl } = grantedRouter(completion({ content: 'A finding.' }))
    const outcome = await runProtectedRouterTurn({ grant: value, model: 'openai/m', fetchImpl, stream: false, systemPrompt: 's', userMessage: 'u' })
    expect(outcome.text).toBe('A finding.')
    expect(outcome.failure?.code).toBe('settlement_over_limit')
    expect(outcome.settlement?.budgetEnforced).toBe(false)
  })

  it('fails at the grant deadline instead of continuing', async () => {
    let now = 1_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const { grant: value, settle } = grant({ deadlineAtMs: 31_000 })
      const slowTask: RouterTurnTool = { ...createTask, run: vi.fn(async () => { now = 60_000; return { taskId: 'task-1' } }) }
      const { fetchImpl, calls: modelCalls } = grantedRouter(completion({ content: null, tool_calls: calls('staff_task_create') }))
      const outcome = await runProtectedRouterTurn({ grant: value, model: 'openai/m', fetchImpl, stream: false, systemPrompt: 's',
        userMessage: 'u', tools: [slowTask] })
      expect(modelCalls).toHaveBeenCalledOnce()
      expect(outcome.continuation).toBeUndefined()
      expect(outcome.failure?.code).toBe('turn_deadline')
      expect(settle).toHaveBeenCalledWith(expect.objectContaining({ reason: 'failed' }))
    } finally { clock.mockRestore() }
  })
})
