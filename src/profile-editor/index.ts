/**
 * Shared contract between the profile editor and the product server that
 * checks what an edit points at: GitHub skill and file sources, and MCP
 * servers. The editor never talks to GitHub or an MCP server itself; the
 * product authenticates the request, picks the credential, and answers through
 * `./profile-editor/server`. This module is browser-safe: types, the wire
 * format, and a fetch client for the product's route.
 */
import type { AgentProfileMcpServer } from '@tangle-network/agent-interface/profile'
import { parseSkillFrontmatter } from '../skills/frontmatter'

/** Why a GitHub source cannot be used. Each one renders its own message and next step. */
export type GitHubSourceProblem =
  /** The workspace has no usable GitHub connection. */
  | 'not-connected'
  /** GitHub answered 404 for the repository: it does not exist, or this connection cannot see it. */
  | 'repository-not-found'
  /** GitHub refused the connection (401/403), for example an expired token or SSO enforcement. */
  | 'no-access'
  /** The commit or branch does not exist in the repository. */
  | 'ref-not-found'
  /** No file exists at the path in the chosen commit. */
  | 'path-not-found'
  /** The path names a folder without a skill file in it. */
  | 'not-a-file'
  /** The file is not an Agent Skill: it lacks `name` and `description` frontmatter. */
  | 'not-a-skill'
  /** The file is larger than the product accepts, or is not UTF-8 text. */
  | 'unsupported-file'
  | 'rate-limited'
  /** GitHub or the product's connection service did not answer, or the operation is not offered. */
  | 'unavailable'

export interface GitHubSourceFailure {
  ok: false
  problem: GitHubSourceProblem
  /** User-facing explanation with the next step. */
  message: string
}

export type GitHubSourceOutcome<T> = { ok: true; value: T } | GitHubSourceFailure

export interface GitHubRepositorySummary {
  /** `owner/repo`. */
  fullName: string
  private: boolean
  defaultBranch: string
  description?: string
}

export interface GitHubCommitSummary {
  /** Full 40-character commit SHA. */
  sha: string
  /** The branch the commit was resolved from, when it was resolved from one. */
  branch?: string
  committedAt?: string
  message?: string
}

export interface GitHubFileEntry {
  path: string
  size?: number
}

export interface GitHubFileList {
  commit: GitHubCommitSummary
  files: GitHubFileEntry[]
  /** GitHub truncated the listing; paths not listed can still be typed. */
  truncated: boolean
}

export type GitHubSourcePurpose = 'skill' | 'file'

export interface GitHubSourceRequest {
  repository: string
  path: string
  /** Full commit SHA the source is pinned to. */
  commit: string
  purpose: GitHubSourcePurpose
}

export interface GitHubSourceCheck {
  repository: string
  /** The checked path. A skill folder resolves to its `SKILL.md`. */
  path: string
  commit: GitHubCommitSummary
  size: number
  /** The file's UTF-8 text, for products that store sources inline. */
  content: string
  /** Frontmatter of a skill file. */
  skill?: { name: string; description: string }
}

/** GitHub lookups the editor needs, answered by the product with the workspace's connection. */
export interface ProfileEditorGitHubPort {
  /** Repositories the connection can read, most recently updated first. */
  repositories(signal?: AbortSignal): Promise<GitHubSourceOutcome<{ repositories: GitHubRepositorySummary[] }>>
  /** The repository and the head commit of its default branch. */
  latest(repository: string, signal?: AbortSignal): Promise<GitHubSourceOutcome<{ repository: GitHubRepositorySummary; commit: GitHubCommitSummary }>>
  /** Confirm a commit SHA exists in the repository. */
  commit(repository: string, sha: string, signal?: AbortSignal): Promise<GitHubSourceOutcome<GitHubCommitSummary>>
  /** Files in the repository at a commit, for path suggestions. */
  files(repository: string, commit: string, signal?: AbortSignal): Promise<GitHubSourceOutcome<GitHubFileList>>
  /** Read and validate the source the editor is about to add. */
  check(request: GitHubSourceRequest, signal?: AbortSignal): Promise<GitHubSourceOutcome<GitHubSourceCheck>>
}

