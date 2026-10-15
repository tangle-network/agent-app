import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { canonicalAgentProfileDigest, snapshotAgentProfile, type AgentProfile } from '@tangle-network/agent-interface'
import {
  checkMcpServer, createGitHubRestReader, createGitHubSourceService, createMcpHealthChecker, GitHubReadError, handleProfileEditorRequest,
  type GitHubSourceReader, type ProfileEditorMcpCheckContext,
} from './server'
import { createProfileEditorClient, parseGitHubLocation, publicHttpsUrlProblem } from './index'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const TREE = 'fedcba9876543210fedcba9876543210fedcba98'
const encoder = new TextEncoder()
const skill = '---\nname: research\ndescription: Research a question from primary sources.\n---\n\n# Research\n'

function reader(overrides: Partial<GitHubSourceReader> = {}): GitHubSourceReader {
  const blobs: Record<string, Uint8Array> = {
    skill: encoder.encode(skill),
    readme: encoder.encode('# Readme\n'),
    binary: new Uint8Array([0xff, 0xfe, 0x00, 0x81]),
  }
  return {
    listRepositories: async () => [{ fullName: 'acme/skills', private: true, defaultBranch: 'main', description: 'Skills' }],
    getRepository: async (owner, repo) => {
      if (`${owner}/${repo}` !== 'acme/skills') throw new GitHubReadError(404, 'Not Found')
      return { fullName: 'acme/skills', private: true, defaultBranch: 'main' }
    },
    getBranchHead: async () => ({ sha: SHA, treeSha: TREE, committedAt: '2026-10-01T00:00:00Z', message: 'Update research\n\nBody' }),
    getCommit: async (_owner, _repo, sha) => {
      if (sha !== SHA) throw new GitHubReadError(422, 'No commit found for SHA')
      return { sha: SHA, treeSha: TREE }
    },
    getTree: async () => ({ truncated: false, entries: [
      { path: 'skills', type: 'tree', sha: 't1' },
      { path: 'skills/research', type: 'tree', sha: 't2' },
      { path: 'skills/research/SKILL.md', type: 'blob', sha: 'skill', size: skill.length },
      { path: 'docs', type: 'tree', sha: 't3' },
      { path: 'README.md', type: 'blob', sha: 'readme', size: 9 },
      { path: 'logo.bin', type: 'blob', sha: 'binary', size: 4 },
      { path: 'huge.md', type: 'blob', sha: 'huge', size: 10_000_000 },
    ] }),
    getBlob: async (_owner, _repo, sha) => {
      const blob = blobs[sha]
      if (!blob) throw new GitHubReadError(404, 'Not Found')
      return blob
    },
    ...overrides,
  }
}

