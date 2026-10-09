import { describe, expect, it, vi } from 'vitest'
import {
  OPERATOR_ROUTES,
  createOperatorApi,
  createOperatorClient,
  operatorKeyWorkspaces,
  operatorWorkspaceScope,
  OperatorError,
  type OperatorAdapter,
  type OperatorTurn,
  type OperatorWorkspace,
} from '../src/operator'
import type { RequestApiKey } from '../src/platform/api-key-auth'

type Identity = { userId: string }

const ORIGIN = 'https://app.example'
const ALL = ['operator:read', 'operator:write', 'operator:run']

function turn(overrides: Partial<OperatorTurn> = {}): OperatorTurn {
  return {
    workspaceId: 'ws-a', threadId: 'thread-1', turnId: '7f4c1d2e-1111-4a2b-8c3d-000000000001', state: 'working',
    reply: null, failure: null, assets: [], files: [], approvals: [], ...overrides,
  }
}

function setup(options: { scopes?: string[]; adapter?: Partial<OperatorAdapter<Identity>>; keys?: Record<string, string[]> } = {}) {
  const keys: Record<string, string[]> = options.keys ?? { 'tak_valid': options.scopes ?? ALL }
  const owned: Record<string, OperatorWorkspace> = {
    'ws-a': { id: 'ws-a', name: 'Product A', role: 'owner' },
    'ws-b': { id: 'ws-b', name: 'Product B', role: 'owner' },
  }
  const adapter: OperatorAdapter<Identity> = {
    authorizeWorkspace: vi.fn(async (_ctx, workspaceId: string) => owned[workspaceId] ?? null),
    listWorkspaces: vi.fn(async () => Object.values(owned)),
    createWorkspace: vi.fn(async (_ctx, input: { name: string }) => ({ id: 'ws-new', name: input.name, role: 'owner' as const })),
    startTurn: vi.fn(async (_ctx, workspace, input) => turn({ workspaceId: workspace.id, turnId: input.turnId, threadId: input.threadId ?? 'thread-1', state: 'queued' })),
    getTurn: vi.fn(async (_ctx, workspace, target) => turn({ workspaceId: workspace.id, ...target })),
    listApprovals: vi.fn(async () => []),
    ...options.adapter,
  }
  const claimRequest = vi.fn(async () => ({ allowed: true }))
  const onError = vi.fn()
  const api = createOperatorApi<RequestApiKey, Identity>({
    app: { id: 'test', name: 'Test App' },
    keys: {
      async verify(authorization) {
        const raw = authorization.replace(/^Bearer /, '')
        const scopes = keys[raw]
        return scopes ? { keyId: `id-${raw}`, ownerId: 'owner-1', scopes, expiresAt: Date.now() + 60_000 } : null
      },
      resolveIdentity: async (key) => ({ userId: key.ownerId }),
      claimRequest,
    },
    adapter,
    pollIntervalMs: 250,
    maxWaitSeconds: 5,
    onError,
  })
  const send = (path: string, init: RequestInit & { key?: string | null } = {}) => {
    const headers = new Headers(init.headers)
    const key = init.key === undefined ? 'tak_valid' : init.key
    if (key !== null) headers.set('Authorization', `Bearer ${key}`)
    return api.handle(new Request(`${ORIGIN}/api/operator/v1${path}`, { ...init, headers }))
  }
  return { api, adapter, send, claimRequest, onError }
}

