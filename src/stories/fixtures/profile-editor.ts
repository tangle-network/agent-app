/**
 * Synthetic ports for the profile editor stories and browser checks. They
 * answer like a product route would, including each GitHub and MCP failure
 * the editor must explain. No network access.
 */
import type { AgentProfile } from '@tangle-network/agent-interface/profile'
import type {
  GitHubCommitSummary, GitHubSourceOutcome, McpHealth, ProfileEditorGitHubPort, ProfileEditorMcpPort,
} from '../../profile-editor'
import type { CatalogModel } from '../../web-react'

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
})

export const profileEditorModels: CatalogModel[] = [
  { id: 'openai/gpt-6.1-sol', name: 'GPT 6.1 Sol', provider: 'openai', contextLength: 400_000, pricing: { prompt: '0.000004', completion: '0.000016' }, supportsTools: true, supportsReasoning: true, featured: true },
  { id: 'openai/gpt-6-astra', name: 'GPT 6 Astra', provider: 'openai', contextLength: 400_000, pricing: { prompt: '0.0000015', completion: '0.000006' }, supportsTools: true, supportsReasoning: true, featured: true },
  { id: 'google/gemini-3.7-flash', name: 'Gemini 3.7 Flash', provider: 'google', contextLength: 1_000_000, pricing: { prompt: '0.0000003', completion: '0.0000025' }, supportsTools: true, supportsReasoning: true, featured: true },
  { id: 'zai/glm-5.3', name: 'GLM 5.3', provider: 'zai', contextLength: 200_000, pricing: { prompt: '0.0000006', completion: '0.0000022' }, supportsTools: true, supportsReasoning: true, featured: true },
  { id: 'moonshotai/kimi-k3', name: 'Kimi K3', provider: 'moonshotai', contextLength: 256_000, supportsTools: true, supportsReasoning: true, featured: false },
  { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', provider: 'deepseek', contextLength: 128_000, supportsTools: true, supportsReasoning: false, featured: false },
]

const head = (sha: string, message: string, daysAgo: number): GitHubCommitSummary =>
  ({ sha, branch: 'main', message, committedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString() })

const repositories = [
  { fullName: 'tangle-network/agent-skills', private: false, defaultBranch: 'main', description: 'Shared Agent Skills' },
  { fullName: 'acme/gtm-playbooks', private: true, defaultBranch: 'main', description: 'Positioning and outreach playbooks' },
  { fullName: 'acme/sales-ops', private: true, defaultBranch: 'main' },
]

const commits: Record<string, GitHubCommitSummary> = {
  'tangle-network/agent-skills': head('4f2c9d1e8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d', 'Tighten the research skill', 2),
  'acme/gtm-playbooks': head('9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b', 'Add competitor teardown skill', 0),
  'acme/sales-ops': head('1111111111111111111111111111111111111111', 'Initial import', 40),
}

const files: Record<string, string[]> = {
  'tangle-network/agent-skills': ['README.md', 'skills/research/SKILL.md', 'skills/research/sources.md', 'skills/outreach/SKILL.md', 'skills/pricing/SKILL.md', 'docs/writing-skills.md'],
  'acme/gtm-playbooks': ['README.md', 'skills/competitor-teardown/SKILL.md', 'playbooks/positioning.md', 'playbooks/outbound.md'],
  'acme/sales-ops': ['README.md'],
}

const skillBody = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nUse primary sources and cite every claim.\n`

const fail = <T>(problem: Extract<GitHubSourceOutcome<T>, { ok: false }>['problem'], message: string): GitHubSourceOutcome<T> => ({ ok: false, problem, message })

/** GitHub answers for three repositories, plus `acme/locked` (no access) and anything else (not found). */
export function profileEditorGitHubPort({ connected = true }: { connected?: boolean } = {}): ProfileEditorGitHubPort {
  const missing = (repository: string) => repository === 'acme/locked'
    ? fail<never>('no-access', 'Your GitHub connection is not allowed to read acme/locked. Grant it access, or authorize it for the organization\'s SSO.')
    : fail<never>('repository-not-found', `No repository named ${repository} is visible to your GitHub connection. Check the name, or give the connection access to it.`)
  const notConnected = fail<never>('not-connected', 'Connect GitHub to this workspace to use its repositories.')
  return {
    async repositories(signal) {
      await wait(250, signal)
      return connected ? { ok: true, value: { repositories } } : notConnected
    },
    async latest(repository, signal) {
      await wait(300, signal)
      if (!connected) return notConnected
      const found = repositories.find(item => item.fullName === repository)
      return found ? { ok: true, value: { repository: found, commit: commits[repository]! } } : missing(repository)
    },
    async commit(repository, sha, signal) {
      await wait(250, signal)
      if (!repositories.some(item => item.fullName === repository)) return missing(repository)
      return sha === commits[repository]?.sha || sha.startsWith('abc')
        ? { ok: true, value: { sha, message: 'Pinned commit', committedAt: new Date(Date.now() - 9 * 86_400_000).toISOString() } }
        : fail('ref-not-found', `That commit is not in ${repository}.`)
    },
    async files(repository, sha, signal) {
      await wait(200, signal)
      return { ok: true, value: { commit: { sha }, files: (files[repository] ?? []).map(path => ({ path, size: 2048 })), truncated: false } }
    },
    async check({ repository, path, commit, purpose }, signal) {
      await wait(350, signal)
      const listed = files[repository] ?? []
      const resolved = listed.includes(path) ? path : listed.includes(`${path}/SKILL.md`) ? `${path}/SKILL.md` : null
      if (!resolved) return fail('path-not-found', `${path} is not in ${repository} at this commit.`)
      const isSkill = /SKILL\.md$/.test(resolved)
      if (purpose === 'skill' && !isSkill) return fail('not-a-skill', 'This file is not a skill. A skill file starts with frontmatter that sets name and description.')
      const name = resolved.split('/').slice(-2, -1)[0] ?? 'skill'
      const content = isSkill ? skillBody(name, `Run the ${name.replace(/-/g, ' ')} play with cited sources.`) : `# ${resolved}\n\nReference notes.\n`
      return { ok: true, value: { repository, path: resolved, commit: { sha: commit }, size: content.length, content,
        ...(isSkill ? { skill: { name, description: `Run the ${name.replace(/-/g, ' ')} play with cited sources.` } } : {}) } }
    },
  }
}

