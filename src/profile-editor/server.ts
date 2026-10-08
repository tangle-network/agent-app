/**
 * Server side of the profile editor's source checks. The product route
 * authenticates the caller, authorizes the workspace, and supplies the
 * transport: a {@link GitHubSourceReader} bound to the workspace's GitHub
 * connection and the address policy for MCP checks. Everything here is
 * fetch-based and runs in Workers and Node.
 */
import { z } from 'zod'
import type { AgentProfileConfigValue, AgentProfileMcpServer } from '@tangle-network/agent-interface/profile'
import {
  isCommitSha, PROFILE_EDITOR_ROUTES, publicHttpsUrlProblem, readSkillFrontmatter,
  type GitHubCommitSummary, type GitHubFileList, type GitHubRepositorySummary, type GitHubSourceCheck,
  type GitHubSourceFailure, type GitHubSourceOutcome, type GitHubSourceProblem, type GitHubSourceRequest,
  type McpHealth, type McpTool, type ProfileEditorGitHubPort, type ProfileEditorMcpPort,
} from './index'

export * from './index'

// ── GitHub ──────────────────────────────────────────────────────────────────

/**
 * A GitHub read failure. `status` is the HTTP status GitHub returned, or
 * `not-connected` when the workspace has no usable connection, or
 * `unsupported` when the transport cannot perform the operation.
 */
export class GitHubReadError extends Error {
  constructor(readonly status: number | 'not-connected' | 'unsupported', message: string, readonly rateLimited = false) {
    super(message)
    this.name = 'GitHubReadError'
  }
}

export interface GitHubRepositoryRecord {
  fullName: string
  private: boolean
  defaultBranch: string
  description?: string | null
}

export interface GitHubCommitRecord {
  sha: string
  treeSha: string
  committedAt?: string
  message?: string
}

export interface GitHubTreeRecord {
  entries: { path: string; type: 'blob' | 'tree' | 'commit'; sha: string; size?: number }[]
  truncated: boolean
}

/**
 * The GitHub operations the source service needs. Implementations throw
 * {@link GitHubReadError} for GitHub refusals so the service can explain them.
 */
export interface GitHubSourceReader {
  /** Repositories the credential can read, most recently pushed first. Omit when the transport cannot list them. */
  listRepositories?(signal?: AbortSignal): Promise<GitHubRepositoryRecord[]>
  getRepository(owner: string, repo: string, signal?: AbortSignal): Promise<GitHubRepositoryRecord>
  getBranchHead(owner: string, repo: string, branch: string, signal?: AbortSignal): Promise<GitHubCommitRecord>
  /** Resolve a full commit SHA, throwing a 404 or 422 when it is absent. */
  getCommit(owner: string, repo: string, sha: string, signal?: AbortSignal): Promise<GitHubCommitRecord>
  /** The recursive tree of a commit or tree SHA. */
  getTree(owner: string, repo: string, sha: string, signal?: AbortSignal): Promise<GitHubTreeRecord>
  /** A blob's bytes. */
  getBlob(owner: string, repo: string, sha: string, signal?: AbortSignal): Promise<Uint8Array>
}

