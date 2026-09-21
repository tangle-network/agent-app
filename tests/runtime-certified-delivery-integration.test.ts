import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCertifiedDelivery, type CertifiedDeliveryConfig } from '../src/runtime/certified-delivery'

const COMPOSED = {
  target: 'test-agent', generatedAt: '2030-01-01T00:00:00Z',
  promptSurface: { surface: 'Use the approved offer.', surfaceHash: 'h1', version: 3, lift: null },
  artifacts: {},
}
const response = (body: unknown) => Response.json(body)
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('Runtime certified source through the application profile seam', () => {
  it('pulls the first profile even when the clock starts at zero', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(0)
    const fetchImpl = vi.fn(async () => response(COMPOSED))
    const delivery = createCertifiedDelivery({ target: 'test-agent', apiKey: 'k', fetchImpl })
    expect((await delivery.composeProfile({ systemPrompt: 'Base', extraTools: [] })).systemPrompt)
      .toContain('approved offer')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('makes composition wait for a forced refresh of a warm source', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(60_000)
    const pending = Promise.withResolvers<Response>()
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(COMPOSED))
      .mockImplementationOnce(async () => pending.promise)
    const delivery = createCertifiedDelivery({ target: 'test-agent', apiKey: 'k', fetchImpl })
    const base = { systemPrompt: 'Base', extraTools: [] }
    await delivery.composeProfile(base)
    const refreshing = delivery.refresh()
    let settled = false
    const composed = delivery.composeProfile(base).then(value => { settled = true; return value })
    try {
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
      expect(settled).toBe(false)
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    } finally {
      pending.resolve(response({ ...COMPOSED, promptSurface: {
        ...COMPOSED.promptSurface, surface: 'Use the revised approved offer.', version: 4,
      } }))
    }
    await refreshing
    expect((await composed).systemPrompt).toContain('revised approved offer')
    expect(delivery.current()?.promptSurface?.version).toBe(4)
  })

  it('coalesces explicit refreshes rather than adding a second application cache', async () => {
    const pending = Promise.withResolvers<Response>()
    const fetchImpl = vi.fn(async () => pending.promise)
    const delivery = createCertifiedDelivery({ target: 'test-agent', apiKey: 'k', fetchImpl })
    const refreshes = [delivery.refresh(), delivery.refresh(), delivery.refresh()]
    pending.resolve(response(COMPOSED))
    await Promise.all(refreshes)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(delivery.current()?.target).toBe('test-agent')
  })

  it('captures explicit target and credential coordinates before caller config mutation', async () => {
    const fetchImpl = vi.fn(async () => response(COMPOSED))
    const replacement = vi.fn(async () => response({ ...COMPOSED, target: 'other' }))
    const config: CertifiedDeliveryConfig = { target: 'test-agent', apiKey: 'original-key',
      baseUrl: 'https://plane.test', fetchImpl }
    const delivery = createCertifiedDelivery(config)
    await delivery.refresh()
    Object.assign(config, { target: 'other', apiKey: 'replacement-key',
      baseUrl: 'https://other.test', fetchImpl: replacement })
    await delivery.refresh()
    expect(replacement).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    for (const [url, init] of fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(url).toBe('https://plane.test/v1/profiles/test-agent/composed')
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer original-key')
    }
  })

  it.each([404, 503])('retains last-known guidance after an unsuccessful forced pull (%s)', async status => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(COMPOSED))
      .mockResolvedValueOnce(new Response('', { status }))
    const delivery = createCertifiedDelivery({ target: 'test-agent', apiKey: 'k', fetchImpl })
    await delivery.refresh(); await delivery.refresh()
    expect(delivery.current()?.promptSurface?.version).toBe(3)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('passes the source timeout through without another request implementation', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const fetchImpl = vi.fn(async () => response(COMPOSED))
    await createCertifiedDelivery({ target: 'test-agent', apiKey: 'k', timeoutMs: 1234, fetchImpl }).refresh()
    expect(timeout).toHaveBeenCalledWith(1234)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not grant promoted tool or MCP permissions during composition', async () => {
    const fetchImpl = vi.fn(async () => response({ ...COMPOSED,
      agentProfile: { tools: { publish: true }, mcp: { unapproved: { url: 'https://other.test' } } },
      artifacts: { tool: [{ content: 'unapproved-tool' }] },
    }))
    const delivery = createCertifiedDelivery({ target: 'test-agent', apiKey: 'k', fetchImpl })
    const tools = [{ type: 'function', function: { name: 'explicitly-authorized' } }]
    const composed = await delivery.composeProfile({ systemPrompt: 'Base', extraTools: tools })
    expect(composed.extraTools).toBe(tools)
    expect(composed).not.toHaveProperty('mcp')
    expect(composed.systemPrompt).not.toContain('unapproved-tool')
    expect(delivery.current()?.agentProfile).toBeDefined()
  })
})