describe('operator API authority', () => {
  it('requires a Bearer key and never falls back to a browser session', async () => {
    const { send, adapter } = setup()
    const response = await send('/workspaces', { key: null, headers: { Cookie: 'session=valid' } })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: 'operator.unauthenticated' })
    expect(adapter.listWorkspaces).not.toHaveBeenCalled()
    expect((await send('/workspaces', { key: 'tak_unknown' })).status).toBe(401)
  })

  it.each(OPERATOR_ROUTES.map((route) => [route.id, route.method, route.scopes] as const))(
    '%s refuses a key missing any of its scopes',
    async (_id, method, scopes) => {
      const route = OPERATOR_ROUTES.find((candidate) => candidate.id === _id)!
      const path = route.path
        .replace(':workspaceId', 'ws-a').replace(':threadId', 'thread-1')
        .replace(':turnId', '7f4c1d2e-1111-4a2b-8c3d-000000000001').replace(':assetId', 'asset-1')
      for (const missing of scopes) {
        const { send, adapter } = setup({ scopes: ALL.filter((scope) => scope !== missing) })
        const response = await send(path, { method })
        expect(response.status).toBe(403)
        expect(await response.json()).toMatchObject({ code: 'api_key.insufficient_scope' })
        expect(adapter.authorizeWorkspace).not.toHaveBeenCalled()
      }
    },
  )

  it('confines a workspace-restricted key to its workspace', async () => {
    const restricted = ['operator:read', 'operator:run', 'operator:write', operatorWorkspaceScope('ws-a')]
    const { send, adapter } = setup({ scopes: restricted })

    const listed = await send('/workspaces')
    expect(await listed.json()).toEqual({ workspaces: [{ id: 'ws-a', name: 'Product A', role: 'owner' }] })

    const other = await send('/workspaces/ws-b/approvals')
    expect(other.status).toBe(404)
    expect(await other.json()).toMatchObject({ code: 'operator.workspace_not_found' })
    const otherTurn = await send('/workspaces/ws-b/turns', {
      method: 'POST', body: JSON.stringify({ turnId: crypto.randomUUID(), content: 'Plan the week' }),
    })
    expect(otherTurn.status).toBe(404)
    expect(adapter.authorizeWorkspace).not.toHaveBeenCalledWith(expect.anything(), 'ws-b', expect.anything())
    expect(adapter.startTurn).not.toHaveBeenCalled()

    const created = await send('/workspaces', { method: 'POST', body: JSON.stringify({ name: 'Escalation' }) })
    expect(created.status).toBe(403)
    expect(await created.json()).toMatchObject({ code: 'operator.workspace_restricted' })
    expect(adapter.createWorkspace).not.toHaveBeenCalled()

    expect((await send('/workspaces/ws-a/approvals')).status).toBe(200)
  })

  it('treats a malformed restriction as access to no workspace', () => {
    expect(operatorKeyWorkspaces(['operator:read'])).toBeNull()
    expect(operatorKeyWorkspaces(['operator:workspace:ws-a', 'operator:workspace:../x'])).toEqual(['ws-a'])
    expect(operatorKeyWorkspaces(['operator:workspace:'])).toEqual([])
    expect(() => operatorWorkspaceScope('a/b')).toThrow(TypeError)
  })

  it('answers 404 for a workspace the owner cannot reach and claims one request each call', async () => {
    const { send, claimRequest } = setup()
    const response = await send('/workspaces/ws-other/scorecard')
    expect(response.status).toBe(404)
    expect(claimRequest).toHaveBeenCalledTimes(1)
  })
})

