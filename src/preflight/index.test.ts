import { describe, expect, it } from 'vitest'

import {
  formatPreflightReport,
  httpHeadProbe,
  routerChatProbe,
  runPreflight,
  sandboxAuthProbe,
  type PreflightProbe,
} from './index'

interface CapturedRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

/** A fake `fetch` returning a real `Response` with the given status/body, and
 *  recording the request it received. */
function fakeFetch(status: number, body = ''): { fetch: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = []
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      headers: init?.headers as Record<string, string> | undefined,
      body: init?.body as string | undefined,
    })
    // 204/205/304 forbid a body; mirror real HTTP so the fake never throws.
    const nullBody = status === 204 || status === 205 || status === 304
    return new Response(nullBody ? null : body, { status })
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, calls }
}

/** A fake `fetch` that throws — a DNS / connection-refused style failure. */
function throwingFetch(message: string): typeof fetch {
  return (async () => {
    throw new Error(message)
  }) as unknown as typeof fetch
}

/** A fake `fetch` that hangs until the abort signal fires (drives the real
 *  `AbortSignal.timeout` path). */
const hangingFetch = ((_url: unknown, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
  })) as unknown as typeof fetch

describe('routerChatProbe', () => {
  it('maps 200 to ok and issues one cheap POST /chat/completions', async () => {
    const { fetch, calls } = fakeFetch(200, '{"choices":[]}')
    const probe = routerChatProbe({
      baseUrl: 'https://router.example.com/',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetchImpl: fetch,
    })
    const result = await probe.run()
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://router.example.com/chat/completions')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers?.Authorization).toBe('Bearer sk-test')
    const parsed = JSON.parse(calls[0]!.body!)
    expect(parsed.max_tokens).toBe(1)
    expect(parsed.model).toBe('gpt-4o-mini')
  })

  it('maps 401 to a dead-key failure naming the secret to rotate', async () => {
    const { fetch } = fakeFetch(401, 'invalid api key')
    const probe = routerChatProbe({
      baseUrl: 'https://router.example.com',
      apiKey: 'sk-dead',
      model: 'gpt-4o-mini',
      keySecret: 'LITELLM_API_KEY',
      fetchImpl: fetch,
    })
    const result = await probe.run()
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('DEAD KEY')
    expect(result.detail).toContain('LITELLM_API_KEY')
  })

  it('maps 503 to upstream-down and explicitly says NOT to rotate the key', async () => {
    const { fetch } = fakeFetch(503, 'service unavailable')
    const probe = routerChatProbe({
      baseUrl: 'https://router.example.com',
      apiKey: 'sk-live',
      model: 'gpt-4o-mini',
      keySecret: 'LITELLM_API_KEY',
      fetchImpl: fetch,
    })
    const result = await probe.run()
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('UPSTREAM DOWN')
    expect(result.detail).toContain('do NOT rotate')
  })

  it('maps a timeout to a failure naming the URL secret to check', async () => {
    const probe = routerChatProbe({
      baseUrl: 'https://router.example.com',
      apiKey: 'sk-live',
      model: 'gpt-4o-mini',
      urlSecret: 'LITELLM_BASE_URL',
      timeoutMs: 20,
      fetchImpl: hangingFetch,
    })
    const result = await probe.run()
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('TIMEOUT')
    expect(result.detail).toContain('LITELLM_BASE_URL')
  })

  it('maps a connection failure to unreachable naming the URL secret', async () => {
    const probe = routerChatProbe({
      baseUrl: 'https://router.example.com',
      apiKey: 'sk-live',
      model: 'gpt-4o-mini',
      urlSecret: 'LITELLM_BASE_URL',
      fetchImpl: throwingFetch('ECONNREFUSED'),
    })
    const result = await probe.run()
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('UNREACHABLE')
    expect(result.detail).toContain('LITELLM_BASE_URL')
    expect(result.detail).toContain('ECONNREFUSED')
  })
})

describe('sandboxAuthProbe', () => {
  it('maps 200 to ok and hits GET /v1/sandboxes?limit=1 with a bearer', async () => {
    const { fetch, calls } = fakeFetch(200, '{"sandboxes":[]}')
    const probe = sandboxAuthProbe({ baseUrl: 'https://sandbox.example.com', apiKey: 'sk-box', fetchImpl: fetch })
    const result = await probe.run()
    expect(result.ok).toBe(true)
    expect(calls[0]!.url).toBe('https://sandbox.example.com/v1/sandboxes?limit=1')
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.headers?.Authorization).toBe('Bearer sk-box')
  })

  it('maps 401 to a dead-key failure naming the secret', async () => {
    const { fetch } = fakeFetch(401)
    const probe = sandboxAuthProbe({
      baseUrl: 'https://sandbox.example.com',
      apiKey: 'sk-dead',
      keySecret: 'SANDBOX_API_KEY',
      fetchImpl: fetch,
    })
    const result = await probe.run()
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('DEAD KEY')
    expect(result.detail).toContain('SANDBOX_API_KEY')
  })
})

