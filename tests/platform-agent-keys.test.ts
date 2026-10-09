import { describe, expect, it, vi } from 'vitest'
import {
  createOperatorApi,
  withPlatformAgentKeys,
  type OperatorAdapter,
  type OperatorWorkspace,
} from '../src/operator'
import {
  agentOperatorScopes,
  createPlatformAgentKeyVerifier,
  platformKeyRefusal,
  resolveTangleSsoAccount,
  type RequestApiKey,
  type TangleSsoAccountStore,
  type TangleSsoLocalAccount,
} from '../src/platform'

const PLATFORM = 'https://id.example'
const PRODUCT = 'gtm-agent'
const OPERATOR = [`${PRODUCT}:operator:read`, `${PRODUCT}:operator:write`, `${PRODUCT}:operator:run`]

interface PlatformKey {
  valid: boolean
  invalidReason?: string
  keyId: string
  userId: string
  email: string
  scopes: readonly string[]
  provisionedByService?: string
}

/** Platform `/v1/keys/verify` as a product service sees it. */
function fakePlatform(keys: Record<string, PlatformKey>) {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { key: string; expectedProduct: string }
    calls.push({ url: String(input), headers: new Headers(init?.headers), body })
    const key = keys[body.key]
    if (!key) return Response.json({ valid: false, invalidReason: 'key_not_found' })
    // Platform answers for the product the service verifies: an agent key
    // whose scopes do not name it is refused there, before the app sees it.
    const granted = key.scopes.includes('*') || key.scopes.includes(body.expectedProduct)
    if (!key.valid || !granted) {
      return Response.json({ valid: false, invalidReason: key.invalidReason ?? 'verify_product_not_permitted', keyId: key.keyId })
    }
    return Response.json({
      valid: true, keyId: key.keyId, userId: key.userId, email: key.email, displayName: null,
      scopes: key.scopes, provisionedByService: key.provisionedByService ?? 'agent-signup',
    })
  })
  return { fetch: fetchImpl as unknown as typeof fetch, calls }
}

function agentKey(overrides: Partial<PlatformKey> & { userId: string }): PlatformKey {
  return {
    valid: true, keyId: `key_${overrides.userId}`, email: `${overrides.userId}@example.com`,
    scopes: ['sandbox', 'router', PRODUCT, ...OPERATOR], ...overrides,
  }
}

/** An app's link-table account store, in memory. */
function memoryAccounts(seed: TangleSsoLocalAccount[] = []) {
  const users = new Map(seed.map((account) => [account.userId, { ...account }]))
  const links = new Map<string, { tangleUserId: string; apiKey: string }>()
  for (const account of seed) {
    if (account.platformUserId) links.set(account.userId, { tangleUserId: account.platformUserId, apiKey: 'sk-tan-browser' })
  }
  let next = 0
  const rows = () => [...users.values()].map((user) => ({ ...user, platformUserId: links.get(user.userId)?.tangleUserId ?? null }))
  const store: Pick<TangleSsoAccountStore, 'resolveAccount' | 'upsertUserByEmail' | 'saveTangleLink'> = {
    resolveAccount: async ({ email, platformUserId }) => resolveTangleSsoAccount({
      email, platformUserId,
      platformMatches: rows().filter((row) => row.platformUserId === platformUserId),
      emailMatches: rows().filter((row) => row.email === email.toLowerCase()),
    }),
    upsertUserByEmail: vi.fn(async ({ email, resolution }) => {
      if (resolution.kind === 'existing') return { userId: resolution.userId }
      const userId = `app-user-${++next}`
      users.set(userId, { userId, email: email.toLowerCase(), emailVerified: true, platformUserId: null })
      return { userId }
    }),
    saveTangleLink: vi.fn(async ({ userId, tangleUserId, apiKey }) => {
      links.set(userId, { tangleUserId, apiKey })
    }),
  }
  return { store, users, links }
}

type Identity = { userId: string }

