// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentProfile } from '@tangle-network/agent-interface/profile'
import { AgentProfileEditor, type AgentProfileEditorProps } from './agent-profile-editor'
import { AgentProfileRegistryError, type AgentProfileRegistryPort } from './agent-profile-registry'

const pinned = '0123456789abcdef0123456789abcdef01234567'

const registry: AgentProfileRegistryPort = {
  async searchSkills(query) {
    if (query === 'empty') return { skills: [] }
    return {
      skills: [{
        name: 'booking-guide',
        description: 'Answer booking questions from declared references.',
        catalog: 'Tangle Network skills',
        permissions: ['files.read'],
        ref: { kind: 'github', repository: 'tangle-network/skills', path: 'plugins/booking/skills/booking-guide/SKILL.md', ref: pinned, name: 'booking-guide' },
      }, {
        name: 'unpinned-skill',
        description: 'A skill without a pinned commit.',
        catalog: 'Tangle Network skills',
        ref: { kind: 'github', repository: 'tangle-network/skills', path: 'plugins/x/skills/unpinned-skill/SKILL.md', name: 'unpinned-skill' },
      }],
      unavailable: query === 'partial' ? ['Experimental catalog'] : undefined,
    }
  },
  async searchMcpServers(query) {
    if (query === 'empty') return { mcpServers: [] }
    return {
      mcpServers: [{
        name: 'filesystem',
        description: 'Read and write local files.',
        catalog: 'Official MCP Registry',
        server: { transport: 'http', url: 'https://mcp.example.com/filesystem' },
      }, {
        name: 'insecure',
        description: 'An HTTP-only server.',
        catalog: 'Official MCP Registry',
        server: { transport: 'http', url: 'http://mcp.example.com/insecure' },
      }],
    }
  },
}

function Harness({ initial = {}, registry: port, ...constraints }: { initial?: AgentProfile; registry?: AgentProfileRegistryPort } & Partial<AgentProfileEditorProps>) {
  const [profile, setProfile] = useState<AgentProfile>(initial)
  return <>
    <AgentProfileEditor value={profile} onChange={setProfile} registry={port} {...constraints} />
    <output data-testid="profile">{JSON.stringify(profile)}</output>
  </>
}

function openDisclosure(title: string) {
  const summary = screen.getByText(title).closest('summary')
  if (summary && !summary.parentElement?.hasAttribute('open')) fireEvent.click(summary)
}

function search(label: string, query: string) {
  const input = screen.getByLabelText(label)
  fireEvent.change(input, { target: { value: query } })
  const button = input.parentElement?.querySelector('button')
  if (!button) throw new Error('Search button missing')
  fireEvent.click(button)
}

