import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import type { AgentProfile } from '@tangle-network/agent-interface/profile'
import { AgentProfileEditor } from '../../web-react/agent-profile-editor'

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
  resources: { skills: [{ kind: 'github', repository: 'example/agent-skills', path: 'research/SKILL.md' }] },
  mcp: { catalog: { transport: 'http', url: 'https://example.test/mcp' } },
  hooks: { beforeTurn: [{ command: 'check-policy' }] },
}

function Preview({ initial }: { initial: AgentProfile }) {
  const [profile, setProfile] = useState(initial)
  const [saved, setSaved] = useState<AgentProfile | null>(null)
  return <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-2xl font-semibold">Agent profile</h1><p className="mt-1 text-sm text-muted-foreground">Configure the agent before saving its profile.</p></div>
        <button type="button" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground" onClick={() => setSaved(profile)}>Save profile</button>
      </div>
      {saved && <p role="status" className="rounded-lg border border-border bg-card p-3 text-sm">Saved {saved.name}</p>}
      <AgentProfileEditor value={profile} onChange={setProfile} />
    </div>
  </main>
}

const meta: Meta<typeof AgentProfileEditor> = {
  title: 'App Shell/Agent profile editor',
  component: AgentProfileEditor,
  parameters: { layout: 'fullscreen' },
  args: { value: example, onChange: () => {} },
  render: args => <Preview initial={args.value} />,
}
export default meta
type Story = StoryObj<typeof AgentProfileEditor>
export const Complete: Story = {}
export const Empty: Story = { args: { value: {} } }