/** MCP checks: `auth.` hosts need credentials, `down.` hosts are unreachable, `slow.` hosts time out; others list tools. */
export function profileEditorMcpPort(): ProfileEditorMcpPort {
  return {
    async check(server, signal) {
      await wait(600, signal)
      const checkedAt = new Date().toISOString()
      const url = 'url' in server && server.url ? server.url : ''
      let host = ''
      try { host = new URL(url).hostname } catch { return { ok: false, problem: 'invalid-url', message: 'Enter a full URL, such as https://example.com/mcp.', checkedAt } }
      if (host.startsWith('auth.')) return { ok: false, problem: 'auth-required', message: 'The server needs credentials. Add them as secret references in Advanced JSON.', status: 401, checkedAt }
      if (host.startsWith('down.')) return { ok: false, problem: 'unreachable', message: 'Could not connect to the server. Check the URL and that the server is running.', checkedAt }
      if (host.startsWith('slow.')) return { ok: false, problem: 'timeout', message: 'The server did not answer within 8 seconds.', checkedAt }
      const tools = host.startsWith('docs.')
        ? ['search_docs', 'read_page', 'list_sections']
        : ['search', 'fetch', 'summarize', 'extract_entities', 'compare_sources', 'cite']
      return { ok: true, tools: tools.map(name => ({ name })), serverName: host, latencyMs: 412, checkedAt } satisfies McpHealth
    },
  }
}

/** A configured go-to-market profile: inline skills, several MCP states, and reference files. */
export const productProfile: AgentProfile = {
  name: 'GTM Agent',
  description: 'Researches markets and drafts go-to-market work for review.',
  prompt: {
    systemPrompt: 'You are the go-to-market operator for this workspace. Research before you recommend, cite every claim, and keep drafts in the vault for review. Never send or publish without approval.',
    instructions: ['Check the positioning file before drafting copy.'],
  },
  model: { default: 'openai/gpt-6.1-sol', reasoningEffort: 'medium' },
  harness: 'opencode',
  resources: {
    skills: [
      { kind: 'inline', name: 'copywriting', content: skillBody('copywriting', 'Write channel copy that names the buyer and the proof.') },
      { kind: 'inline', name: 'conversion-critique', content: skillBody('conversion-critique', 'Critique a landing page against the conversion checklist.') },
      { kind: 'inline', name: 'self-scheduling', content: '# Self-scheduling\n\nPlan your own follow-up work.' },
    ],
    files: [
      { path: 'profile-trials/positioning.md', resource: { kind: 'inline', name: 'positioning.md', content: '# Positioning\n\nFor platform teams that ship agents.' } },
    ],
  },
  mcp: {
    'web-research': { transport: 'http', url: 'https://mcp.example.com/research' },
    'crm-notes': { transport: 'http', url: 'https://auth.example.com/mcp' },
    'docs-search': { enabled: false, metadata: { enabledConfig: { transport: 'http', url: 'https://docs.example.com/mcp' } } },
    'sales-transcripts': { enabled: false, metadata: { description: 'Sales-call transcript ingest for ICP validation.' } },
  },
}
