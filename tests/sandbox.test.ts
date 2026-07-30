import { describe, expect, it, vi } from 'vitest'
import {
  bearerSubprotocolToken,
  bearerToken,
  buildSandboxRuntimeProxyHeaders,
  createSandboxTerminalToken,
  createWorkspaceSandboxConnectionHandler,
  createWorkspaceSandboxManager,
  createWorkspaceSandboxRuntimeProxyHandler,
  createSandboxTerminalConnectionRoute,
  createWorkspaceSandboxTerminalUpgradeHandler,
  encodeSandboxRuntimePath,
  isSandboxTerminalWsUpgrade,
  matchSandboxTerminalWsPath,
  sandboxSidecarProxyUrl,
  selectedBearerSubprotocol,
  terminalUpgradeSubprotocolEcho,
  terminalTokenFromRequest,
  verifySandboxTerminalToken,
  type TerminalConnectionBoxLike,
  type WorkspaceSandboxInstanceLike,
} from '../src/sandbox/index'

const secret = 'terminal-secret'

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

describe('sandbox terminal tokens', () => {
  it('round-trips for the bound user, workspace, and sandbox', async () => {
    const subject = { userId: 'user-1', workspaceId: 'workspace-1', sandboxId: 'box-1' }
    const minted = await createSandboxTerminalToken(subject, { secret, now: () => 1_000, expiresInMs: 60_000 })

    expect(minted.token.split('.')).toHaveLength(2)
    expect(minted.expiresAt.toISOString()).toBe('1970-01-01T00:01:01.000Z')
    await expect(verifySandboxTerminalToken(minted.token, subject, { secret, now: () => 1_000 })).resolves.toBe(true)
  })

  it('rejects wrong scope, wrong secret, malformed, and expired tokens', async () => {
    const subject = { userId: 'user-1', workspaceId: 'workspace-1', sandboxId: 'box-1' }
    const minted = await createSandboxTerminalToken(subject, { secret, now: () => 1_000, expiresInMs: 1_000 })

    await expect(verifySandboxTerminalToken(minted.token, { ...subject, userId: 'user-2' }, { secret, now: () => 1_000 })).resolves.toBe(false)
    await expect(verifySandboxTerminalToken(minted.token, { ...subject, workspaceId: 'workspace-2' }, { secret, now: () => 1_000 })).resolves.toBe(false)
    await expect(verifySandboxTerminalToken(minted.token, { ...subject, sandboxId: 'box-2' }, { secret, now: () => 1_000 })).resolves.toBe(false)
    await expect(verifySandboxTerminalToken(minted.token, subject, { secret: 'other', now: () => 1_000 })).resolves.toBe(false)
    await expect(verifySandboxTerminalToken('not-a-token', subject, { secret, now: () => 1_000 })).resolves.toBe(false)
    await expect(verifySandboxTerminalToken(minted.token, subject, { secret, now: () => 2_000 })).resolves.toBe(false)
  })

  it('verifies legacy sbxt_-prefixed tokens for backward compatibility', async () => {
    const subject = { userId: 'user-1', workspaceId: 'workspace-1', sandboxId: 'box-1' }
    const minted = await createSandboxTerminalToken(subject, { secret, now: () => 1_000, expiresInMs: 1_000 })
    // A token minted by a prior deploy carried an `sbxt_` prefix over the same
    // signed payload; verification must still accept it within its TTL.
    const legacyToken = `sbxt_${minted.token}`

    await expect(verifySandboxTerminalToken(legacyToken, subject, { secret, now: () => 1_000 })).resolves.toBe(true)
    // The prefix is no escape hatch — wrong secret and expiry still fail.
    await expect(verifySandboxTerminalToken(legacyToken, subject, { secret: 'other', now: () => 1_000 })).resolves.toBe(false)
    await expect(verifySandboxTerminalToken(legacyToken, subject, { secret, now: () => 2_000 })).resolves.toBe(false)
  })
})

