import { describe, expect, it, vi } from 'vitest'
import { authenticateToolRequest, DEFAULT_HEADER_NAMES, readToolArgs } from './auth'

const H = DEFAULT_HEADER_NAMES

function toolRequest(headers: Record<string, string>): Request {
  return new Request('https://app.example.com/api/tools/propose', {
    method: 'POST',
    headers,
  })
}

function fullHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    [H.userId]: 'user-a',
    [H.workspaceId]: 'workspace-a',
    [H.threadId]: 'thread-a',
    authorization: 'Bearer tok',
    ...overrides,
  }
}

describe('authenticateToolRequest — capability subject', () => {
  it('verifies against the user by default, so an existing caller is unchanged', async () => {
    const verifyToken = vi.fn().mockResolvedValue(true)
    const result = await authenticateToolRequest(toolRequest(fullHeaders()), { verifyToken })

    expect(result.ok).toBe(true)
    expect(verifyToken).toHaveBeenCalledWith('user-a', 'tok')
  })

  // The reason this option exists. A token that must live in the BOX
  // environment cannot be per-user: that environment is workspace-wide and
  // written once at box creation, so a per-user token cannot be delivered — and
  // one written there anyway is readable by every member of the workspace's
  // box, so it was never per-user in the first place.
  it('verifies against the workspace when the product says the token is workspace-bound', async () => {
    const verifyToken = vi.fn().mockResolvedValue(true)
    const result = await authenticateToolRequest(toolRequest(fullHeaders()), {
      verifyToken,
      subject: 'workspaceId',
    })

    expect(result.ok).toBe(true)
    expect(verifyToken).toHaveBeenCalledWith('workspace-a', 'tok')
  })

  // Binding the bearer to the workspace must NOT collapse the identity. The
  // real user still rides `ctx`, because downstream domain code attributes work
  // to it — overwriting it with the workspace id (a workaround some products
  // reached for) misattributes every record the tool writes.
  it('still returns the real user on ctx when the bearer is workspace-bound', async () => {
    const result = await authenticateToolRequest(toolRequest(fullHeaders()), {
      verifyToken: async () => true,
      subject: 'workspaceId',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.ctx).toEqual({ userId: 'user-a', workspaceId: 'workspace-a', threadId: 'thread-a' })
  })

  it('rejects a token minted for a different workspace', async () => {
    const verifyToken = vi.fn(async (subject: string) => subject === 'workspace-b')
    const result = await authenticateToolRequest(toolRequest(fullHeaders()), {
      verifyToken,
      subject: 'workspaceId',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(401)
  })

  it('rejects a token minted for a different user', async () => {
    const verifyToken = vi.fn(async (subject: string) => subject === 'user-b')
    const result = await authenticateToolRequest(toolRequest(fullHeaders()), { verifyToken })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(401)
  })

  // Verifying against an absent subject is not a check. A workspace-bound
  // product with no workspace header must be refused BEFORE verifyToken runs,
  // or a product whose verify is lenient about an empty subject authenticates
  // anything.
  it('refuses a workspace-bound request with no workspace header, without verifying', async () => {
    const verifyToken = vi.fn().mockResolvedValue(true)
    const headers = fullHeaders()
    delete headers[H.workspaceId]
    const result = await authenticateToolRequest(toolRequest(headers), {
      verifyToken,
      subject: 'workspaceId',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(400)
    expect(verifyToken).not.toHaveBeenCalled()
  })

  it.each(['userId', 'workspaceId'] as const)(
    'refuses a request with no bearer at all (subject=%s)',
    async (subject) => {
      const verifyToken = vi.fn().mockResolvedValue(true)
      const headers = fullHeaders()
      delete headers.authorization
      const result = await authenticateToolRequest(toolRequest(headers), { verifyToken, subject })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.response.status).toBe(401)
      expect(verifyToken).not.toHaveBeenCalled()
    },
  )

  it.each(['userId', 'workspaceId'] as const)(
    'requires the user header even when the bearer is not bound to it (subject=%s)',
    async (subject) => {
      const headers = fullHeaders()
      delete headers[H.userId]
      const result = await authenticateToolRequest(toolRequest(headers), {
        verifyToken: async () => true,
        subject,
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.response.status).toBe(401)
    },
  )

  it('honours product header names', async () => {
    const verifyToken = vi.fn().mockResolvedValue(true)
    const result = await authenticateToolRequest(
      toolRequest({
        'X-Acme-User-Id': 'user-a',
        'X-Acme-Workspace-Id': 'workspace-a',
        'X-Acme-Thread-Id': 'thread-a',
        authorization: 'Bearer tok',
      }),
      {
        verifyToken,
        subject: 'workspaceId',
        headerNames: {
          userId: 'X-Acme-User-Id',
          workspaceId: 'X-Acme-Workspace-Id',
          threadId: 'X-Acme-Thread-Id',
        },
      },
    )

    expect(result.ok).toBe(true)
    expect(verifyToken).toHaveBeenCalledWith('workspace-a', 'tok')
  })
})

describe('readToolArgs', () => {
  it('reads arguments from the Streamable HTTP MCP envelope', async () => {
    const request = new Request('https://app.example.com/api/tools/propose', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'submit_proposal', arguments: { title: 'Review' } },
      }),
    })

    await expect(readToolArgs(request)).resolves.toEqual({ title: 'Review' })
  })

  it('returns an empty object when an MCP call omits arguments', async () => {
    const request = new Request('https://app.example.com/api/tools/propose', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'submit_proposal' } }),
    })

    await expect(readToolArgs(request)).resolves.toEqual({})
  })
})