describe('AgentProfileEditor registry discovery', () => {
  it('hides catalog search when no registry port is supplied', () => {
    render(<Harness />)
    openDisclosure('Skills')
    expect(screen.queryByLabelText('Search skill catalogs')).toBeNull()
    openDisclosure('MCP servers')
    expect(screen.queryByLabelText('Search MCP registries')).toBeNull()
  })

  it('searches skill catalogs and shows source, purpose, and declared permissions before adding', async () => {
    render(<Harness registry={registry} requireUniqueSkillNames />)
    openDisclosure('Skills')
    search('Search skill catalogs', 'booking')
    const result = await screen.findByLabelText('Catalog skill booking-guide')
    expect(result.textContent).toContain('Tangle Network skills')
    expect(result.textContent).toContain('Answer booking questions from declared references.')
    expect(result.textContent).toContain('Requests: files.read')
    expect(result.textContent).toContain('tangle-network/skills')
    expect(result.textContent).toContain(pinned)
  })

  it('adds a discovered skill to the canonical profile only when the operator chooses it', async () => {
    render(<Harness registry={registry} requireUniqueSkillNames />)
    openDisclosure('Skills')
    expect(screen.getByTestId('profile').textContent).not.toContain('booking-guide')
    search('Search skill catalogs', 'booking')
    fireEvent.click(await screen.findByRole('button', { name: 'Add skill booking-guide' }))
    await waitFor(() => expect(screen.getByTestId('profile').textContent).toContain('booking-guide'))
    const profile = JSON.parse(screen.getByTestId('profile').textContent ?? '{}') as AgentProfile
    expect(profile.resources?.skills).toEqual([
      { kind: 'github', repository: 'tangle-network/skills', path: 'plugins/booking/skills/booking-guide/SKILL.md', ref: pinned, name: 'booking-guide' },
    ])
    expect((screen.getByRole('button', { name: 'Add skill booking-guide' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps unpinned catalog skills out of products that require a commit SHA', async () => {
    render(<Harness registry={registry} requireGitHubCommitSha requireUniqueSkillNames />)
    openDisclosure('Skills')
    search('Search skill catalogs', 'booking')
    const result = await screen.findByLabelText('Catalog skill unpinned-skill')
    expect(result.textContent).toContain('40-character GitHub commit SHA')
    expect((screen.getByRole('button', { name: 'Add skill unpinned-skill' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('reports catalogs that could not answer while keeping the remaining results usable', async () => {
    render(<Harness registry={registry} requireUniqueSkillNames />)
    openDisclosure('Skills')
    search('Search skill catalogs', 'partial')
    await screen.findByLabelText('Catalog skill booking-guide')
    expect(screen.getByText(/Some catalogs could not answer: Experimental catalog/)).toBeTruthy()
  })

  it('shows an empty result instead of fabricating matches', async () => {
    render(<Harness registry={registry} requireUniqueSkillNames />)
    openDisclosure('Skills')
    search('Search skill catalogs', 'empty')
    expect(await screen.findByText('No skills matched that search.')).toBeTruthy()
    expect(screen.getByTestId('profile').textContent).not.toContain('skills')
  })

  it('renders authorization-required and failure states from the port', async () => {
    const denied: AgentProfileRegistryPort = {
      searchSkills: async () => { throw new AgentProfileRegistryError('authorization-required', 'Sign in again') },
      searchMcpServers: async () => { throw new AgentProfileRegistryError('failed', 'Registry timed out') },
    }
    render(<Harness registry={denied} />)
    openDisclosure('Skills')
    search('Search skill catalogs', 'booking')
    expect((await screen.findByRole('alert')).textContent).toContain('Registry search needs authorization')
    openDisclosure('MCP servers')
    search('Search MCP registries', 'filesystem')
    await waitFor(() => expect(screen.getAllByRole('alert').some(item => item.textContent?.includes('Registry timed out'))).toBe(true))
  })

  it('adds a discovered MCP server and keeps HTTP-only servers out of HTTPS-only products', async () => {
    render(<Harness registry={registry} publicHttpsMcpOnly />)
    openDisclosure('MCP servers')
    search('Search MCP registries', 'filesystem')
    const insecure = await screen.findByLabelText('Registry server insecure')
    expect(insecure.textContent).toContain('public HTTPS')
    expect((screen.getByRole('button', { name: 'Add server insecure' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Add server filesystem' }))
    await waitFor(() => expect(screen.getByTestId('profile').textContent).toContain('filesystem'))
    const profile = JSON.parse(screen.getByTestId('profile').textContent ?? '{}') as AgentProfile
    expect(profile.mcp).toEqual({ filesystem: { transport: 'http', url: 'https://mcp.example.com/filesystem' } })
  })

  it('preserves first-class custom references alongside discovery', async () => {
    render(<Harness registry={registry} requireUniqueSkillNames
      initial={{ resources: { skills: [{ kind: 'inline', name: 'booking-guide', content: 'Custom skill.' }] } }} />)
    openDisclosure('Skills')
    search('Search skill catalogs', 'booking')
    const result = await screen.findByLabelText('Catalog skill booking-guide')
    expect(result.textContent).toContain('Added')
    expect((screen.getByRole('button', { name: 'Add skill booking-guide' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('profile').textContent).toContain('Custom skill.')
  })

  it('does not search when the editor is disabled', () => {
    const spy: AgentProfileRegistryPort = { searchSkills: vi.fn(), searchMcpServers: vi.fn() }
    render(<Harness registry={spy} disabled />)
    openDisclosure('Skills')
    expect((screen.getByLabelText('Search skill catalogs') as HTMLInputElement).disabled).toBe(true)
    expect(spy.searchSkills).not.toHaveBeenCalled()
  })
})