describe('workspace sandbox connection handler', () => {
  it('prefers direct sidecar URLs and sandbox-issued sidecar tokens when available', async () => {
    const handler = createWorkspaceSandboxConnectionHandler({
      requireUser: async () => ({ id: 'user-1' }),
      requireWorkspaceAccess: vi.fn(async () => {}),
      ensureWorkspaceSandbox: async () => ({
        id: 'box-1',
        status: 'running',
        connection: {
          runtimeUrl: 'https://sidecar.example',
          authToken: 'sidecar-token',
          authTokenExpiresAt: '2026-01-01T00:00:00.000Z',
        },
      }),
      tokenSecret: secret,
      tokenExpiresInMs: 60_000,
      exposeDirectSidecar: true,
    })

    const res = await handler({ request: new Request('https://app.test/api'), params: { workspaceId: 'workspace-1' } })
    const data = await res.json() as Record<string, unknown>

    expect(res.status).toBe(200)
    expect(data.runtimeUrl).toBe('https://sidecar.example')
    expect(data.sidecarUrl).toBe('https://sidecar.example')
    expect(data.token).toBe('sidecar-token')
    expect(data.expiresAt).toBe('2026-01-01T00:00:00.000Z')
    expect(data.status).toBe('running')
    expect(data.sandboxId).toBe('box-1')
  })

  it('returns a same-origin proxy URL, token, expiry, status, and sandbox id', async () => {
    const handler = createWorkspaceSandboxConnectionHandler({
      requireUser: async () => ({ id: 'user-1' }),
      requireWorkspaceAccess: vi.fn(async () => {}),
      ensureWorkspaceSandbox: async () => ({
        id: 'box-1',
        status: 'running',
        connection: { runtimeUrl: 'https://sandbox-runtime.example' },
      }),
      tokenSecret: secret,
      tokenExpiresInMs: 60_000,
    })

    const res = await handler({ request: new Request('https://app.test/api'), params: { workspaceId: 'workspace-1' } })
    const data = await res.json() as Record<string, unknown>

    expect(res.status).toBe(200)
    expect(data.runtimeUrl).toBe('/api/workspaces/workspace-1/sandbox/runtime/box-1')
    expect(data.sidecarUrl).toBe('/api/workspaces/workspace-1/sandbox/runtime/box-1')
    expect(data.token).toEqual(expect.any(String))
    expect(data.expiresAt).toEqual(expect.any(String))
    expect(data.status).toBe('running')
    expect(data.sandboxId).toBe('box-1')
  })

  it('accepts sidecarUrl-only SDK connections as runtime-ready in proxy mode', async () => {
    const handler = createWorkspaceSandboxConnectionHandler({
      requireUser: async () => ({ id: 'user-1' }),
      requireWorkspaceAccess: vi.fn(async () => {}),
      ensureWorkspaceSandbox: async () => ({
        id: 'box-1',
        status: 'running',
        connection: { sidecarUrl: 'https://sandbox-sidecar.example' },
      }),
      tokenSecret: secret,
      tokenExpiresInMs: 60_000,
    })

    const res = await handler({ request: new Request('https://app.test/api'), params: { workspaceId: 'workspace-1' } })
    const data = await res.json() as Record<string, unknown>

    expect(res.status).toBe(200)
    expect(data.runtimeUrl).toBe('/api/workspaces/workspace-1/sandbox/runtime/box-1')
    expect(data.sidecarUrl).toBe('/api/workspaces/workspace-1/sandbox/runtime/box-1')
    expect(data.token).toEqual(expect.any(String))
    expect(data.status).toBe('running')
    expect(data.sandboxId).toBe('box-1')
  })

  it('returns 503 while the sandbox runtime is not ready', async () => {
    const handler = createWorkspaceSandboxConnectionHandler({
      requireUser: async () => ({ id: 'user-1' }),
      requireWorkspaceAccess: async () => {},
      ensureWorkspaceSandbox: async () => ({ id: 'box-1', status: 'provisioning', connection: null }),
      tokenSecret: secret,
    })

    const res = await handler({ request: new Request('https://app.test/api'), params: { workspaceId: 'workspace-1' } })
    await expect(res.json()).resolves.toMatchObject({ status: 'provisioning' })
    expect(res.status).toBe(503)
  })
})