/** Why an MCP server check failed. */
export type McpHealthProblem =
  /** The URL is malformed or uses a scheme the product does not accept. */
  | 'invalid-url'
  /** The product does not connect to this address, for example a private network or plain HTTP. */
  | 'blocked-url'
  /** This product checks remote servers only; a local command is checked when the agent starts it. */
  | 'not-checkable'
  | 'unreachable'
  | 'timeout'
  /** The server asked for credentials the check does not send. */
  | 'auth-required'
  /** The server answered, but not with the MCP protocol. */
  | 'protocol-error'
  | 'unavailable'

export interface McpTool {
  name: string
  description?: string
}

export type McpHealth =
  | { ok: true; tools: McpTool[]; serverName?: string; serverVersion?: string; latencyMs: number; checkedAt: string }
  | { ok: false; problem: McpHealthProblem; message: string; status?: number; checkedAt: string }

/** Connects to an MCP server and lists its tools. The product decides which addresses it will reach. */
export interface ProfileEditorMcpPort {
  check(server: AgentProfileMcpServer, signal?: AbortSignal): Promise<McpHealth>
}

/** The product route's subpaths, relative to the endpoint passed to {@link createProfileEditorClient}. */
export const PROFILE_EDITOR_ROUTES = {
  repositories: 'github/repositories',
  latest: 'github/latest',
  commit: 'github/commit',
  files: 'github/files',
  check: 'github/check',
  mcpCheck: 'mcp/check',
} as const

export interface ProfileEditorClient {
  github: ProfileEditorGitHubPort
  mcp: ProfileEditorMcpPort
}

export interface ProfileEditorClientOptions {
  /** The product route that serves `./profile-editor/server`, for example `/api/workspaces/w1/profile-editor`. */
  endpoint: string
  fetch?: typeof fetch
}

function unavailable(message: string): GitHubSourceFailure {
  return { ok: false, problem: 'unavailable', message }
}

/** Ports backed by the product route. A transport failure becomes an `unavailable` outcome, never a throw. */
export function createProfileEditorClient({ endpoint, fetch: fetchImpl }: ProfileEditorClientOptions): ProfileEditorClient {
  const base = endpoint.replace(/\/+$/, '')
  const send = fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init))

  async function call<T>(path: string, init: RequestInit & { query?: Record<string, string> }, failure: (message: string) => T): Promise<T> {
    const query = init.query ? '?' + new URLSearchParams(init.query).toString() : ''
    try {
      const response = await send(`${base}/${path}${query}`, {
        method: init.method ?? 'GET', signal: init.signal, credentials: 'same-origin',
        headers: init.body ? { 'Content-Type': 'application/json' } : undefined, body: init.body,
      })
      const body = await response.json().catch(() => null) as T | { error?: string } | null
      if (response.ok && body && typeof body === 'object' && 'ok' in body) return body as T
      const detail = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : ''
      if (response.status === 401 || response.status === 403) return failure(detail || 'You do not have access to check sources for this workspace.')
      return failure(detail || `The source check could not complete (HTTP ${response.status}).`)
    } catch (cause) {
      if (init.signal?.aborted) throw cause
      return failure('The source check could not reach the server. Check your connection and try again.')
    }
  }

  const github: ProfileEditorGitHubPort = {
    repositories: signal => call(PROFILE_EDITOR_ROUTES.repositories, { signal }, unavailable),
    latest: (repository, signal) => call(PROFILE_EDITOR_ROUTES.latest, { signal, query: { repository } }, unavailable),
    commit: (repository, sha, signal) => call(PROFILE_EDITOR_ROUTES.commit, { signal, query: { repository, sha } }, unavailable),
    files: (repository, commit, signal) => call(PROFILE_EDITOR_ROUTES.files, { signal, query: { repository, commit } }, unavailable),
    check: (request, signal) => call(PROFILE_EDITOR_ROUTES.check, { signal, method: 'POST', body: JSON.stringify(request) }, unavailable),
  }
  const mcp: ProfileEditorMcpPort = {
    check: (server, signal) => call(PROFILE_EDITOR_ROUTES.mcpCheck, { signal, method: 'POST', body: JSON.stringify({ server }) },
      (message): McpHealth => ({ ok: false, problem: 'unavailable', message, checkedAt: new Date().toISOString() })),
  }
  return { github, mcp }
}

const REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/

/**
 * Normalize what a person types or pastes into `owner/repo`: a bare name pair,
 * a `github.com` URL (including `/tree/` and `/blob/` links), or an SSH remote.
 * Returns the path and commit-ish a link carries too, so pasting a file link
 * fills every field. Null when the text names no repository.
 */
export function parseGitHubLocation(input: string): { repository: string; ref?: string; path?: string } | null {
  let text = input.trim()
  if (!text) return null
  const ssh = /^git@github\.com:(.+?)(?:\.git)?$/i.exec(text)
  if (ssh) text = ssh[1]!
  else if (/^(https?:\/\/)?(www\.)?github\.com\//i.test(text)) {
    try {
      const url = new URL(/^https?:/i.test(text) ? text : 'https://' + text)
      text = url.pathname.replace(/^\/+/, '').replace(/\.git$/, '')
    } catch { return null }
  }
  const [owner, repo, kind, ref, ...rest] = text.split('/').filter(Boolean)
  if (!owner || !repo || !REPOSITORY_SEGMENT.test(owner) || !REPOSITORY_SEGMENT.test(repo) || owner === '.' || owner === '..' || repo === '.' || repo === '..') return null
  const repository = `${owner}/${repo.replace(/\.git$/, '')}`
  if ((kind === 'tree' || kind === 'blob') && ref) return { repository, ref, ...(rest.length ? { path: rest.join('/') } : {}) }
  return kind ? null : { repository }
}

export function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value)
}

/**
 * The address policy for products that connect only to public HTTPS servers:
 * no credentials in the URL, no IP literals, and no single-label, `.local` or
 * `.internal` hosts. Returns the reason an address is refused, or null.
 */
export function publicHttpsUrlProblem(value: string): string | null {
  let url: URL
  try { url = new URL(value) } catch { return 'Enter a full URL, such as https://example.com/mcp.' }
  if (url.protocol !== 'https:') return 'Use a public HTTPS address that starts with https://.'
  if (url.username || url.password) return 'Remove the credentials from the URL. Use a secret reference in a header instead.'
  if (url.search || url.hash) return 'Remove the query and fragment from the URL. Send credentials as a secret reference in a header.'
  const host = url.hostname.toLowerCase()
  if (!host.includes('.') || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[') || host.endsWith('.local') ||
    host.endsWith('.internal') || host.endsWith('.localhost') || host === 'localhost') {
    return 'Use a public address. Private, local, and IP addresses are not reachable from here.'
  }
  return null
}

/** Frontmatter `name` and `description` of an Agent Skill, or the reason the text is not one. */
export function readSkillFrontmatter(content: string): { ok: true; name: string; description: string } | { ok: false; message: string } {
  let parsed: ReturnType<typeof parseSkillFrontmatter>
  try { parsed = parseSkillFrontmatter(content.replace(/\r\n/g, '\n')) } catch {
    return { ok: false, message: 'The file has malformed frontmatter. A skill starts with a --- block that sets name and description.' }
  }
  const name = parsed.frontmatter.name?.trim()
  const description = parsed.frontmatter.description?.trim()
  if (!name || !description) {
    return { ok: false, message: 'This file is not a skill. A skill file starts with frontmatter that sets name and description.' }
  }
  return { ok: true, name, description }
}