function setup(options: { keys: Record<string, PlatformKey>; seed?: TangleSsoLocalAccount[]; workspaces?: Record<string, string> }) {
  const platform = fakePlatform(options.keys)
  const accounts = memoryAccounts(options.seed)
  // Workspace id -> owning app user. Roles come from the app, never the key.
  const workspaceOwners = options.workspaces ?? {}
  const view = (id: string): OperatorWorkspace => ({ id, name: id, role: 'owner' })
  const adapter: OperatorAdapter<Identity> = {
    authorizeWorkspace: vi.fn(async (ctx, workspaceId) => workspaceOwners[workspaceId] === ctx.identity.userId ? view(workspaceId) : null),
    listWorkspaces: vi.fn(async (ctx) => Object.keys(workspaceOwners).filter((id) => workspaceOwners[id] === ctx.identity.userId).map(view)),
    createWorkspace: vi.fn(async (ctx, input) => {
      workspaceOwners[`ws-${input.name}`] = ctx.identity.userId
      return view(`ws-${input.name}`)
    }),
    startTurn: vi.fn(async (_ctx, workspace, input) => ({
      workspaceId: workspace.id, threadId: 'thread-1', turnId: input.turnId, state: 'queued' as const,
      reply: null, failure: null, assets: [], files: [], approvals: [],
    })),
    getTurn: vi.fn(async () => null),
    listApprovals: vi.fn(async () => []),
  }
  const appKeys = {
    verify: vi.fn(async (authorization: string): Promise<RequestApiKey | null> => authorization === 'Bearer gak_app'
      ? { keyId: 'gak-1', ownerId: 'app-owner', scopes: ['operator:read'], expiresAt: Date.now() + 60_000 }
      : null),
    resolveIdentity: vi.fn(async (key: RequestApiKey) => ({ userId: key.ownerId })),
    claimRequest: vi.fn(async () => ({ allowed: true })),
  }
  const verifier = createPlatformAgentKeyVerifier({
    platformUrl: PLATFORM, serviceName: 'gtm-agent', serviceToken: 'svc_token', product: PRODUCT, fetch: platform.fetch,
  })
  const api = createOperatorApi<RequestApiKey, Identity>({
    app: { id: 'test', name: 'Test App' },
    keys: withPlatformAgentKeys(appKeys, {
      verifier, product: PRODUCT, accounts: accounts.store,
      loadIdentity: async (userId) => (accounts.users.has(userId) ? { userId } : null),
    }),
    adapter,
    pollIntervalMs: 250,
    maxWaitSeconds: 5,
  })
  const send = (key: string, path: string, init: RequestInit = {}) => api.handle(new Request(`https://app.example/api/operator/v1${path}`, {
    ...init, headers: { ...init.headers as Record<string, string>, Authorization: `Bearer ${key}` },
  }))
  return { send, platform, accounts, adapter, appKeys }
}