export interface GitHubRestReaderOptions {
  /** A token for the person or installation. Without one, only public repositories resolve and listing is unavailable. */
  token?: string
  fetch?: typeof fetch
  baseUrl?: string
  timeoutMs?: number
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Parse GitHub REST payloads shared by the REST reader and other transports that relay GitHub's JSON. */
export const githubPayload = {
  repository(value: unknown): GitHubRepositoryRecord {
    const body = z.object({ full_name: z.string(), private: z.boolean(), default_branch: z.string(), description: z.string().nullish() }).parse(value)
    return { fullName: body.full_name, private: body.private, defaultBranch: body.default_branch, description: body.description }
  },
  repositories(value: unknown): GitHubRepositoryRecord[] {
    return z.array(z.unknown()).parse(value).map(item => githubPayload.repository(item))
  },
  branch(value: unknown): GitHubCommitRecord {
    const body = z.object({ commit: z.object({ sha: z.string(), commit: z.object({
      tree: z.object({ sha: z.string() }), message: z.string().optional(),
      committer: z.object({ date: z.string().optional() }).nullish(),
    }) }) }).parse(value)
    return { sha: body.commit.sha, treeSha: body.commit.commit.tree.sha, committedAt: body.commit.commit.committer?.date,
      message: body.commit.commit.message }
  },
  commit(value: unknown): GitHubCommitRecord {
    const body = z.object({ sha: z.string(), commit: z.object({
      tree: z.object({ sha: z.string() }), message: z.string().optional(),
      committer: z.object({ date: z.string().optional() }).nullish(),
    }) }).parse(value)
    return { sha: body.sha, treeSha: body.commit.tree.sha, committedAt: body.commit.committer?.date, message: body.commit.message }
  },
  tree(value: unknown): GitHubTreeRecord {
    const body = z.object({ truncated: z.boolean().optional(), tree: z.array(z.object({
      path: z.string(), type: z.enum(['blob', 'tree', 'commit']), sha: z.string(), size: z.number().optional(),
    })) }).parse(value)
    return { entries: body.tree, truncated: body.truncated === true }
  },
  blob(value: unknown): Uint8Array {
    const body = z.object({ content: z.string(), encoding: z.string() }).parse(value)
    if (body.encoding === 'base64') return decodeBase64(body.content)
    if (body.encoding === 'utf-8') return new TextEncoder().encode(body.content)
    throw new GitHubReadError(415, `GitHub returned the file in an unsupported encoding (${body.encoding}).`)
  },
}

/** A reader over GitHub's REST API with a person or installation token. */
export function createGitHubRestReader(options: GitHubRestReaderOptions = {}): GitHubSourceReader {
  const base = (options.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '')
  const send = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init))
  const segment = encodeURIComponent
  async function get(path: string, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000)
    const response = await send(base + path, {
      redirect: 'follow',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: {
        Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'tangle-agent-app',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
    })
    if (!response.ok) {
      const rateLimited = response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
      const detail = await response.json().then(body => (body as { message?: string }).message ?? '').catch(() => '')
      throw new GitHubReadError(response.status, detail || `GitHub answered HTTP ${response.status}`, rateLimited)
    }
    return response.json()
  }
  return {
    ...(options.token ? { listRepositories: async (signal?: AbortSignal) =>
      githubPayload.repositories(await get('/user/repos?per_page=100&sort=pushed', signal)) } : {}),
    getRepository: async (owner, repo, signal) => githubPayload.repository(await get(`/repos/${segment(owner)}/${segment(repo)}`, signal)),
    getBranchHead: async (owner, repo, branch, signal) =>
      githubPayload.branch(await get(`/repos/${segment(owner)}/${segment(repo)}/branches/${branch.split('/').map(segment).join('/')}`, signal)),
    getCommit: async (owner, repo, sha, signal) => githubPayload.commit(await get(`/repos/${segment(owner)}/${segment(repo)}/commits/${segment(sha)}`, signal)),
    getTree: async (owner, repo, sha, signal) => githubPayload.tree(await get(`/repos/${segment(owner)}/${segment(repo)}/git/trees/${segment(sha)}?recursive=1`, signal)),
    getBlob: async (owner, repo, sha, signal) => githubPayload.blob(await get(`/repos/${segment(owner)}/${segment(repo)}/git/blobs/${segment(sha)}`, signal)),
  }
}

export interface GitHubSourceServiceOptions {
  /** Largest file the product stores or fetches, in bytes. Defaults to 256 KiB. */
  maxFileBytes?: number
  /** Most paths returned for suggestions. Defaults to 5,000. */
  maxFiles?: number
}

const fail = (problem: GitHubSourceProblem, message: string): GitHubSourceFailure => ({ ok: false, problem, message })

function splitRepository(repository: string): [string, string] | null {
  const [owner, repo, ...rest] = repository.split('/')
  if (!owner || !repo || rest.length || !/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) return null
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null
  return [owner, repo]
}

function normalizedRepositoryPath(path: string): string | null {
  const trimmed = path.trim().replace(/^\.\/+/, '').replace(/\/+$/, '')
  if (!trimmed || trimmed.length > 400 || trimmed.startsWith('/') || trimmed.includes('\\') || /[\u0000-\u001f\u007f]/.test(trimmed)) return null
  return trimmed.split('/').every(part => part && part !== '.' && part !== '..') ? trimmed : null
}

