import { describe, expect, it, vi } from 'vitest'
import { createCertifiedDelivery } from './certified-delivery'

const COMPOSED = {
  target: 'tax-agent',
  generatedAt: '2026-06-14T00:00:00.000Z',
  promptSurface: {
    surface: 'Certified: verify the invoice id before issuing a refund.',
    surfaceHash: 'h1',
    version: 3,
    lift: '+3.1pp',
  },
  artifacts: {
    skill: [
      {
        path: 'skills/refunds/SKILL.md',
        content: 'Refund skill: verify, then issue.',
        contentHash: 'd1',
        version: 1,
        lift: null,
        promotedAt: '2026-06-13T00:00:00.000Z',
      },
    ],
  },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('createCertifiedDelivery', () => {
  it('folds the certified prompt-surface + skill into the system prompt (profile-wide)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(COMPOSED)) as unknown as typeof fetch
    const d = createCertifiedDelivery({ target: 'tax-agent', apiKey: 'k', baseUrl: 'https://plane.test', fetchImpl })
    const out = await d.composeProfile({ systemPrompt: 'BASE PROMPT', extraTools: [] })
    expect(out.systemPrompt).toContain('BASE PROMPT')
    expect(out.systemPrompt).toContain('verify the invoice id before issuing a refund')
    expect(out.systemPrompt).toContain('Refund skill: verify, then issue.')
    expect(d.current()?.promptSurface?.version).toBe(3)
    // pull hits the composed endpoint with the bearer.
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(call[0]).toBe('https://plane.test/v1/profiles/tax-agent/composed')
    expect(call[1].headers).toMatchObject({ authorization: 'Bearer k' })
  })

  it('passes extraTools through (tool-artifact delivery is the next increment)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(COMPOSED)) as unknown as typeof fetch
    const d = createCertifiedDelivery({ target: 't', apiKey: 'k', baseUrl: 'https://plane.test', fetchImpl })
    const tool = { type: 'function', function: { name: 'x' } }
    const out = await d.composeProfile({ systemPrompt: 'B', extraTools: [tool] })
    expect(out.extraTools).toEqual([tool])
  })

  it('fail-closed: a 404 (nothing promoted) leaves the base surfaces unchanged', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch
    const d = createCertifiedDelivery({ target: 't', apiKey: 'k', baseUrl: 'https://plane.test', fetchImpl })
    const out = await d.composeProfile({ systemPrompt: 'BASE', extraTools: [] })
    expect(out.systemPrompt).toBe('BASE')
    expect(d.current()).toBeNull()
  })

  it('does not break the agent when the plane is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const d = createCertifiedDelivery({ target: 't', apiKey: 'k', baseUrl: 'https://plane.test', fetchImpl })
    await expect(d.composeProfile({ systemPrompt: 'BASE', extraTools: [] })).resolves.toMatchObject({
      systemPrompt: 'BASE',
    })
  })

  it('caches the pull across composes within refreshMs (one pull, N turns)', async () => {
    const calls = { n: 0 }
    const fetchImpl = vi.fn(async () => {
      calls.n += 1
      return jsonResponse(COMPOSED)
    }) as unknown as typeof fetch
    const d = createCertifiedDelivery({
      target: 't',
      apiKey: 'k',
      baseUrl: 'https://plane.test',
      refreshMs: 60_000,
      fetchImpl,
    })
    await d.composeProfile({ systemPrompt: 'B', extraTools: [] })
    await d.composeProfile({ systemPrompt: 'B', extraTools: [] })
    await d.composeProfile({ systemPrompt: 'B', extraTools: [] })
    expect(calls.n).toBe(1)
  })
})
