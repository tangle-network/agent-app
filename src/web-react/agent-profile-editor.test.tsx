// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentProfile } from '@tangle-network/agent-interface/profile'
import type { GitHubSourceOutcome, McpHealth, ProfileEditorGitHubPort, ProfileEditorMcpPort } from '../profile-editor'
import { AgentProfileEditor, type AgentProfileEditorConfig, type AgentProfileEditorProps, type AgentProfileEditorSaveState } from './agent-profile-editor'
import type { CatalogModel } from '../runtime/model-catalog'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const skill = '---\nname: research\ndescription: Research from primary sources.\n---\n\n# Research\n'

const models: CatalogModel[] = [
  { id: 'openai/gpt-6.1-sol', name: 'GPT 6.1 Sol', provider: 'openai', supportsTools: true, supportsReasoning: true, featured: true },
  { id: 'zai/glm-5.3', name: 'GLM 5.3', provider: 'zai', supportsTools: true, supportsReasoning: true, featured: true },
]

function github(overrides: Partial<ProfileEditorGitHubPort> = {}): ProfileEditorGitHubPort {
  const fail = <T,>(problem: Extract<GitHubSourceOutcome<T>, { ok: false }>['problem'], message: string): GitHubSourceOutcome<T> => ({ ok: false, problem, message })
  return {
    repositories: async () => ({ ok: true, value: { repositories: [{ fullName: 'acme/skills', private: true, defaultBranch: 'main' }] } }),
    latest: async repository => repository === 'acme/skills'
      ? { ok: true, value: { repository: { fullName: 'acme/skills', private: true, defaultBranch: 'main' }, commit: { sha: SHA, branch: 'main', message: 'Update' } } }
      : repository === 'acme/locked' ? fail('no-access', 'Your GitHub connection is not allowed to read acme/locked.')
      : fail('repository-not-found', `No repository named ${repository} is visible to your GitHub connection.`),
    commit: async (_repository, sha) => ({ ok: true, value: { sha } }),
    files: async (_repository, sha) => ({ ok: true, value: { commit: { sha }, truncated: false,
      files: [{ path: 'README.md' }, { path: 'skills/research/SKILL.md' }] } }),
    check: async ({ path, purpose }) => path === 'skills/research/SKILL.md'
      ? { ok: true, value: { repository: 'acme/skills', path, commit: { sha: SHA }, size: skill.length, content: skill,
        skill: { name: 'research', description: 'Research from primary sources.' } } }
      : path === 'README.md' && purpose === 'skill' ? fail('not-a-skill', 'This file is not a skill.')
      : fail('path-not-found', `${path} is not in acme/skills at this commit.`),
    ...overrides,
  }
}

const mcp: ProfileEditorMcpPort = {
  check: vi.fn(async (server): Promise<McpHealth> => {
    const url = 'url' in server ? server.url ?? '' : ''
    return url.includes('auth.')
      ? { ok: false, problem: 'auth-required', message: 'The server needs credentials.', status: 401, checkedAt: 'now' }
      : { ok: true, tools: [{ name: 'search' }, { name: 'fetch' }], latencyMs: 5, checkedAt: 'now' }
  }),
}

function Harness({ initial, onState, ...props }: { initial: AgentProfile; onState?: (state: AgentProfileEditorSaveState) => void } & Partial<AgentProfileEditorProps>) {
  const [profile, setProfile] = useState(initial)
  return <>
    <AgentProfileEditor value={profile} onChange={setProfile} onSaveStateChange={onState} {...props} />
    <output data-testid="profile">{JSON.stringify(profile)}</output>
  </>
}

const current = () => JSON.parse(screen.getByTestId('profile').textContent ?? '{}') as AgentProfile

const config = (overrides: Partial<AgentProfileEditorConfig> = {}): AgentProfileEditorConfig => ({
  models: { models, defaultLabel: 'Product default' },
  harnesses: ['opencode', 'codex'],
  github: { port: github(), storage: 'inline', connectHref: '/integrations' },
  mcp: { port: mcp },
  files: { accept: ['.md', '.txt', '.json'], maxFileBytes: 1024 },
  ...overrides,
})

function openSection(title: string) {
  const summary = screen.getByText(title, { selector: 'span' }).closest('summary')
  if (summary && !summary.parentElement?.hasAttribute('open')) fireEvent.click(summary)
  return within(summary!.parentElement as HTMLElement)
}

