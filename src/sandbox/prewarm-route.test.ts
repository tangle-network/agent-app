import { describe, expect, it, vi } from 'vitest'

import {
  createWorkspacePrewarmRoute,
  isAutomatedPrewarmRequest,
  type WorkspacePrewarmAuthorization,
  type WorkspacePrewarmResponse,
} from './prewarm-route'

const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0 Safari/537.36'

function post(headers: Record<string, string> = {}): Request {
  return new Request('https://app.test/api/workspaces/w1/prewarm', {
    method: 'POST',
    headers: { 'user-agent': BROWSER, ...headers },
  })
}

async function body(response: Response): Promise<WorkspacePrewarmResponse> {
  return (await response.json()) as WorkspacePrewarmResponse
}

function allowed(warm: () => Promise<Record<string, string> | void>, key = 'box-1'): () => Promise<WorkspacePrewarmAuthorization> {
  return async () => ({ status: 'allowed', key, warm })
}

describe('createWorkspacePrewarmRoute', () => {
  it('runs the warm once and reports its result', async () => {
    const warm = vi.fn(async () => ({ state: 'resumed' }))
    const route = createWorkspacePrewarmRoute({ authorize: allowed(warm) })
    const response = await route(post())
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await body(response)).toMatchObject({ outcome: 'warmed', report: { state: 'resumed' } })
    expect(warm).toHaveBeenCalledTimes(1)
  })

  it('joins a warm already running for the same key instead of starting another', async () => {
    let finish: () => void = () => {}
    const warm = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const route = createWorkspacePrewarmRoute({ authorize: allowed(warm) })
    const first = route(post())
    const second = route(post())
    await vi.waitFor(() => expect(warm).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    finish()
    const outcomes = (await Promise.all([first, second].map(async (r) => (await body(await r)).outcome))).sort()
    expect(outcomes).toEqual(['joined', 'warmed'])
    expect(warm).toHaveBeenCalledTimes(1)
  })

  it('answers recent after a success and warms again once the window passes', async () => {
    let clock = 1_000
    const warm = vi.fn(async () => undefined)
    const route = createWorkspacePrewarmRoute({ authorize: allowed(warm), recentMs: 30_000, now: () => clock })
    expect((await body(await route(post()))).outcome).toBe('warmed')
    clock += 29_999
    expect((await body(await route(post()))).outcome).toBe('recent')
    clock += 2
    expect((await body(await route(post()))).outcome).toBe('warmed')
    expect(warm).toHaveBeenCalledTimes(2)
  })

  it('keeps a failure silent to the browser, reports it to onEvent, and retries next time', async () => {
    const events: unknown[] = []
    let calls = 0
    const route = createWorkspacePrewarmRoute({
      authorize: allowed(async () => {
        calls += 1
        if (calls === 1) throw new Error('resume refused by internal-host-7')
      }),
      onEvent: (event) => events.push(event),
    })
    const failed = await route(post())
    expect(failed.status).toBe(200)
    const text = await failed.text()
    expect(JSON.parse(text)).toMatchObject({ outcome: 'failed' })
    expect(text).not.toContain('internal-host-7')
    expect(events).toEqual([expect.objectContaining({ type: 'failed', error: 'resume refused by internal-host-7' })])
    expect((await body(await route(post()))).outcome).toBe('warmed')
  })

  it('a synchronously throwing warm does not wedge its key', async () => {
    let calls = 0
    const route = createWorkspacePrewarmRoute({
      authorize: allowed((() => {
        calls += 1
        if (calls === 1) throw new Error('sync')
        return Promise.resolve()
      }) as () => Promise<void>),
    })
    expect((await body(await route(post()))).outcome).toBe('failed')
    expect((await body(await route(post()))).outcome).toBe('warmed')
  })

  it('returns the denial response and never warms for an unauthenticated request', async () => {
    const warm = vi.fn(async () => undefined)
    const route = createWorkspacePrewarmRoute({
      authorize: async () => ({ status: 'denied', response: Response.json({ error: 'Authentication required' }, { status: 401 }) }),
    })
    expect((await route(post())).status).toBe(401)
    expect(warm).not.toHaveBeenCalled()
  })

  it('fails closed when authorization throws', async () => {
    const route = createWorkspacePrewarmRoute({ authorize: async () => { throw new Error('db down') } })
    expect(await body(await route(post()))).toMatchObject({ outcome: 'failed' })
  })

  it('declines quietly for a member the product does not warm for', async () => {
    const route = createWorkspacePrewarmRoute({ authorize: async () => ({ status: 'declined', reason: 'finance' }) })
    expect(await body(await route(post()))).toMatchObject({ outcome: 'declined', reason: 'finance' })
  })

  it('skips crawlers and speculative prefetch before authorizing', async () => {
    const authorize = vi.fn(allowed(async () => undefined))
    const route = createWorkspacePrewarmRoute({ authorize })
    expect((await body(await route(post({ 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' })))).outcome).toBe('automated')
    expect((await body(await route(post({ 'sec-purpose': 'prefetch;prerender' })))).outcome).toBe('automated')
    expect(authorize).not.toHaveBeenCalled()
  })

  it('hands the caller context to authorize', async () => {
    const seen: string[] = []
    const route = createWorkspacePrewarmRoute<{ env: string }>({
      authorize: async ({ context }) => {
        seen.push(context.env)
        return { status: 'declined', reason: 'test' }
      },
    })
    await route(post(), { env: 'production' })
    expect(seen).toEqual(['production'])
  })

  it('refuses methods other than POST', async () => {
    const route = createWorkspacePrewarmRoute({ authorize: allowed(async () => undefined) })
    const response = await route(new Request('https://app.test/x', { method: 'GET' }))
    expect(response.status).toBe(405)
  })
})

describe('isAutomatedPrewarmRequest', () => {
  it('treats a headless browser as a person, since signed-in QA uses one', () => {
    expect(isAutomatedPrewarmRequest(post())).toBe(false)
  })
  it('flags link-preview fetchers', () => {
    expect(isAutomatedPrewarmRequest(post({ 'user-agent': 'WhatsApp/2.23.20.0' }))).toBe(true)
    expect(isAutomatedPrewarmRequest(post({ 'user-agent': 'facebookexternalhit/1.1' }))).toBe(true)
  })
})