function summary(record: GitHubRepositoryRecord): GitHubRepositorySummary {
  return { fullName: record.fullName, private: record.private, defaultBranch: record.defaultBranch,
    ...(record.description ? { description: record.description } : {}) }
}

function commitSummary(record: GitHubCommitRecord, branch?: string): GitHubCommitSummary {
  return { sha: record.sha, ...(branch ? { branch } : {}), ...(record.committedAt ? { committedAt: record.committedAt } : {}),
    ...(record.message ? { message: record.message.split('\n')[0] } : {}) }
}

/** Explain a reader failure in the context of the step that failed. */
function readFailure(error: unknown, step: 'list' | 'repository' | 'commit' | 'file', repository = ''): GitHubSourceFailure {
  if (!(error instanceof GitHubReadError)) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    return fail('unavailable', timedOut ? 'GitHub did not answer in time. Try again.' : 'GitHub could not be reached. Try again.')
  }
  if (error.status === 'not-connected') return fail('not-connected', 'Connect GitHub to this workspace to use its repositories.')
  if (error.status === 'unsupported') {
    return fail('unavailable', step === 'list'
      ? 'Repository search is not available for this GitHub connection. Type owner/repo instead.'
      : 'This GitHub connection cannot read repository contents.')
  }
  if (error.rateLimited || error.status === 429) return fail('rate-limited', 'GitHub is rate limiting this connection. Try again in a minute.')
  if (error.status === 401) return fail('no-access', 'GitHub rejected this connection. Reconnect GitHub and try again.')
  if (error.status === 403) {
    return fail('no-access', repository
      ? `Your GitHub connection is not allowed to read ${repository}. Grant it access, or authorize it for the organization's SSO.`
      : 'GitHub refused this connection. Reconnect GitHub and try again.')
  }
  if (error.status === 404 && step === 'repository') {
    return fail('repository-not-found', `No repository named ${repository} is visible to your GitHub connection. Check the name, or give the connection access to it.`)
  }
  if ((error.status === 404 || error.status === 422) && step === 'commit') return fail('ref-not-found', `That commit is not in ${repository}.`)
  if (error.status === 409) return fail('ref-not-found', `${repository} has no commits yet.`)
  if (error.status === 404 && step === 'file') return fail('path-not-found', 'That file is not in the selected commit.')
  return fail('unavailable', `GitHub could not complete the request (HTTP ${error.status}). Try again.`)
}

/** Decode UTF-8 text, or null for binary content. */
function utf8(bytes: Uint8Array): string | null {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return null }
}

/**
 * The editor's GitHub port, computed from a reader. Lookups are typed
 * outcomes; nothing here throws for a GitHub refusal.
 */