describe('GitHub source service', () => {
  const service = createGitHubSourceService(reader())

  it('resolves the default branch head as the latest commit', async () => {
    const latest = await service.latest('acme/skills')
    expect(latest).toEqual({ ok: true, value: {
      repository: { fullName: 'acme/skills', private: true, defaultBranch: 'main' },
      commit: { sha: SHA, branch: 'main', committedAt: '2026-10-01T00:00:00Z', message: 'Update research' },
    } })
  })

  it('reports a missing repository, a refused connection, and a missing connection distinctly', async () => {
    expect(await service.latest('acme/missing')).toMatchObject({ ok: false, problem: 'repository-not-found' })
    const refused = createGitHubSourceService(reader({ getRepository: async () => { throw new GitHubReadError(403, 'Resource protected by organization SAML enforcement') } }))
    const noAccess = await refused.latest('acme/skills')
    expect(noAccess).toMatchObject({ ok: false, problem: 'no-access' })
    expect(noAccess.ok ? '' : noAccess.message).toContain('acme/skills')
    const rejected = createGitHubSourceService(reader({ getRepository: async () => { throw new GitHubReadError(401, 'Bad credentials') } }))
    expect(await rejected.latest('acme/skills')).toMatchObject({ ok: false, problem: 'no-access', message: expect.stringContaining('Reconnect') })
    const missing = createGitHubSourceService(reader({ getRepository: async () => { throw new GitHubReadError('not-connected', 'none') } }))
    expect(await missing.latest('acme/skills')).toMatchObject({ ok: false, problem: 'not-connected' })
    const limited = createGitHubSourceService(reader({ getRepository: async () => { throw new GitHubReadError(403, 'API rate limit exceeded', true) } }))
    expect(await limited.latest('acme/skills')).toMatchObject({ ok: false, problem: 'rate-limited' })
  })

  it('explains a missing commit, and a missing repository behind a commit lookup', async () => {
    expect(await service.commit('acme/skills', 'a'.repeat(40))).toMatchObject({ ok: false, problem: 'ref-not-found' })
    expect(await service.commit('acme/skills', 'abc')).toMatchObject({ ok: false, problem: 'ref-not-found' })
    const gone = createGitHubSourceService(reader({ getCommit: async () => { throw new GitHubReadError(404, 'Not Found') } }))
    expect(await gone.commit('acme/missing', SHA)).toMatchObject({ ok: false, problem: 'repository-not-found' })
  })

  it('lists files at a commit for path suggestions', async () => {
    const files = await service.files('acme/skills', SHA)
    expect(files.ok && files.value.files.map(file => file.path)).toEqual(['skills/research/SKILL.md', 'README.md', 'logo.bin', 'huge.md'])
  })

  it('reads a skill, resolving a skill folder to its SKILL.md', async () => {
    const checked = await service.check({ repository: 'acme/skills', path: 'skills/research', commit: SHA, purpose: 'skill' })
    expect(checked).toMatchObject({ ok: true, value: { path: 'skills/research/SKILL.md', content: skill,
      skill: { name: 'research', description: 'Research a question from primary sources.' }, commit: { sha: SHA } } })
  })

  it('refuses a path that is missing, a folder, not a skill, too large, or binary', async () => {
    const check = (path: string, purpose: 'skill' | 'file' = 'skill') => service.check({ repository: 'acme/skills', path, commit: SHA, purpose })
    expect(await check('skills/missing/SKILL.md')).toMatchObject({ ok: false, problem: 'path-not-found' })
    expect(await check('docs')).toMatchObject({ ok: false, problem: 'not-a-file' })
    expect(await check('README.md')).toMatchObject({ ok: false, problem: 'not-a-skill' })
    expect(await check('README.md', 'file')).toMatchObject({ ok: true, value: { content: '# Readme\n' } })
    expect(await check('huge.md', 'file')).toMatchObject({ ok: false, problem: 'unsupported-file' })
    expect(await check('logo.bin', 'file')).toMatchObject({ ok: false, problem: 'unsupported-file', message: expect.stringContaining('not a text file') })
    expect(await check('../secrets', 'file')).toMatchObject({ ok: false, problem: 'path-not-found' })
  })

  it('says when the transport cannot list repositories', async () => {
    const unlisted = createGitHubSourceService(reader({ listRepositories: undefined }))
    expect(await unlisted.repositories()).toMatchObject({ ok: false, problem: 'unavailable', message: expect.stringContaining('owner/repo') })
  })
})

