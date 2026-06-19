import { describe, expect, it, vi } from 'vitest'
import {
  bearerSubprotocolToken,
  bearerToken,
  buildSandboxRuntimeProxyHeaders,
  createSandboxTerminalToken,
  createWorkspaceSandboxConnectionHandler,
  createWorkspaceSandboxRuntimeProxyHandler,
  createWorkspaceSandboxTerminalUpgradeHandler,
  encodeSandboxRuntimePath,
  isSandboxTerminalWsUpgrade,
  matchSandboxTerminalWsPath,
  terminalTokenFromRequest,
  verifySandboxTerminalToken,
} from '../src/sandbox/index'

const secret = 'terminal-secret'

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
    expect(String(upstream)).toBe('https://sandbox.test/v1/sandboxes/box-1/runtime/terminal/session%20a?cursor=1')
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
    expect(String(upstream)).toBe('https://sandbox.test/v1/sandboxes/box-1/runtime/terminals?cols=120')
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
    expect(upstream).toBe('https://sandbox.test/v1/sandboxes/box-1/runtime/terminals/session/ws?cols=120')
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