export function createGitHubSourceService(reader: GitHubSourceReader, options: GitHubSourceServiceOptions = {}): ProfileEditorGitHubPort {
  const maxFileBytes = options.maxFileBytes ?? 256 * 1024
  const maxFiles = options.maxFiles ?? 5_000
  const invalidRepository = fail('repository-not-found', 'Enter a repository as owner/repo.')

  async function resolveCommit(owner: string, repo: string, sha: string, signal?: AbortSignal): Promise<GitHubSourceOutcome<GitHubCommitRecord>> {
    if (!isCommitSha(sha)) return fail('ref-not-found', 'Enter the full 40-character commit SHA.')
    try { return { ok: true, value: await reader.getCommit(owner, repo, sha.toLowerCase(), signal) } } catch (error) {
      if (error instanceof GitHubReadError && error.status === 404) {
        // A 404 on the commit can also mean the repository itself is missing.
        try { await reader.getRepository(owner, repo, signal) } catch (repositoryError) {
          return readFailure(repositoryError, 'repository', `${owner}/${repo}`)
        }
      }
      return readFailure(error, 'commit', `${owner}/${repo}`)
    }
  }

  async function tree(owner: string, repo: string, record: GitHubCommitRecord, signal?: AbortSignal): Promise<GitHubSourceOutcome<GitHubTreeRecord>> {
    try { return { ok: true, value: await reader.getTree(owner, repo, record.treeSha, signal) } } catch (error) {
      return readFailure(error, 'commit', `${owner}/${repo}`)
    }
  }

  return {
    async repositories(signal) {
      if (!reader.listRepositories) return readFailure(new GitHubReadError('unsupported', 'listing unsupported'), 'list')
      try {
        const repositories = await reader.listRepositories(signal)
        return { ok: true, value: { repositories: repositories.map(summary) } }
      } catch (error) { return readFailure(error, 'list') }
    },

    async latest(repository, signal) {
      const parts = splitRepository(repository)
      if (!parts) return invalidRepository
      let record: GitHubRepositoryRecord
      try { record = await reader.getRepository(parts[0], parts[1], signal) } catch (error) {
        return readFailure(error, 'repository', repository)
      }
      try {
        const head = await reader.getBranchHead(parts[0], parts[1], record.defaultBranch, signal)
        return { ok: true, value: { repository: summary(record), commit: commitSummary(head, record.defaultBranch) } }
      } catch (error) { return readFailure(error, 'commit', repository) }
    },

    async commit(repository, sha, signal) {
      const parts = splitRepository(repository)
      if (!parts) return invalidRepository
      const resolved = await resolveCommit(parts[0], parts[1], sha, signal)
      return resolved.ok ? { ok: true, value: commitSummary(resolved.value) } : resolved
    },

    async files(repository, commit, signal): Promise<GitHubSourceOutcome<GitHubFileList>> {
      const parts = splitRepository(repository)
      if (!parts) return invalidRepository
      const resolved = await resolveCommit(parts[0], parts[1], commit, signal)
      if (!resolved.ok) return resolved
      const listing = await tree(parts[0], parts[1], resolved.value, signal)
      if (!listing.ok) return listing
      const blobs = listing.value.entries.filter(entry => entry.type === 'blob')
      return { ok: true, value: {
        commit: commitSummary(resolved.value),
        files: blobs.slice(0, maxFiles).map(entry => ({ path: entry.path, ...(entry.size === undefined ? {} : { size: entry.size }) })),
        truncated: listing.value.truncated || blobs.length > maxFiles,
      } }
    },

    async check(request: GitHubSourceRequest, signal): Promise<GitHubSourceOutcome<GitHubSourceCheck>> {
      const parts = splitRepository(request.repository)
      if (!parts) return invalidRepository
      const path = normalizedRepositoryPath(request.path)
      if (!path) return fail('path-not-found', 'Enter a path inside the repository, such as skills/research/SKILL.md.')
      const resolved = await resolveCommit(parts[0], parts[1], request.commit, signal)
      if (!resolved.ok) return resolved
      const listing = await tree(parts[0], parts[1], resolved.value, signal)
      if (!listing.ok) return listing
      const entries = new Map(listing.value.entries.map(entry => [entry.path, entry]))
      let entry = entries.get(path)
      let checkedPath = path
      if (entry?.type === 'tree') {
        const skillFile = request.purpose === 'skill' ? entries.get(`${path}/SKILL.md`) : undefined
        if (!skillFile) {
          return fail('not-a-file', request.purpose === 'skill'
            ? `${path} is a folder without a SKILL.md file. Choose the skill's SKILL.md.`
            : `${path} is a folder. Choose a file inside it.`)
        }
        entry = skillFile
        checkedPath = `${path}/SKILL.md`
      }
      if (!entry || entry.type !== 'blob') {
        return fail('path-not-found', listing.value.truncated
          ? `${path} was not found. This repository is too large to list completely; check the path.`
          : `${path} is not in ${request.repository} at this commit.`)
      }
      if (entry.size !== undefined && entry.size > maxFileBytes) {
        return fail('unsupported-file', `${checkedPath} is ${formatBytes(entry.size)}. Files can be up to ${formatBytes(maxFileBytes)}.`)
      }
      let bytes: Uint8Array
      try { bytes = await reader.getBlob(parts[0], parts[1], entry.sha, signal) } catch (error) {
        return readFailure(error, 'file', request.repository)
      }
      if (bytes.byteLength > maxFileBytes) {
        return fail('unsupported-file', `${checkedPath} is ${formatBytes(bytes.byteLength)}. Files can be up to ${formatBytes(maxFileBytes)}.`)
      }
      const content = utf8(bytes)
      if (content === null) return fail('unsupported-file', `${checkedPath} is not a text file.`)
      const check: GitHubSourceCheck = { repository: request.repository, path: checkedPath,
        commit: commitSummary(resolved.value), size: bytes.byteLength, content }
      if (request.purpose === 'skill') {
        const skill = readSkillFrontmatter(content)
        if (!skill.ok) return fail('not-a-skill', skill.message)
        check.skill = { name: skill.name, description: skill.description }
      }
      return { ok: true, value: check }
    },
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ── MCP health ──────────────────────────────────────────────────────────────

export interface McpHealthCheckOptions {
  fetch?: typeof fetch
  /** Total time for the whole check. Defaults to 8 seconds. */
  timeoutMs?: number
  /** The address policy. Return the reason an address is refused, or null. Defaults to {@link publicHttpsUrlProblem}. */
  urlProblem?: (url: string) => string | null
  clientInfo?: { name: string; version: string }
}

const MCP_PROTOCOL_VERSION = '2025-06-18'
const MAX_MCP_BODY_BYTES = 2 * 1024 * 1024

interface JsonRpcResponse { id?: unknown; result?: unknown; error?: { code?: number; message?: string } }

class McpCheckFailure extends Error {
  constructor(readonly problem: Exclude<McpHealth, { ok: true }>['problem'], message: string, readonly status?: number) { super(message) }
}

function publicHeaders(server: AgentProfileMcpServer): Record<string, string> {
  if (!('headers' in server) || !server.headers) return {}
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(server.headers as Record<string, AgentProfileConfigValue>)) {
    if (value && typeof value === 'object' && value.kind === 'public' && typeof value.value === 'string') headers[name] = value.value
  }
  return headers
}

/** Read Server-Sent Events from a stream, yielding each complete event. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let total = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > MAX_MCP_BODY_BYTES) throw new McpCheckFailure('protocol-error', 'The server sent more data than a tool listing needs.')
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        let event = 'message'
        const data: string[] = []
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        }
        if (data.length) yield { event, data: data.join('\n') }
        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length > MAX_MCP_BODY_BYTES) throw new McpCheckFailure('protocol-error', 'The server sent more data than a tool listing needs.')
  try { return JSON.parse(text) } catch { throw new McpCheckFailure('protocol-error', 'The server did not answer with MCP JSON-RPC.') }
}

function rpcResult(message: unknown, id: number): unknown {
  const items = Array.isArray(message) ? message : [message]
  const match = items.find((item): item is JsonRpcResponse => !!item && typeof item === 'object' && (item as JsonRpcResponse).id === id)
  if (!match) throw new McpCheckFailure('protocol-error', 'The server did not answer the MCP request.')
  if (match.error) throw new McpCheckFailure('protocol-error', `The server returned an MCP error: ${match.error.message ?? match.error.code ?? 'unknown'}.`)
  return match.result
}

/**
 * Fetch without following redirects. Cloudflare Workers accept only `follow`
 * and `manual`, so a redirect is refused here instead: a server that moves the
 * endpoint is asked for its final URL rather than followed to an address the
 * policy never checked.
 */
async function sendManual(send: Send, url: string, init: RequestInit): Promise<Response> {
  const response = await send(url, { ...init, redirect: 'manual' })
  if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
    await response.body?.cancel()
    throw new McpCheckFailure('protocol-error', 'The server redirected to another address. Enter the final MCP URL.', response.status || undefined)
  }
  return response
}