describe('GitHub REST reader', () => {
  it('sends the token and maps refusals and rate limits to read errors', async () => {
    const calls: { url: string; auth: string | null }[] = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, auth: new Headers(init?.headers).get('Authorization') })
      if (url.endsWith('/repos/acme/limited')) return new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
      if (url.endsWith('/repos/acme/missing')) return new Response('{"message":"Not Found"}', { status: 404 })
      return Response.json({ full_name: 'acme/skills', private: false, default_branch: 'trunk', description: null })
    })
    const rest = createGitHubRestReader({ token: 'token-value', fetch: fetch as typeof globalThis.fetch })
    expect(await rest.getRepository('acme', 'skills')).toEqual({ fullName: 'acme/skills', private: false, defaultBranch: 'trunk', description: null })
    expect(calls[0]).toEqual({ url: 'https://api.github.com/repos/acme/skills', auth: 'Bearer token-value' })
    await expect(rest.getRepository('acme', 'missing')).rejects.toMatchObject({ status: 404 })
    await expect(rest.getRepository('acme', 'limited')).rejects.toMatchObject({ status: 403, rateLimited: true })
    expect(createGitHubRestReader().listRepositories).toBeUndefined()
  })
})

describe('parseGitHubLocation', () => {
  it('reads names, links, and remotes', () => {
    expect(parseGitHubLocation('acme/skills')).toEqual({ repository: 'acme/skills' })
    expect(parseGitHubLocation('https://github.com/acme/skills.git')).toEqual({ repository: 'acme/skills' })
    expect(parseGitHubLocation('git@github.com:acme/skills.git')).toEqual({ repository: 'acme/skills' })
    expect(parseGitHubLocation(`github.com/acme/skills/blob/${SHA}/skills/research/SKILL.md`))
      .toEqual({ repository: 'acme/skills', ref: SHA, path: 'skills/research/SKILL.md' })
    expect(parseGitHubLocation('https://github.com/acme/skills/tree/main/skills')).toEqual({ repository: 'acme/skills', ref: 'main', path: 'skills' })
    expect(parseGitHubLocation('acme')).toBeNull()
    expect(parseGitHubLocation('../skills')).toBeNull()
    expect(parseGitHubLocation('https://github.com/acme/skills/issues/4')).toBeNull()
  })
})

describe('public HTTPS address policy', () => {
  it('accepts public HTTPS and explains every refusal', () => {
    expect(publicHttpsUrlProblem('https://mcp.example.com/mcp')).toBeNull()
    expect(publicHttpsUrlProblem('http://mcp.example.com/mcp')).toContain('public HTTPS')
    expect(publicHttpsUrlProblem('https://localhost/mcp')).toContain('public address')
    expect(publicHttpsUrlProblem('https://10.0.0.4/mcp')).toContain('public address')
    expect(publicHttpsUrlProblem('https://svc.internal/mcp')).toContain('public address')
    expect(publicHttpsUrlProblem('https://user:pass@mcp.example.com/mcp')).toContain('credentials')
    expect(publicHttpsUrlProblem('https://mcp.example.com/mcp?key=1')).toContain('query')
    expect(publicHttpsUrlProblem('not a url')).toContain('full URL')
  })
})

