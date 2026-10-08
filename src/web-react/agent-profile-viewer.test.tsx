import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentProfile } from '@tangle-network/agent-interface/profile'
import { AgentProfileViewer } from './agent-profile-viewer'

describe('AgentProfileViewer', () => {
  it('shows the actual profile layers while keeping MCP configuration private', () => {
    const profile: AgentProfile = {
      name: 'Front desk',
      description: 'Answers guest questions.',
      prompt: {
        systemPrompt: 'You are the front desk agent.',
        appendSystemPrompt: 'Use the guest ledger when relevant.',
        instructions: ['Never invent availability.'],
      },
      model: { default: 'provider/frontier' },
      tools: { 'ledger.search': true, 'ledger.write': false },
      permissions: { network: { search: 'allow', booking: 'ask' } },
      mcp: {
        private: {
          transport: 'http',
          url: 'https://private.example/mcp',
          headers: { Authorization: { kind: 'secret-ref', key: 'credential-key' } },
        },
        unavailable: { enabled: false },
      },
      resources: {
        files: [{
          path: 'policies/refunds.md',
          resource: { kind: 'inline', name: 'Refund policy', content: 'Review before issuing a refund.' },
        }],
        skills: [{ kind: 'github', repository: 'tangle/skills', path: 'hospitality/SKILL.md', ref: 'abc123' }],
        instructions: 'Follow the approved property policy.',
      },
    }

    const html = renderToStaticMarkup(<AgentProfileViewer profile={profile} />)

    expect(html).toContain('Front desk')
    expect(html).toContain('You are the front desk agent.')
    expect(html).toContain('Replaces default instructions')
    expect(html).toContain('Use the guest ledger when relevant.')
    expect(html).toContain('Lower-privilege workspace guidance')
    expect(html).toContain('ledger.search')
    expect(html).toContain('Disabled in profile')
    expect(html).toContain('private')
    expect(html).not.toContain('private.example')
    expect(html).not.toContain('credential-key')
    expect(html).toContain('policies/refunds.md')
    expect(html).toContain('hospitality/SKILL.md')
    expect(html).toContain('View inline content')
    expect(html).not.toContain('<input')
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('materialized')
    expect(html).not.toContain('ready')
  })

  it('omits empty sections instead of presenting placeholders or fake readiness', () => {
    const html = renderToStaticMarkup(<AgentProfileViewer profile={{ name: 'Bare profile' }} />)

    expect(html).toContain('Bare profile')
    expect(html).toContain('No profile details are configured.')
    expect(html).not.toContain('Behavior')
    expect(html).not.toContain('Tool policy')
    expect(html).not.toContain('MCP servers')
    expect(html).not.toContain('Declared resources')
    expect(html).not.toContain('ready')
    expect(html).not.toContain('mount')
    expect(html).not.toContain('<button')
  })

  it('shows reasoning-only metadata without an empty configuration disclosure', () => {
    const html = renderToStaticMarkup(<AgentProfileViewer profile={{
      name: 'Reasoning profile',
      description: 'A profile with model guidance only.',
      model: { reasoningEffort: 'high' },
    }} />)

    expect(html).toContain('Reasoning')
    expect(html).toContain('high')
    expect(html).not.toContain('Profile configuration')
    expect(html).not.toContain('No profile details are configured.')
  })
})

// Configuration-only profiles must remain discoverable without fake runtime state.
describe('AgentProfileViewer configuration visibility', () => {
  it('shows hooks and modes even without other profile details', () => {
    const html = renderToStaticMarkup(<AgentProfileViewer profile={{
      name: 'Lifecycle profile', hooks: { beforeTurn: [{ command: 'private command' }] },
      modes: { careful: { tools: { write: false } } },
    }} />)
    expect(html).toContain('Lifecycle hooks')
    expect(html).not.toContain('Subagents')
    expect(html).toContain('beforeTurn')
    expect(html).not.toContain('private command')
    expect(html).toContain('Modes')
    expect(html).toContain('careful')
  })

  it('starts compact when embedded in a narrow copilot', () => {
    const html = renderToStaticMarkup(<AgentProfileViewer profile={{
      name: 'Copilot', prompt: { instructions: ['Use actual files.'] },
    }} defaultExpanded={false} />)
    expect(html).toContain('Use actual files.')
    expect(html).not.toContain('<details open=""')
  })
})