function statusFailure(status: number): McpCheckFailure {
  if (status === 401 || status === 403) {
    return new McpCheckFailure('auth-required', 'The server needs credentials. Add them as secret references in Advanced JSON.', status)
  }
  if (status === 404 || status === 405) return new McpCheckFailure('protocol-error', `No MCP endpoint answered at this URL (HTTP ${status}).`, status)
  return new McpCheckFailure('unreachable', `The server answered HTTP ${status}.`, status)
}

const toolsSchema = z.object({ tools: z.array(z.object({ name: z.string(), description: z.string().optional() }).passthrough()),
  nextCursor: z.string().optional() })
const initializeSchema = z.object({ serverInfo: z.object({ name: z.string().optional(), version: z.string().optional() }).passthrough().optional() }).passthrough()

/**
 * Connect to a remote MCP server, initialize a session, and list its tools.
 * Speaks Streamable HTTP, and the HTTP+SSE transport when the server declares
 * `transport: 'sse'`. Public header values are sent; secret references are not
 * resolved here, so a server that requires them reports `auth-required`.
 */
export async function checkMcpServer(server: AgentProfileMcpServer, options: McpHealthCheckOptions = {}): Promise<McpHealth> {
  const checkedAt = new Date().toISOString()
  const started = Date.now()
  const failed = (failure: McpCheckFailure): McpHealth => ({ ok: false, problem: failure.problem, message: failure.message,
    ...(failure.status === undefined ? {} : { status: failure.status }), checkedAt })
  if (server.enabled === false) return failed(new McpCheckFailure('not-checkable', 'Enable the server to check it.'))
  if ('command' in server && server.command) {
    return failed(new McpCheckFailure('not-checkable', 'Local servers start inside the agent workspace, so they are checked when the agent runs.'))
  }
  const url = 'url' in server ? server.url : undefined
  if (!url) return failed(new McpCheckFailure('invalid-url', 'Add the server URL.'))
  const urlProblem = (options.urlProblem ?? publicHttpsUrlProblem)(url)
  if (urlProblem) {
    let parsed = true
    try { new URL(url) } catch { parsed = false }
    return failed(new McpCheckFailure(parsed ? 'blocked-url' : 'invalid-url', urlProblem))
  }
  const send = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000)
  const clientInfo = options.clientInfo ?? { name: 'tangle-agent-app', version: '1' }
  const headers = publicHeaders(server)
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo } }
  const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' }
  try {
    const result = 'transport' in server && server.transport === 'sse'
      ? await checkSse(url, headers, send, controller.signal, initialize, initialized)
      : await checkStreamableHttp(url, headers, send, controller.signal, initialize, initialized)
    return { ok: true, ...result, latencyMs: Date.now() - started, checkedAt }
  } catch (error) {
    if (error instanceof McpCheckFailure) return failed(error)
    if (controller.signal.aborted) return failed(new McpCheckFailure('timeout', 'The server did not answer within 8 seconds.'))
    return failed(new McpCheckFailure('unreachable', 'Could not connect to the server. Check the URL and that the server is running.'))
  } finally {
    clearTimeout(timer)
  }
}