describe('httpHeadProbe', () => {
  it('accepts any 2xx/3xx by default', async () => {
    const { fetch, calls } = fakeFetch(204)
    const probe = httpHeadProbe({ name: 'platform', url: 'https://platform.example.com/health', fetchImpl: fetch })
    const result = await probe.run()
    expect(result.ok).toBe(true)
    expect(calls[0]!.method).toBe('HEAD')
  })

  it('fails a 500 and names the URL secret to check', async () => {
    const { fetch } = fakeFetch(500)
    const probe = httpHeadProbe({
      name: 'platform',
      url: 'https://platform.example.com/health',
      urlSecret: 'TANGLE_PLATFORM_URL',
      fetchImpl: fetch,
    })
    const result = await probe.run()
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('UNEXPECTED 500')
    expect(result.detail).toContain('TANGLE_PLATFORM_URL')
  })

  it('honours an exact expectStatus', async () => {
    const okProbe = httpHeadProbe({ name: 'p', url: 'https://x/', expectStatus: 200, fetchImpl: fakeFetch(200).fetch })
    expect((await okProbe.run()).ok).toBe(true)
    const badProbe = httpHeadProbe({ name: 'p', url: 'https://x/', expectStatus: 200, fetchImpl: fakeFetch(301).fetch })
    expect((await badProbe.run()).ok).toBe(false)
  })

  it('honours an expectStatus list', async () => {
    const probe = httpHeadProbe({ name: 'p', url: 'https://x/', expectStatus: [200, 405], fetchImpl: fakeFetch(405).fetch })
    expect((await probe.run()).ok).toBe(true)
  })
})

describe('runPreflight aggregation', () => {
  const passing = (name: string): PreflightProbe => ({ name, run: async () => ({ ok: true, detail: 'ok' }) })
  const failing = (name: string, critical?: boolean): PreflightProbe => ({
    name,
    critical,
    run: async () => ({ ok: false, detail: 'dead' }),
  })

  it('passes when all probes pass and records per-probe latency', async () => {
    const report = await runPreflight([passing('a'), passing('b')])
    expect(report.ok).toBe(true)
    expect(report.passed).toBe(2)
    expect(report.failed).toBe(0)
    expect(report.criticalFailures).toBe(0)
    for (const p of report.probes) expect(p.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('fails overall when a critical probe fails (probes default critical)', async () => {
    const report = await runPreflight([passing('a'), failing('b')])
    expect(report.ok).toBe(false)
    expect(report.criticalFailures).toBe(1)
    const b = report.probes.find((p) => p.name === 'b')!
    expect(b.critical).toBe(true)
  })

  it('stays green when only a non-critical probe fails (WARN, not blocking)', async () => {
    const report = await runPreflight([passing('a'), failing('b', false)])
    expect(report.ok).toBe(true)
    expect(report.failed).toBe(1)
    expect(report.criticalFailures).toBe(0)
  })

  it('catches a probe that throws and treats it as a failure', async () => {
    const boom: PreflightProbe = {
      name: 'boom',
      run: async () => {
        throw new Error('kaboom')
      },
    }
    const report = await runPreflight([boom])
    expect(report.ok).toBe(false)
    const v = report.probes[0]!
    expect(v.ok).toBe(false)
    expect(v.detail).toContain('probe threw')
    expect(v.detail).toContain('kaboom')
  })
})

describe('formatPreflightReport', () => {
  it('renders a table and, on failure, names the dead probes + a rotate hint', async () => {
    const report = await runPreflight([
      { name: 'router-chat', run: async () => ({ ok: false, detail: 'DEAD KEY — rotate LITELLM_API_KEY' }) },
      { name: 'platform', critical: false, run: async () => ({ ok: false, detail: 'UNREACHABLE' }) },
    ])
    const text = formatPreflightReport(report)
    expect(text).toContain('STATUS')
    expect(text).toContain('FAIL')
    expect(text).toContain('WARN')
    expect(text).toContain('LITELLM_API_KEY')
    expect(text).toContain('Preflight FAILED')
    expect(text).toContain('router-chat')
  })

  it('renders a PASSED verdict when all critical probes are live', async () => {
    const report = await runPreflight([{ name: 'ok', run: async () => ({ ok: true }) }])
    expect(formatPreflightReport(report)).toContain('Preflight PASSED')
  })
})
