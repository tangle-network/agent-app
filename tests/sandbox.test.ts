import { describe, expect, it, vi } from 'vitest'
import {
  createWorkspaceSandboxManager,
  createSandboxTerminalConnectionRoute,
  type TerminalConnectionBoxLike,
  type WorkspaceSandboxInstanceLike,
} from '../src/sandbox/index'

describe('createWorkspaceSandboxManager', () => {
  it('reuses only the exact workspace sandbox name and never falls back to the first running sandbox', async () => {
    type Box = WorkspaceSandboxInstanceLike & { prepared?: boolean; waited?: boolean }
    const created: Box = { id: 'created', name: 'creative-workspace-1', status: 'provisioning', connection: { runtimeUrl: 'https://runtime' } }
    const manager = createWorkspaceSandboxManager<unknown, Box, { installTools: boolean }>({
      getClient: () => ({}),
      nameForWorkspace: (workspaceId) => `creative-${workspaceId}`,
      listSandboxes: async () => [
        { id: 'wrong', name: 'creative-other-workspace', status: 'running' },
      ],
      createSandbox: async ({ name }) => ({ ...created, name }),
      waitForRunning: async (box) => {
        box.waited = true
      },
      prepareCreated: async (box) => {
        box.prepared = true
      },
    })

    const box = await manager.ensureWorkspaceSandbox('workspace-1', 'user-1', { installTools: true })

    expect(box.id).toBe('created')
    expect(box.name).toBe('creative-workspace-1')
    expect(box.waited).toBe(true)
    expect(box.prepared).toBe(true)
  })

  it('runs the existing-box callback when the exact name is found', async () => {
    const found = { id: 'box-1', name: 'creative-workspace-1', status: 'running' }
    const createSandbox = vi.fn()
    const manager = createWorkspaceSandboxManager({
      getClient: () => ({}),
      nameForWorkspace: (workspaceId) => `creative-${workspaceId}`,
      listSandboxes: async () => [found],
      createSandbox,
      prepareExisting: async (box) => ({ ...box, status: 'prepared' }),
    })

    await expect(manager.ensureWorkspaceSandbox('workspace-1', 'user-1')).resolves.toMatchObject({
      id: 'box-1',
      status: 'prepared',
    })
    expect(createSandbox).not.toHaveBeenCalled()
  })
})