type Send = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
interface McpListing { tools: McpTool[]; serverName?: string; serverVersion?: string }

function listing(info: unknown, pages: unknown[]): McpListing {
  const parsedInfo = initializeSchema.safeParse(info)
  const tools = pages.flatMap(page => {
    const parsed = toolsSchema.safeParse(page)
    if (!parsed.success) throw new McpCheckFailure('protocol-error', 'The server returned a tool list MCP clients cannot read.')
    return parsed.data.tools.map(tool => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}) }))
  })
  const serverInfo = parsedInfo.success ? parsedInfo.data.serverInfo : undefined
  return { tools, ...(serverInfo?.name ? { serverName: serverInfo.name } : {}), ...(serverInfo?.version ? { serverVersion: serverInfo.version } : {}) }
}

async function checkStreamableHttp(url: string, headers: Record<string, string>, send: Send, signal: AbortSignal,
  initialize: object, initialized: object): Promise<McpListing> {
  let session: string | null = null
  let protocol: string | null = null
  async function post(message: object, id?: number): Promise<unknown> {
    const response = await sendManual(send, url, { method: 'POST', signal, body: JSON.stringify(message), headers: {
      ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(session ? { 'Mcp-Session-Id': session } : {}), ...(protocol ? { 'MCP-Protocol-Version': protocol } : {}),
    } })
    if (id === undefined) { await response.body?.cancel(); if (!response.ok && response.status !== 202) throw statusFailure(response.status); return undefined }
    if (!response.ok) { await response.body?.cancel(); throw statusFailure(response.status) }
    session = response.headers.get('mcp-session-id') ?? session
    const type = response.headers.get('content-type') ?? ''
    if (type.includes('text/event-stream')) {
      if (!response.body) throw new McpCheckFailure('protocol-error', 'The server opened an empty event stream.')
      for await (const event of sseEvents(response.body)) {
        if (event.event !== 'message') continue
        let parsed: unknown
        try { parsed = JSON.parse(event.data) } catch { continue }
        const items = Array.isArray(parsed) ? parsed : [parsed]
        if (items.some(item => item && typeof item === 'object' && (item as JsonRpcResponse).id === id)) return rpcResult(parsed, id)
      }
      throw new McpCheckFailure('protocol-error', 'The server closed the stream before answering.')
    }
    if (!type.includes('json')) {
      await response.body?.cancel()
      throw new McpCheckFailure('protocol-error', 'The server did not answer with MCP JSON-RPC.')
    }
    return rpcResult(await readJson(response), id)
  }
  const info = await post(initialize, 1)
  const negotiated = initializeSchema.safeParse(info)
  protocol = negotiated.success && typeof (negotiated.data as { protocolVersion?: unknown }).protocolVersion === 'string'
    ? (negotiated.data as { protocolVersion: string }).protocolVersion : MCP_PROTOCOL_VERSION
  await post(initialized)
  const pages: unknown[] = []
  let cursor: string | undefined
  for (let page = 0; page < 5; page++) {
    const result = await post({ jsonrpc: '2.0', id: 2 + page, method: 'tools/list', params: cursor ? { cursor } : {} }, 2 + page)
    pages.push(result)
    const next = toolsSchema.safeParse(result)
    cursor = next.success ? next.data.nextCursor : undefined
    if (!cursor) break
  }
  if (session) {
    await send(url, { method: 'DELETE', signal, headers: { ...headers, 'Mcp-Session-Id': session } })
      .then(response => response.body?.cancel()).catch(() => undefined)
  }
  return listing(info, pages)
}

