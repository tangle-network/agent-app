import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import type { AgentProfile } from '@tangle-network/agent-interface/profile'
import { AgentProfileEditor, type AgentProfileEditorProps } from '../../web-react/agent-profile-editor'

const example: AgentProfile = {
  name: 'Research assistant',
  description: 'Checks current sources and drafts concise answers.',
  prompt: {
    instructions: ['Check source dates before answering.', 'Cite claims that may change.'],
    appendSystemPrompt: 'Keep answers clear and direct.',
  },
  model: { default: 'provider/model', reasoningEffort: 'medium' },
  tools: { web_search: true, publish: false },
  permissions: { web_search: 'allow', publish: 'ask' },
  resources: {
    skills: [{ kind: 'github', repository: 'example/agent-skills', path: 'research/SKILL.md' }],
    tools: [{ kind: 'github', repository: 'example/agent-tools', path: 'tools/search.ts', ref: 'main' }],
    files: [
      { path: 'guides/front-desk.md', resource: { kind: 'inline', name: 'front-desk.md', content: '# Front desk\nConfirm the guest name before changing a booking.' } },
      { path: 'scripts/check-booking.ts', resource: { kind: 'github', repository: 'example/agent-tools', path: 'scripts/check-booking.ts' }, executable: true },
    ],
  },
  mcp: { catalog: { transport: 'http', url: 'https://example.test/mcp' } },
  hooks: { beforeTurn: [{ command: 'check-policy' }] },
}

type ResourceConstraints = Pick<AgentProfileEditorProps, 'allowedResourceKinds' | 'filePathPrefix' |
  'allowExecutableFiles' | 'requireGitHubCommitSha' | 'requireUniqueSkillNames' | 'showToolsAndPermissions' |
  'publicHttpsMcpOnly'>

function Preview({ initial, ...constraints }: { initial: AgentProfile } & ResourceConstraints) {
  const [profile, setProfile] = useState(initial)
  return <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
    <div className="mx-auto max-w-3xl space-y-5">
      <header><h1 className="text-2xl font-semibold">Agent profile</h1><p className="mt-1 text-sm text-muted-foreground">Edit a local profile draft.</p></header>
      <AgentProfileEditor value={profile} onChange={setProfile} {...constraints} />
      <details className="rounded-xl border border-border bg-card p-4"><summary className="cursor-pointer text-sm font-medium">Current profile data</summary>
        <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(profile, null, 2)}</pre></details>
    </div>
  </main>
}

const meta: Meta<typeof AgentProfileEditor> = {
  title: 'App Shell/Agent profile editor',
  component: AgentProfileEditor,
  parameters: { layout: 'fullscreen' },
  args: { value: example, onChange: () => {} },
  render: args => <Preview initial={args.value} allowedResourceKinds={args.allowedResourceKinds}
    filePathPrefix={args.filePathPrefix} allowExecutableFiles={args.allowExecutableFiles}
    requireGitHubCommitSha={args.requireGitHubCommitSha} requireUniqueSkillNames={args.requireUniqueSkillNames}
    showToolsAndPermissions={args.showToolsAndPermissions} publicHttpsMcpOnly={args.publicHttpsMcpOnly} />,
}
export default meta
type Story = StoryObj<typeof AgentProfileEditor>
export const Complete: Story = {}
export const Empty: Story = { args: { value: {} } }
export const RepositoryNeeded: Story = {
  args: { value: { resources: { tools: [{ kind: 'github', path: 'tools/search.ts' }] } } },
}
export const LimitedResources: Story = {
  args: { value: example, allowedResourceKinds: ['files', 'skills', 'instructions'] },
}

const fixedCommit = '0123456789abcdef0123456789abcdef01234567'
const referenceResources: AgentProfile = {
  name: 'Reference assistant',
  tools: { read: false, skill: true },
  permissions: { read: 'deny', skill: 'allow' },
  mcp: { catalog: { transport: 'http', url: 'https://catalog.example.com/mcp' } },
  resources: {
    files: [
      { path: 'reference/arrival.md', resource: { kind: 'inline', name: 'arrival.md', content: '# Arrivals\nConfirm the booking reference.' } },
      { path: 'reference/terms.md', resource: { kind: 'github', repository: 'example/agent-guides', path: 'terms.md', ref: fixedCommit } },
    ],
    skills: [{ kind: 'inline', name: 'booking-guide', content: 'Use the declared reference files when answering booking questions.' }],
  },
}

const referenceConstraints = {
  allowedResourceKinds: ['files', 'skills', 'instructions'],
  filePathPrefix: 'reference/',
  allowExecutableFiles: false,
  requireGitHubCommitSha: true,
  requireUniqueSkillNames: true,
  showToolsAndPermissions: false,
  publicHttpsMcpOnly: true,
} as const

export const ReferenceOnly: Story = { args: { value: referenceResources, ...referenceConstraints } }
export const ExistingResourcesToRepair: Story = {
  args: { value: { resources: {
    files: [{ path: 'docs/old-guide.md', resource: { kind: 'github', repository: 'example/agent-guides', path: 'old-guide.md', ref: 'main' }, executable: true }],
    skills: [{ kind: 'github', repository: 'example/agent-guides', path: 'skills/booking/SKILL.md', ref: 'main' }],
  }, mcp: { local: { command: 'local-mcp' }, insecure: { transport: 'http', url: 'http://example.com/mcp' } } }, ...referenceConstraints },
}
