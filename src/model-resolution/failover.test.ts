import { describe, it, expect, vi } from 'vitest'
import {
  isUpstreamUnavailable,
  runWithModelFailover,
  buildModelChain,
  ModelFailoverExhaustedError,
  UPSTREAM_UNAVAILABLE_CODES,
} from './failover'

/**
 * The VERBATIM payload a real box returned for `claude-sonnet-4-6` during the
 * 2026-07-25 outage (sandbox.tangle.tools, box sandbox-0d762c328011). This is
 * the customer-visible failure the failover exists to absorb — captured, not
 * invented, so the test cannot drift away from the shape production emits.
 */
const REAL_OUTAGE_PAYLOAD = {
  success: false,
  status: 'failed',
  error:
    'OpenCode provider inference is unavailable for openai-compat/claude-sonnet-4-6: Bad Gateway. Session: ses_065bd4b9fffeqmXdHZ1j19dfFJ.',
  errorCode: 'provider_inference_unavailable',
  durationMs: 9432,
}

/** The VERBATIM success payload `gpt-5-mini` returned on the same box. */
const REAL_SUCCESS_PAYLOAD = {
  success: true,
  status: 'success',
  response: 'The capital of France is Paris.',
  usage: { inputTokens: 1151, outputTokens: 16 },
}

describe('isUpstreamUnavailable — classifies the real outage shapes', () => {
  it('detects the resolved (non-thrown) sandbox outage payload', () => {
    expect(isUpstreamUnavailable(REAL_OUTAGE_PAYLOAD)).toBe(true)
  })

  it('never misreads a successful payload as an outage', () => {
    expect(isUpstreamUnavailable(REAL_SUCCESS_PAYLOAD)).toBe(false)
  })

  it('detects the router 503 body for a quota-walled upstream', () => {
    expect(
      isUpstreamUnavailable({
        error: {
          message: 'Inference temporarily unavailable. Our team has been notified — please retry shortly.',
          type: 'server_error',
          code: 'upstream_unavailable',
        },
      }),
    ).toBe(true)
  })

  it('detects DeepSeek insufficient balance', () => {
    expect(isUpstreamUnavailable(new Error('Insufficient Balance'))).toBe(true)
  })

  it('detects the Anthropic quota wall message', () => {
    expect(
      isUpstreamUnavailable(
        new Error('You have reached your specified API usage limits. You will regain access on 2026-08-01.'),
      ),
    ).toBe(true)
  })

  it('detects a bare HTTP 502 status', () => {
    expect(isUpstreamUnavailable({ status: 502 })).toBe(true)
  })

  it('does NOT treat a bad request or auth failure as an outage', () => {
    expect(isUpstreamUnavailable({ status: 400, message: 'invalid schema' })).toBe(false)
    expect(isUpstreamUnavailable({ status: 401, message: 'unauthorized' })).toBe(false)
  })

  it('ignores non-objects', () => {
    expect(isUpstreamUnavailable(undefined)).toBe(false)
    expect(isUpstreamUnavailable('bad gateway')).toBe(false)
  })
})

describe('runWithModelFailover', () => {
  it('uses the preferred model and never calls a fallback when it works', async () => {
    const run = vi.fn(async () => REAL_SUCCESS_PAYLOAD)
    const result = await runWithModelFailover({
      models: ['gpt-5-mini', 'gemini-2.5-flash'],
      run,
    })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('gpt-5-mini')
    expect(result.model).toBe('gpt-5-mini')
    expect(result.usedFallback).toBe(false)
  })

  it('falls over to a healthy model when the preferred one returns the real outage payload', async () => {
    const seen: string[] = []
    const run = vi.fn(async (model: string) => {
      seen.push(model)
      return model === 'claude-sonnet-4-6' ? REAL_OUTAGE_PAYLOAD : REAL_SUCCESS_PAYLOAD
    })
    const onFallback = vi.fn()

    const result = await runWithModelFailover({
      models: ['claude-sonnet-4-6', 'gpt-5-mini'],
      run,
      onFallback,
    })

    expect(seen).toEqual(['claude-sonnet-4-6', 'gpt-5-mini'])
    expect(result.model).toBe('gpt-5-mini')
    expect(result.value).toEqual(REAL_SUCCESS_PAYLOAD)
    expect(result.usedFallback).toBe(true)
    expect(result.attempts).toEqual([
      { model: 'claude-sonnet-4-6', ok: false, reason: REAL_OUTAGE_PAYLOAD.error },
      { model: 'gpt-5-mini', ok: true },
    ])
    expect(onFallback).toHaveBeenCalledWith(
      { model: 'claude-sonnet-4-6', ok: false, reason: REAL_OUTAGE_PAYLOAD.error },
      'gpt-5-mini',
    )
  })

  it('falls over when the model THROWS rather than resolving', async () => {
    const run = vi.fn(async (model: string) => {
      if (model === 'deepseek/deepseek-chat') throw new Error('Insufficient Balance')
      return REAL_SUCCESS_PAYLOAD
    })
    const result = await runWithModelFailover({
      models: ['deepseek/deepseek-chat', 'gemini-2.5-flash'],
      run,
    })
    expect(result.model).toBe('gemini-2.5-flash')
    expect(result.usedFallback).toBe(true)
  })

  it('walks a multi-model chain past several dead upstreams', async () => {
    const dead = new Set(['claude-opus-4-8', 'deepseek/deepseek-chat', 'gemini-2.5-pro'])
    const run = vi.fn(async (model: string) => (dead.has(model) ? REAL_OUTAGE_PAYLOAD : REAL_SUCCESS_PAYLOAD))
    const result = await runWithModelFailover({
      models: ['claude-opus-4-8', 'deepseek/deepseek-chat', 'gemini-2.5-pro', 'gpt-5-mini'],
      run,
    })
    expect(result.model).toBe('gpt-5-mini')
    expect(run).toHaveBeenCalledTimes(4)
  })

  it('re-throws a NON-outage error immediately without burning the chain', async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error('invalid tool schema'), { status: 400 })
    })
    await expect(
      runWithModelFailover({ models: ['gpt-5-mini', 'gemini-2.5-flash'], run }),
    ).rejects.toThrow('invalid tool schema')
    // The critical assertion: a bad request must NOT be retried on every model.
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('throws ModelFailoverExhaustedError with the full trail when every model is dead', async () => {
    const run = vi.fn(async () => REAL_OUTAGE_PAYLOAD)
    await expect(
      runWithModelFailover({ models: ['claude-sonnet-4-6', 'claude-opus-4-8'], run }),
    ).rejects.toBeInstanceOf(ModelFailoverExhaustedError)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('requires at least one model', async () => {
    await expect(runWithModelFailover({ models: [], run: async () => 1 })).rejects.toThrow(
      'requires at least one model',
    )
  })
})

describe('buildModelChain', () => {
  it('puts the preferred model first and de-duplicates', () => {
    expect(buildModelChain('gpt-5-mini', ['gemini-2.5-flash', 'gpt-5-mini', ''])).toEqual([
      'gpt-5-mini',
      'gemini-2.5-flash',
    ])
  })
})

describe('UPSTREAM_UNAVAILABLE_CODES', () => {
  it('includes the exact code a real box emitted during the outage', () => {
    expect(UPSTREAM_UNAVAILABLE_CODES).toContain('provider_inference_unavailable')
  })
})