async function checkSse(url: string, headers: Record<string, string>, send: Send, signal: AbortSignal,
  initialize: object, initialized: object): Promise<McpListing> {
  const stream = await sendManual(send, url, { method: 'GET', signal, headers: { ...headers, Accept: 'text/event-stream' } })
  if (!stream.ok) { await stream.body?.cancel(); throw statusFailure(stream.status) }
  if (!stream.body || !(stream.headers.get('content-type') ?? '').includes('text/event-stream')) {
    await stream.body?.cancel()
    throw new McpCheckFailure('protocol-error', 'The server did not open an MCP event stream.')
  }
  const events = sseEvents(stream.body)
  try {
    const first = await events.next()
    if (first.done || first.value.event !== 'endpoint') throw new McpCheckFailure('protocol-error', 'The server did not announce an MCP message endpoint.')
    // The endpoint carries the session in its query, so only its origin is held to the checked address.
    const endpoint = new URL(first.value.data.trim(), url)
    if (endpoint.origin !== new URL(url).origin) {
      throw new McpCheckFailure('protocol-error', 'The server announced a message endpoint on another address.')
    }
    async function post(message: object) {
      const response = await sendManual(send, endpoint.href, { method: 'POST', signal, body: JSON.stringify(message),
        headers: { ...headers, 'Content-Type': 'application/json' } })
      await response.body?.cancel()
      if (!response.ok) throw statusFailure(response.status)
    }
    async function answer(id: number): Promise<unknown> {
      for (;;) {
        const next = await events.next()
        if (next.done) throw new McpCheckFailure('protocol-error', 'The server closed the stream before answering.')
        if (next.value.event !== 'message') continue
        let parsed: unknown
        try { parsed = JSON.parse(next.value.data) } catch { continue }
        if (parsed && typeof parsed === 'object' && (parsed as JsonRpcResponse).id === id) return rpcResult(parsed, id)
      }
    }
    await post(initialize)
    const info = await answer(1)
    await post(initialized)
    await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    return listing(info, [await answer(2)])
  } finally {
    await events.return(undefined)
  }
}