describe('createSandboxTerminalConnectionRoute', () => {
  // `connection.runtimeUrl` is deliberately a DIFFERENT value from the mint's
  // `sidecarProxyUrl` below so tests can assert the response returns the
  // MINT result, never the readiness-signal runtimeUrl (#349 P1: the route
  // used to return `runtimeUrl` directly, which fails auth on the current
  // platform).
  const fakeBox = (overrides: Partial<TerminalConnectionBoxLike> = {}): TerminalConnectionBoxLike => ({
    id: 'box-1',
    status: 'running',
    connection: { runtimeUrl: 'https://runtime.example/box-1' },
    mintScopedToken: vi.fn(async () => ({
      token: 'tok',
      expiresAt: new Date('2026-01-01T00:15:00Z'),
      sidecarProxyUrl: 'https://api.example/v1/sidecar-proxy/box-1',
    })),
    ...overrides,
  })

  const requestWithConnectionId = (connectionId = 'term-abc') =>
    new Request(`https://app.test/api?connectionId=${encodeURIComponent(connectionId)}`)

  it('returns the requireUser Response verbatim (e.g. 401)', async () => {
    const unauthorized = Response.json({ error: 'Unauthorized' }, { status: 401 })
    const handler = createSandboxTerminalConnectionRoute<TerminalConnectionBoxLike, { id: string }>({
      requireUser: async () => unauthorized,
      ensureSandbox: async () => fakeBox(),
    })

    const res = await handler(new Request('https://app.test/api'))

    expect(res).toBe(unauthorized)
    expect(res.status).toBe(401)
  })

  it('returns 500 with the thrown message when ensureSandbox throws', async () => {
    const handler = createSandboxTerminalConnectionRoute<TerminalConnectionBoxLike, { id: string }>({
      requireUser: async () => ({ id: 'user-1' }),
      ensureSandbox: async () => {
        throw new Error('provisioning exploded')
      },
    })

    const res = await handler(requestWithConnectionId())
    const data = await res.json() as Record<string, unknown>

    expect(res.status).toBe(500)
    expect(data.error).toBe('provisioning exploded')
  })

  it('returns 503 {error, status} when connection.runtimeUrl is missing, relaying box.status exactly', async () => {
    const handler = createSandboxTerminalConnectionRoute<TerminalConnectionBoxLike, { id: string }>({
      requireUser: async () => ({ id: 'user-1' }),
      ensureSandbox: async () => fakeBox({ status: 'starting', connection: undefined }),
    })

    const res = await handler(requestWithConnectionId())
    const data = await res.json() as Record<string, unknown>

    expect(res.status).toBe(503)
    expect(data.status).toBe('starting')
    expect(typeof data.error).toBe('string')
  })

  it('returns 503 with the thrown message when mintScopedToken rejects', async () => {
    const handler = createSandboxTerminalConnectionRoute<TerminalConnectionBoxLike, { id: string }>({
      requireUser: async () => ({ id: 'user-1' }),
      ensureSandbox: async () => fakeBox({
        mintScopedToken: vi.fn(async () => {
          throw new Error('mint exploded')
        }),
      }),
    })

    const res = await handler(requestWithConnectionId())
    const data = await res.json() as Record<string, unknown>

    expect(res.status).toBe(503)
    expect(data.error).toBe('mint exploded')
  })

  it('returns 400 when no connectionId query parameter is present and no custom resolver is configured', async () => {
    const handler = createSandboxTerminalConnectionRoute<TerminalConnectionBoxLike, { id: string }>({
      requireUser: async () => ({ id: 'user-1' }),
      ensureSandbox: async () => fakeBox(),
    })

    const res = await handler(new Request('https://app.test/api'))
    const data = await res.json() as Record<string, unknown>

    expect(res.status).toBe(400)
    expect(typeof data.error).toBe('string')
  })

  it('returns 200 with sidecarUrl (the MINT result, never box.connection.runtimeUrl)/token/expiresAt/status/sandboxId/connectionId, and mints with {scope:"session-runtime", ttlMinutes:15, sessionId:<connectionId>}', async () => {
    const box = fakeBox()
    const handler = createSandboxTerminalConnectionRoute<TerminalConnectionBoxLike, { id: string }>({
      requireUser: async () => ({ id: 'user-1' }),
      ensureSandbox: async () => box,
    })

    const res = await handler(requestWithConnectionId('term-abc'))
    const data = await res.json() as Record<string, unknown>

    expect(res.status).toBe(200)
    expect(data.sidecarUrl).toBe('https://api.example/v1/sidecar-proxy/box-1')
    expect(data.sidecarUrl).not.toBe(box.connection!.runtimeUrl)
    expect(data.expiresAt).toBe(new Date('2026-01-01T00:15:00Z').toISOString())
    expect(data.status).toBe('running')
    expect(data.sandboxId).toBe('box-1')
    expect(data.connectionId).toBe('term-abc')
    expect(box.mintScopedToken).toHaveBeenCalledWith({ scope: 'session-runtime', ttlMinutes: 15, sessionId: 'term-abc' })
  })

  it('reaches ttlMinutes override at the mint call', async () => {
    const box = fakeBox()
    const handler = createSandboxTerminalConnectionRoute<TerminalConnectionBoxLike, { id: string }>({
      requireUser: async () => ({ id: 'user-1' }),
      ensureSandbox: async () => box,
      ttlMinutes: 3,
    })

    const res = await handler(requestWithConnectionId('term-abc'))

    expect(res.status).toBe(200)
    expect(box.mintScopedToken).toHaveBeenCalledWith({ scope: 'session-runtime', ttlMinutes: 3, sessionId: 'term-abc' })
  })

  it('custom resolveConnectionId receives {request, user, box, requested} and its rewritten return value is both minted and echoed', async () => {
    const box = fakeBox()
    const resolveConnectionId = vi.fn(async (ctx: { requested: string | null }) => `user-1:${ctx.requested}`)
    const handler = createSandboxTerminalConnectionRoute<TerminalConnectionBoxLike, { id: string }>({
      requireUser: async () => ({ id: 'user-1' }),
      ensureSandbox: async () => box,
      resolveConnectionId,
    })

    const res = await handler(requestWithConnectionId('raw'))
    const data = await res.json() as Record<string, unknown>

    expect(res.status).toBe(200)
    expect(resolveConnectionId).toHaveBeenCalledWith(
      expect.objectContaining({ user: { id: 'user-1' }, box, requested: 'raw' }),
    )
    expect(data.connectionId).toBe('user-1:raw')
    expect(box.mintScopedToken).toHaveBeenCalledWith({ scope: 'session-runtime', ttlMinutes: 15, sessionId: 'user-1:raw' })
  })

  it('returns 400 at request time when a custom resolveConnectionId returns an empty string', async () => {
    const handler = createSandboxTerminalConnectionRoute<TerminalConnectionBoxLike, { id: string }>({
      requireUser: async () => ({ id: 'user-1' }),
      ensureSandbox: async () => fakeBox(),
      resolveConnectionId: async () => '',
    })

    const res = await handler(requestWithConnectionId('raw'))

    expect(res.status).toBe(400)
    const data = await res.json() as Record<string, unknown>
    expect(typeof data.error).toBe('string')
  })
})