describe('Platform agent key verification', () => {
  it('asks Platform about this product, as this service, with the owner identity', async () => {
    const platform = fakePlatform({ 'sk-tan-a': agentKey({ userId: 'plat-a' }) })
    const verifier = createPlatformAgentKeyVerifier({
      platformUrl: `${PLATFORM}/`, serviceName: 'gtm-agent', serviceToken: () => 'svc_token', product: PRODUCT, fetch: platform.fetch,
    })
    expect(await verifier.verify('sk-tan-a')).toMatchObject({
      ok: true, keyId: 'key_plat-a', platformUserId: 'plat-a', email: 'plat-a@example.com',
    })
    expect(platform.calls).toHaveLength(1)
    const [call] = platform.calls
    expect(call!.url).toBe(`${PLATFORM}/v1/keys/verify`)
    expect(call!.headers.get('authorization')).toBe('Bearer svc_token')
    expect(call!.headers.get('x-service-name')).toBe('gtm-agent')
    expect(call!.body).toEqual({ key: 'sk-tan-a', expectedProduct: PRODUCT, includeIdentityProfile: true })
  })

  it('answers each Platform refusal with its typed status', () => {
    expect(platformKeyRefusal('paid_access_required')).toMatchObject({ status: 402, code: 'agent_key.payment_required' })
    expect(platformKeyRefusal('budget_exhausted')).toMatchObject({ status: 402, code: 'agent_key.budget_exhausted' })
    expect(platformKeyRefusal('monthly_budget_exhausted')).toMatchObject({ status: 402, code: 'agent_key.budget_exhausted' })
    expect(platformKeyRefusal('verify_product_not_permitted')).toMatchObject({ status: 403, code: 'agent_key.product_not_granted' })
    expect(platformKeyRefusal('email_verification_required')).toMatchObject({ status: 403, code: 'agent_key.owner_unverified' })
    expect(platformKeyRefusal('key_revoked')).toMatchObject({ status: 401, code: 'agent_key.invalid' })
    expect(platformKeyRefusal(undefined)).toMatchObject({ status: 401, code: 'agent_key.invalid' })
  })

  it('caches an accepted key for its short TTL and never caches a refusal', async () => {
    const keys = { 'sk-tan-a': agentKey({ userId: 'plat-a' }) }
    const platform = fakePlatform(keys)
    let now = 1_000_000
    const verifier = createPlatformAgentKeyVerifier({
      platformUrl: PLATFORM, serviceName: 'gtm-agent', serviceToken: 'svc', product: PRODUCT, fetch: platform.fetch,
      cacheTtlMs: 30_000, now: () => now,
    })
    expect((await verifier.verify('sk-tan-a')).ok).toBe(true)
    expect((await verifier.verify('sk-tan-a')).ok).toBe(true)
    expect(platform.calls).toHaveLength(1)

    // Revoked at Platform: refused once the cached answer lapses, and the
    // refusal is asked again every time rather than remembered.
    keys['sk-tan-a'] = { ...keys['sk-tan-a'], valid: false, invalidReason: 'key_revoked' }
    now += 30_001
    expect(await verifier.verify('sk-tan-a')).toMatchObject({ ok: false, status: 401 })
    expect(await verifier.verify('sk-tan-a')).toMatchObject({ ok: false, status: 401 })
    expect(platform.calls).toHaveLength(3)
  })

  it('caps the cache TTL so revocation lands within two minutes', async () => {
    const platform = fakePlatform({ 'sk-tan-a': agentKey({ userId: 'plat-a' }) })
    let now = 0
    const verifier = createPlatformAgentKeyVerifier({
      platformUrl: PLATFORM, serviceName: 'gtm-agent', serviceToken: 'svc', product: PRODUCT, fetch: platform.fetch,
      cacheTtlMs: 3_600_000, now: () => now,
    })
    const accepted = await verifier.verify('sk-tan-a')
    expect(accepted.ok && accepted.validUntil).toBe(120_000)
  })

  it('fails closed when Platform cannot answer, and refuses keys that are not agent keys', async () => {
    const down = createPlatformAgentKeyVerifier({
      platformUrl: PLATFORM, serviceName: 'gtm-agent', serviceToken: 'svc', product: PRODUCT,
      fetch: (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch,
    })
    await expect(down.verify('sk-tan-a')).rejects.toThrow('HTTP 503')

    const platform = fakePlatform({ 'sk-tan-user': agentKey({ userId: 'plat-a', provisionedByService: 'user' }) })
    const verifier = createPlatformAgentKeyVerifier({
      platformUrl: PLATFORM, serviceName: 'gtm-agent', serviceToken: 'svc', product: PRODUCT, fetch: platform.fetch,
    })
    expect(await verifier.verify('sk-tan-user')).toMatchObject({ ok: false, status: 403, code: 'agent_key.not_agent_key' })
    expect(await verifier.verify('gak_other')).toMatchObject({ ok: false, status: 401 })
    expect(platform.calls).toHaveLength(1)
  })

  it('maps only this product’s operator scopes, or every action for the wildcard', () => {
    const actions = ['read', 'write', 'run']
    expect(agentOperatorScopes(['*'], PRODUCT, actions)).toEqual(['operator:read', 'operator:write', 'operator:run'])
    expect(agentOperatorScopes([PRODUCT, `${PRODUCT}:operator:read`], PRODUCT, actions)).toEqual(['operator:read'])
    expect(agentOperatorScopes(['other-app:operator:run', 'operator:run', PRODUCT], PRODUCT, actions)).toEqual([])
  })
})

describe('operator API with a Platform agent key', () => {
  it('provisions the owner on the first call as a first sign-in would, then reuses that user', async () => {
    const { send, accounts } = setup({ keys: { 'sk-tan-a': agentKey({ userId: 'plat-a' }) } })
    const first = await send('sk-tan-a', '/workspaces')
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ workspaces: [] })
    expect([...accounts.users.values()]).toEqual([
      { userId: 'app-user-1', email: 'plat-a@example.com', emailVerified: true, platformUserId: null },
    ])
    expect(accounts.links.get('app-user-1')).toEqual({ tangleUserId: 'plat-a', apiKey: 'sk-tan-a' })

    const created = await send('sk-tan-a', '/workspaces', { method: 'POST', body: JSON.stringify({ name: 'launch' }) })
    expect(created.status).toBe(201)
    const listed = await send('sk-tan-a', '/workspaces')
    expect(await listed.json()).toEqual({ workspaces: [{ id: 'ws-launch', name: 'ws-launch', role: 'owner' }] })
    expect(accounts.users.size).toBe(1)
    expect(accounts.store.upsertUserByEmail).toHaveBeenCalledTimes(1)
    expect(accounts.store.saveTangleLink).toHaveBeenCalledTimes(1)
  })

  it('acts as an owner already signed in to the app without touching their link', async () => {
    const { send, accounts } = setup({
      keys: { 'sk-tan-a': agentKey({ userId: 'plat-a' }) },
      seed: [{ userId: 'existing', email: 'plat-a@example.com', emailVerified: true, platformUserId: 'plat-a' }],
      workspaces: { 'ws-mine': 'existing' },
    })
    const response = await send('sk-tan-a', '/workspaces')
    expect(await response.json()).toEqual({ workspaces: [{ id: 'ws-mine', name: 'ws-mine', role: 'owner' }] })
    expect(accounts.store.upsertUserByEmail).not.toHaveBeenCalled()
    expect(accounts.store.saveTangleLink).not.toHaveBeenCalled()
    expect(accounts.links.get('existing')).toEqual({ tangleUserId: 'plat-a', apiKey: 'sk-tan-browser' })
  })

  it('a wildcard key for an owner never signed in provisions only that owner', async () => {
    const { send, accounts } = setup({
      keys: { 'sk-tan-wild': agentKey({ userId: 'plat-new', scopes: ['*'] }) },
      seed: [{ userId: 'other', email: 'other@example.com', emailVerified: true, platformUserId: 'plat-other' }],
      workspaces: { 'ws-other': 'other' },
    })
    const response = await send('sk-tan-wild', '/workspaces')
    expect(await response.json()).toEqual({ workspaces: [] })
    expect([...accounts.users.keys()].sort()).toEqual(['app-user-1', 'other'])
    expect(accounts.links.get('app-user-1')).toMatchObject({ tangleUserId: 'plat-new' })
    expect(accounts.links.get('other')).toEqual({ tangleUserId: 'plat-other', apiKey: 'sk-tan-browser' })
    expect((await send('sk-tan-wild', '/workspaces/ws-other/approvals')).status).toBe(404)
  })

  it('cannot reach another owner’s workspace', async () => {
    const { send, adapter } = setup({
      keys: { 'sk-tan-a': agentKey({ userId: 'plat-a' }) },
      seed: [
        { userId: 'alice', email: 'plat-a@example.com', emailVerified: true, platformUserId: 'plat-a' },
        { userId: 'bob', email: 'bob@example.com', emailVerified: true, platformUserId: 'plat-b' },
      ],
      workspaces: { 'ws-alice': 'alice', 'ws-bob': 'bob' },
    })
    expect((await send('sk-tan-a', '/workspaces/ws-bob/approvals')).status).toBe(404)
    const turn = await send('sk-tan-a', '/workspaces/ws-bob/turns', {
      method: 'POST', body: JSON.stringify({ turnId: crypto.randomUUID(), content: 'Plan the week' }),
    })
    expect(turn.status).toBe(404)
    expect(adapter.startTurn).not.toHaveBeenCalled()
    expect((await send('sk-tan-a', '/workspaces/ws-alice/approvals')).status).toBe(200)
  })

  it.each([
    ['revoked', { valid: false, invalidReason: 'key_revoked' }, 401, 'agent_key.invalid'],
    ['over its shared cap', { valid: false, invalidReason: 'budget_exhausted' }, 402, 'agent_key.budget_exhausted'],
    ['owned by an unfunded account', { valid: false, invalidReason: 'paid_access_required' }, 402, 'agent_key.payment_required'],
    ['not approved for this app', { scopes: ['sandbox', 'router'] }, 403, 'agent_key.product_not_granted'],
  ] as const)('refuses a key %s before any account is touched', async (_label, change, status, code) => {
    const { send, accounts } = setup({ keys: { 'sk-tan-a': { ...agentKey({ userId: 'plat-a' }), ...change } } })
    const response = await send('sk-tan-a', '/workspaces')
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ code })
    expect(accounts.users.size).toBe(0)
    expect(accounts.store.saveTangleLink).not.toHaveBeenCalled()
  })

  it('grants no operator action the owner did not approve for this app', async () => {
    const { send, adapter } = setup({
      keys: {
        'sk-tan-read': agentKey({ userId: 'plat-a', scopes: [PRODUCT, `${PRODUCT}:operator:read`] }),
        // Scopes for another app, or a bare operator scope, grant nothing here.
        'sk-tan-other': agentKey({ userId: 'plat-b', scopes: [PRODUCT, 'other-app:operator:run', 'operator:run'] }),
      },
      seed: [{ userId: 'alice', email: 'plat-a@example.com', emailVerified: true, platformUserId: 'plat-a' }],
      workspaces: { 'ws-alice': 'alice' },
    })
    expect((await send('sk-tan-read', '/workspaces')).status).toBe(200)
    const turn = await send('sk-tan-read', '/workspaces/ws-alice/turns', {
      method: 'POST', body: JSON.stringify({ turnId: crypto.randomUUID(), content: 'Plan the week' }),
    })
    expect(turn.status).toBe(403)
    expect(await turn.json()).toMatchObject({ code: 'api_key.insufficient_scope' })
    expect(adapter.startTurn).not.toHaveBeenCalled()

    const other = await send('sk-tan-other', '/workspaces')
    expect(other.status).toBe(403)
    expect(await other.json()).toMatchObject({ code: 'agent_key.product_not_granted' })
  })

  it('refuses an identity that conflicts with a local account', async () => {
    const { send, accounts } = setup({
      keys: { 'sk-tan-a': agentKey({ userId: 'plat-a' }) },
      seed: [{ userId: 'squatter', email: 'plat-a@example.com', emailVerified: false, platformUserId: null }],
    })
    const response = await send('sk-tan-a', '/workspaces')
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'agent_key.account_conflict' })
    expect(accounts.store.saveTangleLink).not.toHaveBeenCalled()
  })

  it('answers 503 when Platform cannot verify, and leaves app keys on the app store', async () => {
    const { send, appKeys } = setup({ keys: {} })
    expect((await send('gak_app', '/workspaces')).status).toBe(200)
    expect(appKeys.verify).toHaveBeenCalledWith('Bearer gak_app')
    expect(appKeys.claimRequest).toHaveBeenCalledTimes(1)

    const down = createOperatorApi<RequestApiKey, Identity>({
      app: { id: 'test', name: 'Test App' },
      keys: withPlatformAgentKeys(appKeys, {
        verifier: { verify: async () => { throw new Error('Platform key verification answered HTTP 503') } },
        product: PRODUCT, accounts: memoryAccounts().store, loadIdentity: async () => null,
      }),
      adapter: { authorizeWorkspace: async () => null, listWorkspaces: async () => [], startTurn: async () => { throw new Error('unused') }, getTurn: async () => null, listApprovals: async () => [] },
    })
    const response = await down.handle(new Request('https://app.example/api/operator/v1/workspaces', { headers: { Authorization: 'Bearer sk-tan-a' } }))
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'operator.auth_unavailable' })
  })
})