describe('AgentProfileEditor model and runtime', () => {
  it('uses the composer model picker for model fields, with a default option', async () => {
    render(<Harness initial={{ model: { default: 'openai/gpt-6.1-sol' } }} config={config()} />)
    expect(screen.queryByRole('textbox', { name: 'Default model' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Default model' }))
    const dialog = await screen.findByRole('dialog', { name: 'Choose a model' })
    fireEvent.click(within(dialog).getByRole('button', { name: /GLM 5\.3/ }))
    await waitFor(() => expect(current().model?.default).toBe('zai/glm-5.3'))
    fireEvent.click(screen.getByRole('button', { name: 'Default model' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Choose a model' })).getByRole('button', { name: 'Product default' }))
    await waitFor(() => expect(current().model).toBeUndefined())
  })

  it('offers only the product harnesses and keeps the default model runnable on the chosen one', async () => {
    render(<Harness initial={{ model: { default: 'zai/glm-5.3' } }} config={config()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Harness' }))
    const options = (await screen.findAllByRole('menuitemradio')).map(item => item.textContent)
    expect(options).toEqual(['Product default', 'OpenCode (any model)', 'Codex (OpenAI)'])
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Codex/ }))
    await waitFor(() => expect(current().harness).toBe('codex'))
    expect(current().model?.default).toBe('openai/gpt-6.1-sol')
    expect(screen.getByText(/Default model changed to GPT 6\.1 Sol/)).toBeTruthy()
  })

  it('uses the composer thinking picker and stores Auto as no override', async () => {
    render(<Harness initial={{ harness: 'codex', model: { default: 'openai/gpt-6.1-sol', reasoningEffort: 'medium' } }} config={config()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Extended/ }))
    await waitFor(() => expect(current().model?.reasoningEffort).toBe('high'))
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Auto/ }))
    await waitFor(() => expect(current().model?.reasoningEffort).toBeUndefined())
  })

  it('keeps plain fields without a catalog and never labels fields with schema paths', () => {
    render(<Harness initial={{ prompt: { systemPrompt: 'Be brief.' } }} />)
    expect(screen.getByRole('textbox', { name: 'Default model' }).getAttribute('data-1p-ignore')).toBe('true')
    expect(document.body.textContent).not.toMatch(/prompt\.(systemPrompt|appendSystemPrompt|instructions)/)
    expect(document.body.textContent).not.toMatch(/GitHub files are fetched when the profile runs/)
  })
})

describe('AgentProfileEditor MCP servers', () => {
  const servers: AgentProfile['mcp'] = {
    research: { transport: 'http', url: 'https://mcp.example.com/research' },
    crm: { transport: 'http', url: 'https://auth.example.com/mcp' },
    transcripts: { enabled: false, metadata: { description: 'Transcript ingest.' } },
  }

  it('checks each enabled server automatically and shows its state', async () => {
    render(<Harness initial={{ mcp: servers }} config={config()} publicHttpsMcpOnly />)
    expect(await screen.findByText('Connected · 2 tools')).toBeTruthy()
    expect(await screen.findByText('Needs credentials')).toBeTruthy()
    expect(screen.getByText('Tools: search, fetch')).toBeTruthy()
    expect(within(screen.getByLabelText('MCP server transcripts')).getByText('Off')).toBeTruthy()
  })

  it('turns a server off and back on without losing its address', async () => {
    render(<Harness initial={{ mcp: servers }} config={config()} publicHttpsMcpOnly />)
    fireEvent.click(screen.getByRole('switch', { name: 'Turn off research' }))
    await waitFor(() => expect(current().mcp?.research).toEqual({ enabled: false,
      metadata: { enabledConfig: { transport: 'http', url: 'https://mcp.example.com/research' } } }))
    fireEvent.click(screen.getByRole('switch', { name: 'Turn on research' }))
    await waitFor(() => expect(current().mcp?.research).toEqual({ transport: 'http', url: 'https://mcp.example.com/research' }))
  })

  it('asks for an address before turning on a server that has none, and validates it live', async () => {
    render(<Harness initial={{ mcp: servers }} config={config()} publicHttpsMcpOnly />)
    fireEvent.click(screen.getByRole('switch', { name: 'Turn on transcripts' }))
    expect(screen.getByText('Add the server address to turn it on.')).toBeTruthy()
    const row = within(screen.getByLabelText('MCP server transcripts'))
    fireEvent.change(row.getByLabelText('URL'), { target: { value: 'http://localhost:9000/mcp' } })
    expect(row.getByText(/public HTTPS/)).toBeTruthy()
    expect((row.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(row.getByLabelText('URL'), { target: { value: 'https://transcripts.example.com/mcp' } })
    fireEvent.click(row.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(current().mcp?.transcripts).toEqual({ transport: 'http', url: 'https://transcripts.example.com/mcp',
      metadata: { description: 'Transcript ingest.' } }))
  })

  it('locks toggles and edits when the product says the person cannot change servers', () => {
    render(<Harness initial={{ mcp: servers }} config={config({ mcp: { port: mcp, lockReason: 'Only workspace admins can change MCP servers.' } })} />)
    expect((screen.getByRole('switch', { name: 'Turn off research' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Add server' })).toBeNull()
    expect(screen.getByText('Only workspace admins can change MCP servers.')).toBeTruthy()
  })
})

describe('AgentProfileEditor resource files', () => {
  it('adds dropped text files inline under the product folder and refuses the rest with reasons', async () => {
    render(<Harness initial={{}} config={config()} filePathPrefix="profile-trials/" allowExecutableFiles={false} />)
    openSection('Resource files')
    const zone = screen.getByText('Drop files here').closest('div.border-dashed') ?? screen.getByText('Drop files here').parentElement!.parentElement!
    const files = [
      new File(['# Pricing notes\n'], 'pricing notes.md', { type: 'text/markdown' }),
      new File([new Uint8Array(2048).fill(65)], 'big.txt', { type: 'text/plain' }),
      new File([new Uint8Array([137, 80, 78, 71])], 'logo.png', { type: 'image/png' }),
    ]
    const dataTransfer = new DataTransfer()
    for (const file of files) dataTransfer.items.add(file)
    await act(async () => { fireEvent.drop(zone, { dataTransfer }) })
    await waitFor(() => expect(current().resources?.files).toEqual([
      { path: 'profile-trials/pricing-notes.md', resource: { kind: 'inline', name: 'pricing-notes.md', content: '# Pricing notes\n' } },
    ]))
    expect(screen.getByText('This file is 2 KB. Files can be up to 1 KB.')).toBeTruthy()
    expect(screen.getByText('Only MD, TXT or JSON files can be added.')).toBeTruthy()
  })
})

describe('AgentProfileEditor GitHub sources', () => {
  async function chooseRepository(name: string) {
    const input = screen.getByRole('combobox', { name: 'Repository' })
    fireEvent.change(input, { target: { value: name } })
    fireEvent.keyDown(input, { key: 'Enter' })
  }

  it('explains a missing repository, missing access, and a file that is not a skill, then adds the checked skill', async () => {
    render(<Harness initial={{}} config={config()} requireUniqueSkillNames />)
    fireEvent.click(openSection('Skills').getByRole('button', { name: 'Add from GitHub' }))
    await chooseRepository('acme/missing')
    expect(await screen.findByText(/No repository named acme\/missing is visible/)).toBeTruthy()
    await chooseRepository('acme/locked')
    expect(await screen.findByText(/not allowed to read acme\/locked/)).toBeTruthy()
    await chooseRepository('https://github.com/acme/skills')
    expect(await screen.findByText(/Private · default branch main/)).toBeTruthy()
    const path = screen.getByRole('combobox', { name: 'Skill file' })
    await waitFor(() => expect((path as HTMLInputElement).disabled).toBe(false))
    fireEvent.change(path, { target: { value: 'README.md' } })
    fireEvent.keyDown(path, { key: 'Enter' })
    expect(await screen.findByText('This file is not a skill.')).toBeTruthy()
    fireEvent.change(path, { target: { value: 'skills/missing/SKILL.md' } })
    fireEvent.keyDown(path, { key: 'Enter' })
    expect(await screen.findByText(/skills\/missing\/SKILL\.md is not in acme\/skills/)).toBeTruthy()
    fireEvent.change(path, { target: { value: 'skills/research/SKILL.md' } })
    fireEvent.keyDown(path, { key: 'Enter' })
    expect(await screen.findByText(/Research from primary sources\./)).toBeTruthy()
    expect((screen.getByLabelText('Skill name') as HTMLInputElement).value).toBe('research')
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }))
    await waitFor(() => expect(current().resources?.skills).toEqual([{ kind: 'inline', name: 'research', content: skill }]))
  })

  it('stores a reference pinned to the checked commit when the product fetches GitHub at run time', async () => {
    render(<Harness initial={{}} config={config({ github: { port: github(), storage: 'reference' } })} requireGitHubCommitSha />)
    fireEvent.click(openSection('Skills').getByRole('button', { name: 'Add from GitHub' }))
    await chooseRepository('acme/skills')
    const path = screen.getByRole('combobox', { name: 'Skill file' })
    await waitFor(() => expect((path as HTMLInputElement).disabled).toBe(false))
    fireEvent.change(path, { target: { value: 'skills/research/SKILL.md' } })
    fireEvent.keyDown(path, { key: 'Enter' })
    await screen.findByText(/Research from primary sources\./)
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }))
    await waitFor(() => expect(current().resources?.skills).toEqual([
      { kind: 'github', repository: 'acme/skills', path: 'skills/research/SKILL.md', ref: SHA, name: 'research' },
    ]))
  })

  it('offers to connect GitHub when the workspace has no connection', async () => {
    const port = github({ repositories: async () => ({ ok: false, problem: 'not-connected', message: 'Connect GitHub to this workspace to use its repositories.' }) })
    render(<Harness initial={{}} config={config({ github: { port, storage: 'inline', connectHref: '/integrations' } })} />)
    fireEvent.click(openSection('Skills').getByRole('button', { name: 'Add from GitHub' }))
    expect((await screen.findByRole('link', { name: 'Connect GitHub' })).getAttribute('href')).toBe('/integrations')
  })

  it('holds the host save while a source is being added', async () => {
    const onState = vi.fn()
    render(<Harness initial={{}} config={config()} onState={onState} />)
    fireEvent.click(openSection('Skills').getByRole('button', { name: 'Write a skill' }))
    await waitFor(() => expect(onState).toHaveBeenLastCalledWith({ pending: true, invalid: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(onState).toHaveBeenLastCalledWith({ pending: false, invalid: false }))
  })
})