function sse(...events: string[]): Response {
  return new Response(events.map(event => `event: message\ndata: ${event}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}

describe('checkMcpServer', () => {
  it('initializes a Streamable HTTP session and lists tools across JSON and event-stream replies', async () => {
    const seen: { method: string; body: string; session: string | null }[] = []
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      const body = String(init?.body ?? '')
      seen.push({ method: init?.method ?? 'GET', body, session: headers.get('mcp-session-id') })
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      const message = body ? JSON.parse(body) as { id?: number; method: string } : { method: '' }
      if (message.method === 'initialize') {
        return Response.json({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'docs', version: '2.1' } } },
          { headers: { 'mcp-session-id': 'session-1' } })
      }
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 })
      return sse(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress' }),
        JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'search', description: 'Search docs' }, { name: 'read' }] } }))
    })
    const health = await checkMcpServer({ transport: 'http', url: 'https://docs.example.com/mcp', headers: { 'X-Team': { kind: 'public', value: 'growth' } } },
      { fetch: fetch as typeof globalThis.fetch })
    expect(health).toMatchObject({ ok: true, serverName: 'docs', serverVersion: '2.1', tools: [{ name: 'search', description: 'Search docs' }, { name: 'read' }] })
    expect(seen.map(call => call.method)).toEqual(['POST', 'POST', 'POST', 'DELETE'])
    expect(seen.slice(1).every(call => call.session === 'session-1')).toBe(true)
    expect(new Headers((fetch.mock.calls[0]![1] as RequestInit).headers).get('X-Team')).toBe('growth')
  })

  it.each(['Authorization', '__proto__'])('refuses required reference header %s before anonymous success', async (name) => {
    const anonymous = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const message = JSON.parse(String(init?.body)) as { id?: number }
      return Response.json({ jsonrpc: '2.0', id: message.id, result: { tools: [] } })
    })
    const result = await checkMcpServer({ url: 'https://docs.example.com/mcp',
      headers: { [name]: { kind: 'secret-ref', key: 'docs-access' } } }, { fetch: anonymous as typeof globalThis.fetch })
    expect(result).toMatchObject({ ok: false, problem: 'auth-required' })
    expect(anonymous).not.toHaveBeenCalled()
  })

  it('requires secret references for credential headers arriving through the editor route', async () => {
    const send = vi.fn()
    for (const authorization of ['literal-not-allowed', { kind: 'public', value: 'public-not-credential' }]) {
      const request = new Request('https://app.test/editor/mcp/check', { method: 'POST', body: JSON.stringify({
        server: { url: 'https://docs.example.com/mcp', headers: { Authorization: authorization } },
      }) })
      const response = await handleProfileEditorRequest(request, 'mcp/check', {
        github: null, mcp: createMcpHealthChecker({ fetch: send as typeof globalThis.fetch }),
      })
      expect(await response.json()).toMatchObject({ ok: false, problem: 'not-checkable' })
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('completes a real MCP handshake through the trusted reference transport without exposing its credential', async () => {
    const canary = 'controlled-mcp-custody-canary'
    const methods: string[] = []
    const server = createServer(async (request, response) => {
      if (request.headers.authorization !== `Bearer ${canary}`) {
        response.writeHead(401).end()
        return
      }
      if (request.method === 'DELETE') {
        methods.push('DELETE')
        response.writeHead(204).end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const message = JSON.parse(Buffer.concat(chunks).toString()) as { method: string; id?: number }
      methods.push(message.method)
      if (message.method === 'notifications/initialized') {
        response.writeHead(202).end()
        return
      }
      response.setHeader('Content-Type', 'application/json')
      response.setHeader('Mcp-Session-Id', 'checked-session')
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'initialize'
        ? { protocolVersion: '2025-06-18', serverInfo: { name: 'authenticated-docs' } }
        : { tools: [{ name: 'read_docs' }] } }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test listener')
    const url = `http://127.0.0.1:${address.port}/mcp`
    const publicFetch = vi.fn(async () => { throw new Error('Public transport must not handle references') })
    const boundaries: unknown[] = []
    try {
      const health = await checkMcpServer({ transport: 'http', url, headers: {
        Authorization: { kind: 'secret-ref', key: 'docs-access' }, 'X-Team': { kind: 'public', value: 'growth' },
      } }, {
        urlProblem: value => value === url ? null : 'Test address refused',
        fetch: publicFetch as typeof globalThis.fetch,
        proxyFetch: async (input, init, secretHeaders) => {
          boundaries.push([String(input), init, secretHeaders])
          expect(secretHeaders).toEqual({ Authorization: { kind: 'secret-ref', key: 'docs-access' } })
          expect(new Headers(init.headers).get('Authorization')).toBeNull()
          expect(new Headers(init.headers).get('X-Team')).toBe('growth')
          expect(init.redirect).toBe('manual')
          const headers = new Headers(init.headers)
          headers.set('Authorization', `Bearer ${canary}`)
          return globalThis.fetch(input, { ...init, headers })
        },
      })
      expect(health).toMatchObject({ ok: true, serverName: 'authenticated-docs', tools: [{ name: 'read_docs' }] })
      expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'DELETE'])
      expect(publicFetch).not.toHaveBeenCalled()
      expect(JSON.stringify([boundaries, health])).not.toContain(canary)
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('redacts protected transport failures and upstream error text, and enforces the address policy', async () => {
    const reflected = 'controlled-sensitive-upstream-detail'
    const server = { url: 'https://docs.example.com/mcp',
      headers: { Authorization: { kind: 'secret-ref', key: 'docs-access' } } } as const
    const refused = vi.fn(async () => { throw new Error(reflected) })
    expect(await checkMcpServer({ ...server, url: 'http://localhost/mcp' }, { proxyFetch: refused }))
      .toMatchObject({ ok: false, problem: 'blocked-url' })
    expect(refused).not.toHaveBeenCalled()
    const denied = await checkMcpServer(server, { proxyFetch: refused })
    expect(denied).toMatchObject({ ok: false, problem: 'unreachable' })
    expect(JSON.stringify(denied)).not.toContain(reflected)
    const redirect = vi.fn(async () => new Response(null, { status: 307,
      headers: { location: 'https://unapproved.example.com/mcp' } }))
    expect(await checkMcpServer(server, { proxyFetch: redirect }))
      .toMatchObject({ ok: false, problem: 'protocol-error', status: 307 })
    expect(redirect).toHaveBeenCalledTimes(1)
    const reflection = await checkMcpServer(server, { proxyFetch: async () => Response.json({
      jsonrpc: '2.0', id: 1, error: { code: -32603, message: reflected },
    }) })
    expect(reflection).toMatchObject({ ok: false, problem: 'protocol-error' })
    expect(JSON.stringify(reflection)).not.toContain(reflected)
  })

  it('speaks the HTTP+SSE transport through the announced endpoint', async () => {
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined
    const push = (event: string, data: string) => stream!.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`))
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; push('endpoint', '/messages?session=9') } })
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      }
      expect(String(input)).toBe('https://sse.example.com/messages?session=9')
      const message = JSON.parse(String(init?.body)) as { id?: number; method: string }
      if (message.method === 'initialize') queueMicrotask(() => push('message', JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'legacy' } } })))
      if (message.method === 'tools/list') queueMicrotask(() => push('message', JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'lookup' }] } })))
      return new Response(null, { status: 202 })
    })
    const health = await checkMcpServer({ transport: 'sse', url: 'https://sse.example.com/sse' }, { fetch: fetch as typeof globalThis.fetch })
    expect(health).toMatchObject({ ok: true, serverName: 'legacy', tools: [{ name: 'lookup' }] })
  })

  it('never asks fetch to throw on redirects, which Cloudflare Workers reject, and refuses a redirect itself', async () => {
    // Workers' fetch accepts only redirect 'follow' or 'manual'.
    const workerFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.redirect !== undefined && init.redirect !== 'follow' && init.redirect !== 'manual') {
        throw new TypeError(`Invalid redirect value, must be one of "follow" or "manual" ("${init.redirect}" specified).`)
      }
      return new Response(null, { status: 307, headers: { location: 'https://elsewhere.example.com/mcp' } })
    }) as unknown as typeof globalThis.fetch
    expect(await checkMcpServer({ url: 'https://moved.example.com/mcp' }, { fetch: workerFetch }))
      .toMatchObject({ ok: false, problem: 'protocol-error', message: expect.stringContaining('redirected') })
    expect(await checkMcpServer({ transport: 'sse', url: 'https://moved.example.com/sse' }, { fetch: workerFetch }))
      .toMatchObject({ ok: false, problem: 'protocol-error' })
  })

  it('reports credentials, non-MCP answers, refused addresses, local servers, and timeouts', async () => {
    const answer = (response: () => Response) => vi.fn(async () => response()) as unknown as typeof globalThis.fetch
    expect(await checkMcpServer({ url: 'https://auth.example.com/mcp' }, { fetch: answer(() => new Response('', { status: 401 })) }))
      .toMatchObject({ ok: false, problem: 'auth-required', status: 401 })
    expect(await checkMcpServer({ url: 'https://www.example.com/' }, { fetch: answer(() => new Response('<html></html>', { headers: { 'content-type': 'text/html' } })) }))
      .toMatchObject({ ok: false, problem: 'protocol-error' })
    expect(await checkMcpServer({ url: 'https://gone.example.com/mcp' }, { fetch: answer(() => new Response('', { status: 404 })) }))
      .toMatchObject({ ok: false, problem: 'protocol-error' })
    const never = vi.fn()
    expect(await checkMcpServer({ url: 'http://localhost:3000/mcp' }, { fetch: never as unknown as typeof globalThis.fetch }))
      .toMatchObject({ ok: false, problem: 'blocked-url' })
    expect(await checkMcpServer({ url: 'nope' }, { fetch: never as unknown as typeof globalThis.fetch })).toMatchObject({ ok: false, problem: 'invalid-url' })
    expect(await checkMcpServer({ command: 'npx', args: [] }, { fetch: never as unknown as typeof globalThis.fetch })).toMatchObject({ ok: false, problem: 'not-checkable' })
    expect(never).not.toHaveBeenCalled()
    const hang = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })) as unknown as typeof globalThis.fetch
    expect(await checkMcpServer({ url: 'https://slow.example.com/mcp' }, { fetch: hang, timeoutMs: 20 })).toMatchObject({ ok: false, problem: 'timeout' })
    const refused = vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as typeof globalThis.fetch
    expect(await checkMcpServer({ url: 'https://down.example.com/mcp' }, { fetch: refused })).toMatchObject({ ok: false, problem: 'unreachable' })
  })
})

describe('profile editor route handler and client', () => {
  const github = createGitHubSourceService(reader())
  const mcp = { check: vi.fn(async () => ({ ok: true as const, tools: [], latencyMs: 1, checkedAt: 'now' })) }
  const handle = (request: Request) => handleProfileEditorRequest(request, new URL(request.url).pathname.replace('/api/editor/', ''), { github, mcp })

  it('answers each route and refuses bad input', async () => {
    const latest = await handle(new Request('https://app.test/api/editor/github/latest?repository=acme/skills'))
    expect(await latest.json()).toMatchObject({ ok: true, value: { commit: { sha: SHA } } })
    expect((await handle(new Request('https://app.test/api/editor/github/latest'))).status).toBe(400)
    expect((await handle(new Request('https://app.test/api/editor/github/check'))).status).toBe(405)
    expect((await handle(new Request('https://app.test/api/editor/github/unknown'))).status).toBe(404)
    const checked = await handle(new Request('https://app.test/api/editor/github/check', { method: 'POST',
      body: JSON.stringify({ repository: 'acme/skills', path: 'README.md', commit: SHA, purpose: 'skill' }) }))
    expect(await checked.json()).toMatchObject({ ok: false, problem: 'not-a-skill' })
    const files = await handle(new Request(`https://app.test/api/editor/github/files?repository=acme/skills&commit=nope`))
    expect(await files.json()).toMatchObject({ ok: false, problem: 'ref-not-found' })
    const mcpCheck = await handle(new Request('https://app.test/api/editor/mcp/check', { method: 'POST', body: JSON.stringify({ server: { url: 'https://x.example.com/mcp' } }) }))
    expect(await mcpCheck.json()).toMatchObject({ ok: true })
    expect(mcp.check).toHaveBeenCalledWith({ url: 'https://x.example.com/mcp' }, expect.anything())
    const none = await handleProfileEditorRequest(new Request('https://app.test/x/github/repositories'), 'github/repositories', { github: null, mcp: null })
    expect(await none.json()).toMatchObject({ ok: false, problem: 'unavailable' })
  })

  it('carries the unsaved canonical candidate through the public client and derives its identity on the server', async () => {
    const server = { transport: 'http', url: 'https://reports.example.com/mcp',
      headers: { Authorization: { kind: 'secret-ref', key: 'reporting-api', format: 'bearer' } } } as const
    const profile: AgentProfile = { name: 'Unsaved role', harness: 'opencode', mcp: { reports: server }, proxySecrets: [{
      envName: 'REPORTS_TOKEN', secretRef: { kind: 'secret-ref', key: 'reporting-api' },
      hosts: ['reports.example.com'], presentation: { type: 'bearer' }, paths: ['/mcp'], ttlSeconds: 300,
    }] }
    let checked: ProfileEditorMcpCheckContext | undefined
    const client = createProfileEditorClient({ endpoint: 'https://app.test/editor',
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => handleProfileEditorRequest(
        new Request(String(input), init), 'mcp/check', { github: null, mcp: {
          check: async (_server, _signal, candidate) => {
            checked = candidate
            return { ok: true, tools: [], latencyMs: 1, checkedAt: 'now' }
          },
        } },
      )) as typeof globalThis.fetch,
    })
    expect(await client.mcp.check(server, undefined, { profile, serverName: 'reports' })).toMatchObject({ ok: true })
    expect(checked).toEqual({ profile: snapshotAgentProfile(profile), serverName: 'reports',
      profileDigest: canonicalAgentProfileDigest(profile) })
    expect(checked!.profile.proxySecrets).toEqual(profile.proxySecrets)
  })

  it('refuses malformed candidates, substituted servers and client-supplied trusted digests before invoking the port', async () => {
    const server = { url: 'https://reports.example.com/mcp',
      headers: { Authorization: { kind: 'secret-ref', key: 'reporting-api' } } }
    const profile = { name: 'Unsaved role', mcp: { reports: server } }
    const check = vi.fn(async () => ({ ok: true as const, tools: [], latencyMs: 1, checkedAt: 'now' }))
    for (const candidate of [
      { profile, serverName: 'missing' },
      { profile: { ...profile, mcp: { reports: { ...server, url: 'https://other.example.com/mcp' } } }, serverName: 'reports' },
      { profile: { ...profile, mcp: { reports: { ...server, headers: { Authorization: { kind: 'secret-ref', key: '' } } } } }, serverName: 'reports' },
      { profile, serverName: 'reports', profileDigest: `sha256:${'a'.repeat(64)}` },
    ]) {
      const response = await handleProfileEditorRequest(new Request('https://app.test/editor/mcp/check', {
        method: 'POST', body: JSON.stringify({ server, candidate }),
      }), 'mcp/check', { github: null, mcp: { check } })
      expect(response.status).toBe(400)
    }
    expect(check).not.toHaveBeenCalled()
  })

  it('returns typed outcomes from the client even when the route fails', async () => {
    const client = createProfileEditorClient({ endpoint: 'https://app.test/api/editor/', fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
      handle(new Request(String(input), init))) as typeof globalThis.fetch })
    expect(await client.github.check({ repository: 'acme/skills', path: 'skills/research/SKILL.md', commit: SHA, purpose: 'skill' }))
      .toMatchObject({ ok: true, value: { skill: { name: 'research' } } })
    const forbidden = createProfileEditorClient({ endpoint: '/x', fetch: (async () => Response.json({ error: 'Admins only' }, { status: 403 })) as typeof globalThis.fetch })
    expect(await forbidden.github.repositories()).toEqual({ ok: false, problem: 'unavailable', message: 'Admins only' })
    const offline = createProfileEditorClient({ endpoint: '/x', fetch: (async () => { throw new TypeError('offline') }) as typeof globalThis.fetch })
    expect(await offline.mcp.check({ url: 'https://x.example.com/mcp' })).toMatchObject({ ok: false, problem: 'unavailable' })
  })
})