describe('operator API turns', () => {
  it('takes identity and destination from the key and path, never the body', async () => {
    const { send, adapter } = setup()
    const forged = await send('/workspaces/ws-a/turns', {
      method: 'POST',
      body: JSON.stringify({ turnId: crypto.randomUUID(), content: 'Draft posts', userId: 'attacker', workspaceId: 'ws-b' }),
    })
    expect(forged.status).toBe(400)
    expect(await forged.json()).toMatchObject({ code: 'operator.invalid_input', error: 'Unknown fields: userId, workspaceId' })
    for (const body of [
      { turnId: 'not-a-uuid', content: 'Draft' },
      { turnId: crypto.randomUUID(), content: '   ' },
      { turnId: crypto.randomUUID(), content: 'x'.repeat(70_000) },
      { turnId: crypto.randomUUID(), content: 'Draft', threadId: '../thread' },
    ]) {
      expect((await send('/workspaces/ws-a/turns', { method: 'POST', body: JSON.stringify(body) })).status).toBe(400)
    }
    expect(adapter.startTurn).not.toHaveBeenCalled()

    const turnId = crypto.randomUUID().toUpperCase()
    const accepted = await send('/workspaces/ws-a/turns', {
      method: 'POST', body: JSON.stringify({ turnId, content: 'Draft this week\'s posts', threadId: 'thread-9', model: 'gpt-6.1-sol' }),
    })
    expect(accepted.status).toBe(202)
    expect(adapter.authorizeWorkspace).toHaveBeenCalledWith(expect.anything(), 'ws-a', 'run')
    expect(adapter.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({ identity: { userId: 'owner-1' }, key: { keyId: 'id-tak_valid', scopes: ALL } }),
      expect.objectContaining({ id: 'ws-a' }),
      { turnId: turnId.toLowerCase(), content: 'Draft this week\'s posts', threadId: 'thread-9', model: 'gpt-6.1-sol' },
    )
    expect(await accepted.json()).toMatchObject({ turn: { state: 'queued', threadId: 'thread-9' } })
  })

  it('holds a turn read until the turn settles', async () => {
    let reads = 0
    const { send, adapter } = setup({ adapter: {
      getTurn: vi.fn(async (_ctx, workspace, target) => {
        reads++
        return reads < 3 ? turn({ workspaceId: workspace.id, ...target })
          : turn({ workspaceId: workspace.id, ...target, state: 'succeeded', reply: { content: 'Done', mediaType: 'text/markdown' } })
      }),
    } })
    const started = Date.now()
    const response = await send('/workspaces/ws-a/threads/thread-1/turns/7f4c1d2e-1111-4a2b-8c3d-000000000001?wait=5')
    expect(await response.json()).toMatchObject({ turn: { state: 'succeeded', reply: { content: 'Done' } } })
    expect(adapter.getTurn).toHaveBeenCalledTimes(3)
    expect(Date.now() - started).toBeLessThan(4_000)
    expect((await send('/workspaces/ws-a/threads/thread-1/turns/7f4c1d2e-1111-4a2b-8c3d-000000000001?wait=60')).status).toBe(400)
  })

  it('returns a held read early when a decision is waiting', async () => {
    const approval = { id: 'q1', kind: 'question' as const, title: 'Which audience?', decidedBy: 'operator' as const }
    const { send } = setup({ adapter: { getTurn: vi.fn(async (_ctx, workspace, target) => turn({ workspaceId: workspace.id, ...target, approvals: [approval] })) } })
    const started = Date.now()
    const response = await send('/workspaces/ws-a/threads/thread-1/turns/7f4c1d2e-1111-4a2b-8c3d-000000000001?wait=5')
    expect(await response.json()).toMatchObject({ turn: { state: 'working', approvals: [approval] } })
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe('operator API reads', () => {
  it('reports unimplemented operations as 501 and lists implemented capabilities', async () => {
    const { send } = setup({ adapter: { readFile: async () => ({ path: 'journal/a.md', content: 'x', mediaType: 'text/markdown' }) } })
    expect((await send('/workspaces/ws-a/scorecard')).status).toBe(501)
    const described = await (await send('')).json()
    expect(described).toMatchObject({
      app: { app: 'test', apiVersion: 'v1', capabilities: ['workspaces.create', 'files.read'] },
      principal: { keyId: 'id-tak_valid', workspaces: null },
    })
  })

  it('rejects paths that leave the workspace', async () => {
    const readFile = vi.fn(async () => null)
    const { send } = setup({ adapter: { readFile, listFiles: vi.fn(async () => []) } })
    for (const path of ['../secret', '/etc/passwd', 'a/../../b', 'a\\b', '']) {
      const response = await send(`/workspaces/ws-a/file?path=${encodeURIComponent(path)}`)
      expect(response.status).toBe(400)
    }
    expect((await send('/workspaces/ws-a/files?prefix=..')).status).toBe(400)
    expect(readFile).not.toHaveBeenCalled()
    expect((await send('/workspaces/ws-a/file?path=fleet%2Fdrafts%2Fa.md')).status).toBe(404)
    expect(readFile).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'fleet/drafts/a.md')
  })

  it('hides unexpected adapter failures and reports them to the app', async () => {
    const { send, onError } = setup({ adapter: { listApprovals: async () => { throw new Error('D1 said: secret-table-name') } } })
    const response = await send('/workspaces/ws-a/approvals')
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('secret-table-name')
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'approvals.list')
  })

  it('passes adapter refusals through with their code', async () => {
    const { send } = setup({ adapter: { listApprovals: async () => { throw new OperatorError('gtm.busy', 409, 'Busy', true) } } })
    const response = await send('/workspaces/ws-a/approvals')
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Busy', code: 'gtm.busy', retryable: true })
  })

  it('serves asset bytes without caching or cookies', async () => {
    const { send } = setup({ adapter: { readAsset: async () => new Response('png', { headers: { 'content-type': 'image/png', 'set-cookie': 'a=b' } }) } })
    const response = await send('/workspaces/ws-a/assets/asset-1')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(await response.text()).toBe('png')
  })
})

describe('operator client', () => {
  it('drives a turn through the same handler and returns typed outcomes', async () => {
    let reads = 0
    const { api } = setup({ adapter: {
      getTurn: vi.fn(async (_ctx, workspace, target) => {
        reads++
        return turn({ workspaceId: workspace.id, ...target, ...(reads > 1 ? { state: 'succeeded' as const, reply: { content: 'Shipped', mediaType: 'text/markdown' } } : {}) })
      }),
    } })
    const client = createOperatorClient({
      origin: ORIGIN,
      getApiKey: () => 'tak_valid',
      fetchImpl: (input, init) => api.handle(new Request(input, init)),
    })
    const started = await client.startTurn('ws-a', { content: 'Plan the launch' })
    expect(started.succeeded).toBe(true)
    if (!started.succeeded) return
    const settled = await client.waitForTurn('ws-a', started.value.threadId, started.value.turnId, { timeoutMs: 10_000, waitSeconds: 1 })
    expect(settled).toMatchObject({ succeeded: true, value: { state: 'succeeded', reply: { content: 'Shipped' } } })

    const denied = await createOperatorClient({
      origin: ORIGIN, getApiKey: () => 'tak_wrong_secret_value', fetchImpl: (input, init) => api.handle(new Request(input, init)),
    }).listWorkspaces()
    expect(denied).toMatchObject({ succeeded: false, status: 401, code: 'api_key.invalid', retryable: false })
    expect(JSON.stringify(denied)).not.toContain('tak_wrong_secret_value')
  })

  it('reports a transport failure as retryable without the key', async () => {
    const client = createOperatorClient({
      origin: ORIGIN, getApiKey: () => 'tak_valid',
      fetchImpl: async () => { throw new Error('connect failed for Bearer tak_valid') },
    })
    const result = await client.describe()
    expect(result).toMatchObject({ succeeded: false, status: 0, code: 'operator.transport_failed', retryable: true })
    expect(JSON.stringify(result)).not.toContain('tak_valid')
  })
})