/** The editor's MCP port, running checks in this process with the given address policy. */
export function createMcpHealthChecker(options: McpHealthCheckOptions = {}): ProfileEditorMcpPort {
  return { check: (server, signal) => {
    if (signal?.aborted) return Promise.resolve({ ok: false, problem: 'unavailable', message: 'The check was cancelled.', checkedAt: new Date().toISOString() })
    return checkMcpServer(server, options)
  } }
}

// ── Route handler ───────────────────────────────────────────────────────────

export interface ProfileEditorHandlerOptions {
  /** GitHub lookups for this workspace. Null when the product offers no GitHub sources. */
  github: ProfileEditorGitHubPort | null
  /** MCP checks. Null when the product offers no MCP servers. */
  mcp: ProfileEditorMcpPort | null
}

const repositoryParam = z.string().trim().min(3).max(201)
const shaParam = z.string().trim().regex(/^[0-9a-f]{40}$/i)
const checkBody = z.object({ repository: repositoryParam, path: z.string().min(1).max(400), commit: shaParam,
  purpose: z.enum(['skill', 'file']) }).strict()
const mcpBody = z.object({ server: z.object({
  enabled: z.boolean().optional(),
  transport: z.enum(['http', 'sse', 'stdio']).optional(),
  url: z.string().max(2048).optional(),
  command: z.string().max(2048).optional(),
  headers: z.record(z.string(), z.unknown()).optional(),
}).passthrough() }).strict()

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

const MAX_BODY_BYTES = 64 * 1024

async function readBody(request: Request): Promise<unknown> {
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) throw new Error('Request body is too large')
  return JSON.parse(text) as unknown
}

/**
 * Serve the editor's checks. Call it after authenticating the user and
 * authorizing the workspace, with the path below the editor endpoint
 * (for example `github/files`). Unknown paths answer 404.
 */
export async function handleProfileEditorRequest(request: Request, path: string, options: ProfileEditorHandlerOptions): Promise<Response> {
  const route = path.replace(/^\/+|\/+$/g, '')
  const query = new URL(request.url).searchParams
  const githubRoute = (Object.entries(PROFILE_EDITOR_ROUTES) as [keyof typeof PROFILE_EDITOR_ROUTES, string][])
    .find(([, value]) => value === route)?.[0]
  if (!githubRoute) return json({ error: 'Not found' }, 404)
  const expectsPost = githubRoute === 'check' || githubRoute === 'mcpCheck'
  if (request.method !== (expectsPost ? 'POST' : 'GET')) return json({ error: 'Method not allowed' }, 405)
  const signal = request.signal

  if (githubRoute === 'mcpCheck') {
    if (!options.mcp) return json({ ok: false, problem: 'unavailable', message: 'This product does not check MCP servers.', checkedAt: new Date().toISOString() })
    let body: z.infer<typeof mcpBody>
    try { body = mcpBody.parse(await readBody(request)) } catch { return json({ error: 'Send { server } with the MCP server to check.' }, 400) }
    return json(await options.mcp.check(body.server as unknown as AgentProfileMcpServer, signal))
  }
  if (!options.github) return json(fail('unavailable', 'This product does not offer GitHub sources.'))
  const github = options.github
  switch (githubRoute) {
    case 'repositories': return json(await github.repositories(signal))
    case 'latest': {
      const repository = repositoryParam.safeParse(query.get('repository'))
      if (!repository.success) return json({ error: 'repository is required' }, 400)
      return json(await github.latest(repository.data, signal))
    }
    case 'commit':
    case 'files': {
      const repository = repositoryParam.safeParse(query.get('repository'))
      const sha = shaParam.safeParse(query.get(githubRoute === 'commit' ? 'sha' : 'commit'))
      if (!repository.success) return json({ error: 'repository is required' }, 400)
      if (!sha.success) return json(fail('ref-not-found', 'Enter the full 40-character commit SHA.'))
      return json(githubRoute === 'commit' ? await github.commit(repository.data, sha.data, signal) : await github.files(repository.data, sha.data, signal))
    }
    case 'check': {
      let body: z.infer<typeof checkBody>
      try { body = checkBody.parse(await readBody(request)) } catch { return json({ error: 'Send repository, path, a 40-character commit, and purpose.' }, 400) }
      return json(await github.check(body, signal))
    }
  }
}