describe('workspace sandbox runtime proxy', () => {
  it('encodes safe paths and rejects traversal-shaped paths', () => {
    expect(encodeSandboxRuntimePath('terminal/session a')).toBe('terminal/session%20a')
    expect(encodeSandboxRuntimePath('terminal/%2F')).toBe('terminal/%252F')
    expect(encodeSandboxRuntimePath('')).toBeNull()
    expect(encodeSandboxRuntimePath('terminal//pty')).toBeNull()
    expect(encodeSandboxRuntimePath('../secret')).toBeNull()
    expect(encodeSandboxRuntimePath('terminal/./pty')).toBeNull()
  })

  it('extracts bearer tokens permissively but rejects empty values', () => {
    expect(bearerToken('Bearer abc')).toBe('abc')
    expect(bearerToken('abc')).toBe('abc')
    expect(bearerToken('Bearer   ')).toBeNull()
    expect(bearerToken(null)).toBeNull()
  })

  it('extracts browser WebSocket bearer subprotocol tokens', () => {
    const token = 'sbxt_payload.signature'
    const encoded = btoa(token).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

    expect(bearerSubprotocolToken(`bearer.${encoded}`)).toBe(token)
    expect(bearerSubprotocolToken(`chat, bearer.${encoded}`)).toBe(token)
    expect(bearerSubprotocolToken('bearer.')).toBeNull()
    expect(bearerSubprotocolToken(null)).toBeNull()
    expect(terminalTokenFromRequest(new Headers({
      'sec-websocket-protocol': `bearer.${encoded}`,
    }))).toBe(token)
  })

  it('forwards only allowed request headers plus server-side sandbox auth', () => {
    const headers = buildSandboxRuntimeProxyHeaders(new Headers({
      accept: 'text/event-stream',
      authorization: 'Bearer browser-token',
      'content-type': 'application/json',
      cookie: 'private',
      'x-session-id': 'session-1',
    }), 'sandbox-api-key')

    expect(headers.get('authorization')).toBe('Bearer sandbox-api-key')
    expect(headers.get('accept')).toBe('text/event-stream')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('x-session-id')).toBe('session-1')
    expect(headers.get('cookie')).toBeNull()
  })

  it('proxies valid requests with query preservation and strips upstream set-cookie', async () => {
    const token = await createSandboxTerminalToken(
      { userId: 'user-1', workspaceId: 'workspace-1', sandboxId: 'box-1' },
      { secret, expiresInMs: 60_000 },
    )
    const fetchMock = vi.fn(async (_input: URL, _init?: RequestInit) => new Response('ok', {
      status: 201,
      headers: { 'set-cookie': 'do-not-forward=1', 'x-runtime': 'yes' },
    }))
    const handler = createWorkspaceSandboxRuntimeProxyHandler({
      requireUser: async () => ({ id: 'user-1' }),
      requireWorkspaceAccess: async () => {},
      getSandboxApiCredentials: async () => ({ baseUrl: 'https://sandbox.test', apiKey: 'sandbox-key' }),
      tokenSecret: secret,
      fetch: fetchMock as typeof fetch,
    })

    const res = await handler({
      request: new Request('https://app.test/api/workspaces/workspace-1/sandbox/runtime/box-1/terminal/session%20a?cursor=1', {
        headers: { Authorization: `Bearer ${token.token}`, Accept: 'text/event-stream' },
      }),
      params: { workspaceId: 'workspace-1', sandboxId: 'box-1', '*': 'terminal/session a' },
    })

    expect(res.status).toBe(201)
    expect(await res.text()).toBe('ok')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('x-runtime')).toBe('yes')
    const [upstream, init] = fetchMock.mock.calls[0] as [URL, RequestInit & { duplex?: 'half' }]
    expect(String(upstream)).toBe('https://sandbox.test/v1/sidecar-proxy/box-1/terminal/session%20a?cursor=1')
    expect(init.headers).toBeInstanceOf(Headers)
    expect((init.headers as Headers).get('authorization')).toBe('Bearer sandbox-key')
  })

  it('proxies browser terminal requests to a direct sidecar connection when available', async () => {
    const token = await createSandboxTerminalToken(
      { userId: 'user-1', workspaceId: 'workspace-1', sandboxId: 'box-1' },
      { secret, expiresInMs: 60_000 },
    )
    const fetchMock = vi.fn(async (_input: URL, _init?: RequestInit) => new Response('created', {
      status: 201,
    }))
    const getSandboxApiCredentials = vi.fn(async () => ({ baseUrl: 'https://sandbox.test', apiKey: 'sandbox-key' }))
    const handler = createWorkspaceSandboxRuntimeProxyHandler({
      requireUser: async () => ({ id: 'user-1' }),
      requireWorkspaceAccess: async () => {},
      getSandboxApiCredentials,
      getSandboxRuntimeConnection: async () => ({
        runtimeUrl: 'http://localhost:60031',
        authToken: 'sidecar-token',
      }),
      tokenSecret: secret,
      fetch: fetchMock as typeof fetch,
    })

    const res = await handler({
      request: new Request('https://app.test/api/workspaces/workspace-1/sandbox/runtime/box-1/terminals?cols=120', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: 30 }),
      }),
      params: { workspaceId: 'workspace-1', sandboxId: 'box-1', '*': 'terminals' },
    })

    expect(res.status).toBe(201)
    expect(await res.text()).toBe('created')
    expect(getSandboxApiCredentials).not.toHaveBeenCalled()
    const [upstream, init] = fetchMock.mock.calls[0] as [URL, RequestInit & { duplex?: 'half' }]
    expect(String(upstream)).toBe('http://localhost:60031/terminals?cols=120')
    expect((init.headers as Headers).get('authorization')).toBe('Bearer sidecar-token')
    expect((init.headers as Headers).get('content-type')).toBe('application/json')
    expect(init.body).toBeInstanceOf(ReadableStream)
    expect(init.duplex).toBe('half')
  })

  it('falls back to the sandbox API when a direct sidecar connection has no bearer', async () => {
    const token = await createSandboxTerminalToken(
      { userId: 'user-1', workspaceId: 'workspace-1', sandboxId: 'box-1' },
      { secret, expiresInMs: 60_000 },
    )
    const fetchMock = vi.fn(async (_input: URL, _init?: RequestInit) => new Response('proxied', {
      status: 200,
    }))
    const getSandboxApiCredentials = vi.fn(async () => ({ baseUrl: 'https://sandbox.test', apiKey: 'sandbox-key' }))
    const handler = createWorkspaceSandboxRuntimeProxyHandler({
      requireUser: async () => ({ id: 'user-1' }),
      requireWorkspaceAccess: async () => {},
      getSandboxApiCredentials,
      getSandboxRuntimeConnection: async () => ({ runtimeUrl: 'http://localhost:60031' }),
      tokenSecret: secret,
      fetch: fetchMock as typeof fetch,
    })

    const res = await handler({
      request: new Request('https://app.test/api/workspaces/workspace-1/sandbox/runtime/box-1/terminals?cols=120', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: 30 }),
      }),
      params: { workspaceId: 'workspace-1', sandboxId: 'box-1', '*': 'terminals' },
    })

    expect(res.status).toBe(200)
    expect(getSandboxApiCredentials).toHaveBeenCalledOnce()
    const [upstream, init] = fetchMock.mock.calls[0] as [URL, RequestInit & { duplex?: 'half' }]
    expect(String(upstream)).toBe('https://sandbox.test/v1/sidecar-proxy/box-1/terminals?cols=120')
    expect((init.headers as Headers).get('authorization')).toBe('Bearer sandbox-key')
  })

  it('accepts terminal proxy auth from the browser WebSocket subprotocol', async () => {
    const token = await createSandboxTerminalToken(
      { userId: 'user-1', workspaceId: 'workspace-1', sandboxId: 'box-1' },
      { secret, expiresInMs: 60_000 },
    )
    const encoded = btoa(token.token).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const fetchMock = vi.fn(async (_input: URL, _init?: RequestInit) => new Response('proxied', {
      status: 200,
    }))
    const handler = createWorkspaceSandboxRuntimeProxyHandler({
      requireUser: async () => ({ id: 'user-1' }),
      requireWorkspaceAccess: async () => {},
      getSandboxApiCredentials: async () => ({ baseUrl: 'https://sandbox.test', apiKey: 'sandbox-key' }),
      tokenSecret: secret,
      fetch: fetchMock as typeof fetch,
    })

    const res = await handler({
      request: new Request('https://app.test/api/workspaces/workspace-1/sandbox/runtime/box-1/terminals/session/ws', {
        headers: { 'Sec-WebSocket-Protocol': `bearer.${encoded}` },
      }),
      params: { workspaceId: 'workspace-1', sandboxId: 'box-1', '*': 'terminals/session/ws' },
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('rejects invalid terminal tokens before fetching upstream', async () => {
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) => new Response())
    const handler = createWorkspaceSandboxRuntimeProxyHandler({
      requireUser: async () => ({ id: 'user-1' }),
      requireWorkspaceAccess: async () => {},
      getSandboxApiCredentials: async () => ({ baseUrl: 'https://sandbox.test', apiKey: 'sandbox-key' }),
      tokenSecret: secret,
      fetch: fetchMock,
    })

    const res = await handler({
      request: new Request('https://app.test/api', { headers: { Authorization: 'Bearer bad' } }),
      params: { workspaceId: 'workspace-1', sandboxId: 'box-1', '*': 'terminal/session' },
    })

    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('workspace sandbox terminal WebSocket upgrade', () => {
  it('matches terminal WebSocket paths and rejects malformed encoded ids', () => {
    expect(matchSandboxTerminalWsPath('/api/workspaces/workspace%201/sandbox/runtime/box%201/terminals/session/ws')).toEqual({
      workspaceId: 'workspace 1',
      sandboxId: 'box 1',
      subPath: 'terminals/session/ws',
    })
    expect(matchSandboxTerminalWsPath('/api/workspaces/%ZZ/sandbox/runtime/box-1/terminals/session/ws')).toBeNull()
    expect(isSandboxTerminalWsUpgrade(new Request('https://app.test/api/workspaces/%ZZ/sandbox/runtime/box-1/terminals/session/ws', {
      headers: { Upgrade: 'websocket' },
    }))).toBe(false)
  })

  it('auth-gates and forwards terminal WebSocket upgrades without the browser bearer subprotocol', async () => {
    const token = await createSandboxTerminalToken(
      { userId: 'user-1', workspaceId: 'workspace-1', sandboxId: 'box-1' },
      { secret, expiresInMs: 60_000 },
    )
    const encoded = btoa(token.token).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => new Response('upgraded', { status: 200 }))
    const handler = createWorkspaceSandboxTerminalUpgradeHandler({
      requireUser: async () => ({ id: 'user-1' }),
      requireWorkspaceAccess: async () => {},
      getSandboxApiCredentials: async () => ({ baseUrl: 'https://sandbox.test', apiKey: 'sandbox-key' }),
      tokenSecret: secret,
      fetch: fetchMock as typeof fetch,
    })

    const res = await handler(new Request('https://app.test/api/workspaces/workspace-1/sandbox/runtime/box-1/terminals/session/ws?cols=120', {
      headers: {
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': `terminal, bearer.${encoded}`,
      },
    }))

    expect(res?.status).toBe(200)
    const [upstream, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(upstream).toBe('https://sandbox.test/v1/sidecar-proxy/box-1/terminals/session/ws?cols=120')
    expect((init.headers as Headers).get('authorization')).toBe('Bearer sandbox-key')
    expect((init.headers as Headers).get('sec-websocket-protocol')).toBe('terminal')
  })

  it('keeps the runtime bearer out of the websocket subprotocol for direct sidecar upgrades', async () => {
    const token = await createSandboxTerminalToken(
      { userId: 'user-1', workspaceId: 'workspace-1', sandboxId: 'box-1' },
      { secret, expiresInMs: 60_000 },
    )
    const encoded = btoa(token.token).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => new Response('upgraded', { status: 200 }))
    const handler = createWorkspaceSandboxTerminalUpgradeHandler({
      requireUser: async () => ({ id: 'user-1' }),
      requireWorkspaceAccess: async () => {},
      getSandboxApiCredentials: async () => ({ baseUrl: 'https://sandbox.test', apiKey: 'sandbox-key' }),
      getSandboxRuntimeConnection: async () => ({ runtimeUrl: 'https://sidecar.test', authToken: 'runtime-token' }),
      tokenSecret: secret,
      fetch: fetchMock as typeof fetch,
    })

    const res = await handler(new Request('https://app.test/api/workspaces/workspace-1/sandbox/runtime/box-1/terminals/session/ws', {
      headers: {
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': `terminal, bearer.${encoded}`,
      },
    }))

    expect(res?.status).toBe(200)
    const [upstream, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(upstream).toBe('https://sidecar.test/terminals/session/ws')
    expect((init.headers as Headers).get('authorization')).toBe('Bearer runtime-token')
    expect((init.headers as Headers).get('sec-websocket-protocol')).toBe('terminal')
  })

  it('rejects invalid WebSocket terminal tokens before fetching upstream', async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => new Response('upgraded', { status: 200 }))
    const handler = createWorkspaceSandboxTerminalUpgradeHandler({
      requireUser: async () => ({ id: 'user-1' }),
      requireWorkspaceAccess: async () => {},
      getSandboxApiCredentials: async () => ({ baseUrl: 'https://sandbox.test', apiKey: 'sandbox-key' }),
      tokenSecret: secret,
      fetch: fetchMock as typeof fetch,
    })

    const res = await handler(new Request('https://app.test/api/workspaces/workspace-1/sandbox/runtime/box-1/terminals/session/ws', {
      headers: {
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': 'bearer.bad',
      },
    }))

    expect(res?.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// The terminal upstream contract, pinned to a live measurement.
//
// Measured 2026-07-28 against production `sandbox.tangle.tools`, one box
// (`sandbox-d168da28-21d`), the same `ws` client and the same credential in
// every arm — only the upstream base differed:
//
//   /v1/sidecar-proxy/{id}          -> 101, `ready` @2551ms, shell prompt @3350ms
//   /v1/sandboxes/{id}/runtime/     -> HTTP 500
//   connection.runtimeUrl (box host)-> 101, then close 1000 with 0 bytes
//
// The box host's Caddy upgrades EVERY path (`/`, `/health`, and a route that
// does not exist all returned 101 and held open), so a 101 from it proves
// nothing. Only `/v1/sidecar-proxy/{id}` ever produced a PTY.
// ---------------------------------------------------------------------------
describe('terminal upstream base', () => {
  it('builds the one base that produced a shell, and encodes the id', () => {
    expect(sandboxSidecarProxyUrl('https://sandbox.test', 'box-1')).toBe('https://sandbox.test/v1/sidecar-proxy/box-1')
    expect(sandboxSidecarProxyUrl('https://sandbox.test/', 'box 1')).toBe('https://sandbox.test/v1/sidecar-proxy/box%201')
    // A base with a path is replaced, not appended to: the route is absolute.
    expect(sandboxSidecarProxyUrl('https://sandbox.test/v1', 'box-1')).toBe('https://sandbox.test/v1/sidecar-proxy/box-1')
  })

  it('fails loud on a missing base or id rather than dialling a malformed host', () => {
    expect(() => sandboxSidecarProxyUrl('', 'box-1')).toThrow(/baseUrl/)
    expect(() => sandboxSidecarProxyUrl('https://sandbox.test', '')).toThrow(/sandboxId/)
  })

  it('never dials the /v1/sandboxes/{id}/runtime/ base that answered 500', async () => {
    const token = await createSandboxTerminalToken(
      { userId: 'user-1', workspaceId: 'workspace-1', sandboxId: 'box-1' },
      { secret, expiresInMs: 60_000 },
    )
    const encoded = btoa(token.token).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const dialled: string[] = []
    const fetchMock = vi.fn(async (input: string | URL) => {
      dialled.push(String(input))
      return new Response('upgraded', { status: 200 })
    })
    const upgrade = createWorkspaceSandboxTerminalUpgradeHandler({
      requireUser: async () => ({ id: 'user-1' }),
      requireWorkspaceAccess: async () => {},
      getSandboxApiCredentials: async () => ({ baseUrl: 'https://sandbox.test', apiKey: 'sandbox-key' }),
      tokenSecret: secret,
      fetch: fetchMock as typeof fetch,
    })
    await upgrade(new Request('https://app.test/api/workspaces/workspace-1/sandbox/runtime/box-1/terminals/session/ws', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `bearer.${encoded}` },
    }))

    const proxy = createWorkspaceSandboxRuntimeProxyHandler({
      requireUser: async () => ({ id: 'user-1' }),
      requireWorkspaceAccess: async () => {},
      getSandboxApiCredentials: async () => ({ baseUrl: 'https://sandbox.test', apiKey: 'sandbox-key' }),
      tokenSecret: secret,
      fetch: fetchMock as typeof fetch,
    })
    await proxy({
      request: new Request('https://app.test/api/workspaces/workspace-1/sandbox/runtime/box-1/terminals', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token.token}` },
      }),
      params: { workspaceId: 'workspace-1', sandboxId: 'box-1', '*': 'terminals' },
    })

    expect(dialled).toHaveLength(2)
    for (const url of dialled) {
      expect(url).toContain('/v1/sidecar-proxy/box-1/')
      expect(url).not.toContain('/runtime/')
      expect(url).not.toContain('/v1/sandboxes/')
    }
  })
})

describe('terminal 101 subprotocol echo', () => {
  const like = (status: number, headers: Record<string, string> = {}) => ({
    status,
    statusText: '',
    headers: new Headers(headers),
  })

  it('picks the bearer offer out of a multi-protocol header', () => {
    expect(selectedBearerSubprotocol('terminal, bearer.abc')).toBe('bearer.abc')
    expect(selectedBearerSubprotocol('BEARER.abc')).toBe('BEARER.abc')
    expect(selectedBearerSubprotocol('terminal')).toBeNull()
    expect(selectedBearerSubprotocol(null)).toBeNull()
  })

  it('echoes the browser offer when the upstream 101 selected none', () => {
    // Without this the browser fails the connection on a 101 that selected no
    // subprotocol after it offered one, and the terminal spins forever.
    const echo = terminalUpgradeSubprotocolEcho(like(101), 'bearer.abc')
    expect(echo?.status).toBe(101)
    expect(echo?.headers.get('Sec-WebSocket-Protocol')).toBe('bearer.abc')
  })

  it('preserves the rest of the upstream 101 headers', () => {
    const echo = terminalUpgradeSubprotocolEcho(like(101, { upgrade: 'websocket', 'sec-websocket-accept': 'abc=' }), 'bearer.abc')
    expect(echo?.headers.get('upgrade')).toBe('websocket')
    expect(echo?.headers.get('sec-websocket-accept')).toBe('abc=')
  })

  it('leaves the upstream selection alone when it picked one', () => {
    expect(terminalUpgradeSubprotocolEcho(like(101, { 'sec-websocket-protocol': 'tangle.terminal.v1' }), 'bearer.abc')).toBeNull()
  })

  it('does not touch a non-101 response, or one the browser sent no offer for', () => {
    expect(terminalUpgradeSubprotocolEcho(like(500), 'bearer.abc')).toBeNull()
    expect(terminalUpgradeSubprotocolEcho(like(403), 'bearer.abc')).toBeNull()
    expect(terminalUpgradeSubprotocolEcho(like(101), null)).toBeNull()
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
