/**
 * Budgets for free routes — authenticated, unmetered, compute-bearing
 * endpoints.
 *
 * The failure this exists to prevent is not "the limit is slightly wrong"; it
 * is a route that runs UNBOUNDED because the guard was skipped, keyed to a
 * shared bucket, or silently passed when the limiter itself failed. So the
 * cases below are weighted toward the paths where a naive wrapper admits the
 * call: no identity, a KV read that throws, a KV write that throws, and a
 * workspace whose members would otherwise each get a private budget.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  checkFreeRouteLimit,
  FREE_ROUTE_BUDGETS,
  FreeRouteLimitError,
  freeRouteLimitResponse,
  WORKSPACE_BUDGET_MULTIPLIER,
  withFreeRouteLimit,
  type KvLike,
} from '../../src/web'

/** In-memory KV with optional injected transport failures. */
function fakeKv(fail?: { onGet?: boolean; onPut?: boolean }): KvLike & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    async get(key) {
      if (fail?.onGet) throw new Error('KV get unavailable')
      return store.get(key) ?? null
    },
    async put(key, value) {
      if (fail?.onPut) throw new Error('KV put unavailable')
      store.set(key, value)
    },
  }
}

const BUDGET = { limit: 3, windowSeconds: 60 }

describe('checkFreeRouteLimit', () => {
  it('allows up to the budget, then refuses with a correctable 429', async () => {
    const kv = fakeKv()
    const call = (): ReturnType<typeof checkFreeRouteLimit> =>
      checkFreeRouteLimit({ kv, route: 'plan.recompute', subject: 'u1', budget: BUDGET })

    for (let i = 0; i < BUDGET.limit; i += 1) {
      const outcome = await call()
      expect(outcome.succeeded, `call ${i}`).toBe(true)
    }
    const denied = await call()
    expect(denied.succeeded).toBe(false)
    if (denied.succeeded) throw new Error('unreachable')
    expect(denied.error).toBeInstanceOf(FreeRouteLimitError)
    expect(denied.error.reason).toBe('rate-limited')
    expect(denied.error.status).toBe(429)
    expect(denied.error.dimension).toBe('subject')
    expect(denied.error.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('reports the remaining allowance so a caller can surface it', async () => {
    const kv = fakeKv()
    const outcome = await checkFreeRouteLimit({ kv, route: 'r', subject: 'u1', budget: BUDGET })
    expect(outcome).toMatchObject({ succeeded: true, value: { remaining: 2, dimension: 'subject', budget: BUDGET } })
  })

  it('keys per subject — one user exhausting a route does not block another', async () => {
    const kv = fakeKv()
    for (let i = 0; i < BUDGET.limit; i += 1) {
      await checkFreeRouteLimit({ kv, route: 'r', subject: 'u1', budget: BUDGET })
    }
    expect((await checkFreeRouteLimit({ kv, route: 'r', subject: 'u1', budget: BUDGET })).succeeded).toBe(false)
    expect((await checkFreeRouteLimit({ kv, route: 'r', subject: 'u2', budget: BUDGET })).succeeded).toBe(true)
  })

  it('keys per route — exhausting one route does not close another', async () => {
    const kv = fakeKv()
    for (let i = 0; i < BUDGET.limit; i += 1) {
      await checkFreeRouteLimit({ kv, route: 'redline', subject: 'u1', budget: BUDGET })
    }
    expect((await checkFreeRouteLimit({ kv, route: 'redline', subject: 'u1', budget: BUDGET })).succeeded).toBe(false)
    expect((await checkFreeRouteLimit({ kv, route: 'deadlines', subject: 'u1', budget: BUDGET })).succeeded).toBe(true)
  })

  it('cannot be collided into another caller\'s window by an id shaped like the key separators', async () => {
    const kv = fakeKv()
    // Concatenated verbatim, these two produce the SAME key
    // (`free:r:subject:a:subject:b`), which would let one caller consume the
    // other's window. Percent-encoding each component keeps them apart.
    await checkFreeRouteLimit({ kv, route: 'r', subject: 'a:subject:b', budget: BUDGET })
    await checkFreeRouteLimit({ kv, route: 'r:subject:a', subject: 'b', budget: BUDGET })
    expect([...kv.store.keys()]).toEqual(['rl:free:r:subject:a%3Asubject%3Ab', 'rl:free:r%3Asubject%3Aa:subject:b'])
  })

  it('refuses an unidentified caller instead of pooling it into a shared bucket', async () => {
    const kv = fakeKv()
    for (const subject of [undefined, null, '', '   ']) {
      const outcome = await checkFreeRouteLimit({ kv, route: 'r', subject, budget: BUDGET })
      expect(outcome.succeeded).toBe(false)
      if (outcome.succeeded) throw new Error('unreachable')
      expect(outcome.error.reason).toBe('unidentified')
      expect(outcome.error.status).toBe(401)
      expect(outcome.error.retryAfterSeconds).toBe(0)
    }
    // Nothing was written: an anonymous flood cannot even fill a bucket.
    expect(kv.store.size).toBe(0)
  })

  it('defaults to the `compute` class budget', async () => {
    const kv = fakeKv()
    const outcome = await checkFreeRouteLimit({ kv, route: 'r', subject: 'u1' })
    expect(outcome).toMatchObject({ succeeded: true, value: { budget: FREE_ROUTE_BUDGETS.compute } })
  })

  it('takes the class budget when a class is named', async () => {
    const kv = fakeKv()
    const outcome = await checkFreeRouteLimit({ kv, route: 'r', subject: 'u1', costClass: 'heavy' })
    expect(outcome).toMatchObject({ succeeded: true, value: { budget: FREE_ROUTE_BUDGETS.heavy } })
    expect(FREE_ROUTE_BUDGETS.heavy.limit).toBeLessThan(FREE_ROUTE_BUDGETS.compute.limit)
    expect(FREE_ROUTE_BUDGETS.compute.limit).toBeLessThan(FREE_ROUTE_BUDGETS.interactive.limit)
  })

  it('rejects a nonsensical budget rather than enforcing it', async () => {
    const kv = fakeKv()
    await expect(checkFreeRouteLimit({ kv, route: 'r', subject: 'u1', budget: { limit: 0, windowSeconds: 60 } })).rejects.toThrow(
      /positive integers/,
    )
    await expect(
      checkFreeRouteLimit({ kv, route: 'r', subject: 'u1', budget: { limit: 5, windowSeconds: 0 } }),
    ).rejects.toThrow(/positive integers/)
  })
})

describe('the workspace ceiling', () => {
  it('bounds a tenant whose members each stay under their own budget', async () => {
    const kv = fakeKv()
    const workspaceBudget = { limit: 4, windowSeconds: 60 }
    const call = (subject: string): ReturnType<typeof checkFreeRouteLimit> =>
      checkFreeRouteLimit({ kv, route: 'r', subject, workspace: 'ws_1', budget: BUDGET, workspaceBudget })

    // Four calls from four distinct members: every subject window is fresh.
    for (const subject of ['u1', 'u2', 'u3', 'u4']) {
      expect((await call(subject)).succeeded, subject).toBe(true)
    }
    const fifth = await call('u5')
    expect(fifth.succeeded).toBe(false)
    if (fifth.succeeded) throw new Error('unreachable')
    expect(fifth.error.dimension).toBe('workspace')
    expect(fifth.error.reason).toBe('rate-limited')
  })

  it('defaults the workspace ceiling to a multiple of the member budget', async () => {
    const kv = fakeKv()
    const budget = { limit: 1, windowSeconds: 60 }
    for (let i = 0; i < WORKSPACE_BUDGET_MULTIPLIER; i += 1) {
      const outcome = await checkFreeRouteLimit({ kv, route: 'r', subject: `u${i}`, workspace: 'ws_1', budget })
      expect(outcome.succeeded, `member ${i}`).toBe(true)
    }
    const overflow = await checkFreeRouteLimit({ kv, route: 'r', subject: 'u_last', workspace: 'ws_1', budget })
    expect(overflow.succeeded).toBe(false)
    if (overflow.succeeded) throw new Error('unreachable')
    expect(overflow.error.dimension).toBe('workspace')
  })

  it('reports the workspace window when it is the tighter one', async () => {
    const kv = fakeKv()
    const outcome = await checkFreeRouteLimit({
      kv,
      route: 'r',
      subject: 'u1',
      workspace: 'ws_1',
      budget: { limit: 10, windowSeconds: 60 },
      workspaceBudget: { limit: 2, windowSeconds: 60 },
    })
    expect(outcome).toMatchObject({ succeeded: true, value: { dimension: 'workspace', remaining: 1 } })
  })

  it('does not consult the workspace window once the subject window is full', async () => {
    const kv = fakeKv()
    const budget = { limit: 1, windowSeconds: 60 }
    await checkFreeRouteLimit({ kv, route: 'r', subject: 'u1', workspace: 'ws_1', budget })
    const before = kv.store.size
    const denied = await checkFreeRouteLimit({ kv, route: 'r', subject: 'u1', workspace: 'ws_1', budget })
    expect(denied.succeeded).toBe(false)
    // A refused call must not spend the tenant's ceiling on the caller's behalf.
    expect(kv.store.size).toBe(before)
  })
})

describe('the limiter failure mode', () => {
  it('refuses with 503 when the limiter READ throws — never a silent pass', async () => {
    const outcome = await checkFreeRouteLimit({ kv: fakeKv({ onGet: true }), route: 'r', subject: 'u1', budget: BUDGET })
    expect(outcome.succeeded).toBe(false)
    if (outcome.succeeded) throw new Error('unreachable')
    expect(outcome.error.reason).toBe('limiter-unavailable')
    expect(outcome.error.status).toBe(503)
    expect(outcome.error.retryAfterSeconds).toBeGreaterThan(0)
    // The transport failure stays diagnosable rather than collapsing into 429.
    expect((outcome.error.cause as Error | undefined)?.message).toBe('KV get unavailable')
  })

  it('refuses with 503 when the limiter WRITE throws — a window it cannot record is a window it cannot enforce', async () => {
    const outcome = await checkFreeRouteLimit({ kv: fakeKv({ onPut: true }), route: 'r', subject: 'u1', budget: BUDGET })
    expect(outcome.succeeded).toBe(false)
    if (outcome.succeeded) throw new Error('unreachable')
    expect(outcome.error.reason).toBe('limiter-unavailable')
    expect((outcome.error.cause as Error | undefined)?.message).toBe('KV put unavailable')
  })

  it('refuses on a limiter failure in the workspace window too', async () => {
    const store = new Map<string, string>()
    let gets = 0
    const kv: KvLike = {
      async get(key) {
        gets += 1
        // The subject window resolves; the workspace window's read fails.
        if (gets > 1) throw new Error('KV get unavailable')
        return store.get(key) ?? null
      },
      async put(key, value) {
        store.set(key, value)
      },
    }
    const outcome = await checkFreeRouteLimit({ kv, route: 'r', subject: 'u1', workspace: 'ws_1', budget: BUDGET })
    expect(outcome.succeeded).toBe(false)
    if (outcome.succeeded) throw new Error('unreachable')
    expect(outcome.error.reason).toBe('limiter-unavailable')
    expect(outcome.error.dimension).toBe('workspace')
  })
})

describe('freeRouteLimitResponse', () => {
  it('carries the status, reason and Retry-After', async () => {
    const kv = fakeKv()
    for (let i = 0; i < BUDGET.limit; i += 1) await checkFreeRouteLimit({ kv, route: 'r', subject: 'u1', budget: BUDGET })
    const denied = await checkFreeRouteLimit({ kv, route: 'r', subject: 'u1', budget: BUDGET })
    if (denied.succeeded) throw new Error('unreachable')

    const response = freeRouteLimitResponse(denied.error, { headers: { 'X-Product': 'legal' } })
    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe(String(denied.error.retryAfterSeconds))
    expect(response.headers.get('X-Product')).toBe('legal')
    expect(await response.json()).toMatchObject({ reason: 'rate-limited' })
  })

  it('omits Retry-After when waiting cannot fix the refusal', async () => {
    const outcome = await checkFreeRouteLimit({ kv: fakeKv(), route: 'r', subject: null, budget: BUDGET })
    if (outcome.succeeded) throw new Error('unreachable')
    const response = freeRouteLimitResponse(outcome.error)
    expect(response.status).toBe(401)
    expect(response.headers.get('Retry-After')).toBeNull()
  })
})

describe('withFreeRouteLimit', () => {
  const args = { request: new Request('https://app.example.com/api/plan/recompute', { method: 'POST' }) }

  it('runs the handler while the caller is under budget', async () => {
    const kv = fakeKv()
    const handler = vi.fn(async () => Response.json({ ok: true }))
    const route = withFreeRouteLimit(
      { route: 'plan.recompute', budget: BUDGET, kv: () => kv, identify: () => ({ subject: 'u1' }) },
      handler,
    )
    const response = await route(args)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('returns the handler response untouched, so a pre-built response is not rewritten', async () => {
    const kv = fakeKv()
    const built = new Response('raw', { status: 202, headers: { 'X-Custom': 'kept' } })
    const route = withFreeRouteLimit(
      { route: 'r', budget: BUDGET, kv: () => kv, identify: () => ({ subject: 'u1' }) },
      () => built,
    )
    const response = await route(args)
    expect(response).toBe(built)
    expect(response.headers.get('X-Custom')).toBe('kept')
  })

  it('refuses past the budget WITHOUT entering the handler — the compute is never spent', async () => {
    const kv = fakeKv()
    const handler = vi.fn(async () => Response.json({ ok: true }))
    const route = withFreeRouteLimit(
      { route: 'r', budget: BUDGET, kv: () => kv, identify: () => ({ subject: 'u1' }) },
      handler,
    )
    for (let i = 0; i < BUDGET.limit; i += 1) expect((await route(args)).status).toBe(200)
    const denied = await route(args)
    expect(denied.status).toBe(429)
    expect(denied.headers.get('Retry-After')).toBeTruthy()
    expect(handler).toHaveBeenCalledTimes(BUDGET.limit)
  })

  it('refuses an unauthenticated request with 401 and never enters the handler', async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }))
    const route = withFreeRouteLimit({ route: 'r', kv: () => fakeKv(), identify: () => null }, handler)
    const response = await route(args)
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ reason: 'unidentified' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('refuses with 503 and never enters the handler when the limiter is down', async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }))
    const route = withFreeRouteLimit(
      { route: 'r', budget: BUDGET, kv: () => fakeKv({ onGet: true }), identify: () => ({ subject: 'u1' }) },
      handler,
    )
    const response = await route(args)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ reason: 'limiter-unavailable' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('lets a product shape the refusal without being able to admit the call', async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }))
    const route = withFreeRouteLimit(
      {
        route: 'r',
        kv: () => fakeKv(),
        identify: () => null,
        onDenied: (error) => Response.json({ code: error.reason }, { status: error.status }),
      },
      handler,
    )
    const response = await route(args)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ code: 'unidentified' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('propagates a throwing identity lookup, leaving the handler unrun', async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }))
    const route = withFreeRouteLimit(
      {
        route: 'r',
        kv: () => fakeKv(),
        identify: () => {
          throw new Error('session store down')
        },
      },
      handler,
    )
    await expect(route(args)).rejects.toThrow('session store down')
    expect(handler).not.toHaveBeenCalled()
  })

  it('carries the workspace through, so a tenant ceiling applies to the wrapped route', async () => {
    const kv = fakeKv()
    const handler = vi.fn(async () => Response.json({ ok: true }))
    const route = withFreeRouteLimit(
      {
        route: 'r',
        budget: { limit: 1, windowSeconds: 60 },
        workspaceBudget: { limit: 2, windowSeconds: 60 },
        kv: () => kv,
        identify: (a: { request: Request; member: string }) => ({ subject: a.member, workspace: 'ws_1' }),
      },
      handler,
    )
    expect((await route({ ...args, member: 'u1' })).status).toBe(200)
    expect((await route({ ...args, member: 'u2' })).status).toBe(200)
    expect((await route({ ...args, member: 'u3' })).status).toBe(429)
    expect(handler).toHaveBeenCalledTimes(2)
  })
})
