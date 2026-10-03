import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { AgentSessionControls, EntryComposer, WorkspaceSwitcher } from '../../web-react'
import type { Harness } from '../../harness'
import { catalogModels } from '../chat-controls/fixtures'

const names = ['Research', 'Tax', 'Legal', 'Engineering', 'Insurance', 'Relationships'] as const
function WorkspaceControlsDemo({ domain = 'Research' }: { domain?: typeof names[number] }) {
  const [workspace, setWorkspace] = useState('workspace-a')
  const [model, setModel] = useState(catalogModels[0].id)
  const [harness, setHarness] = useState<Harness>('opencode')
  const [effort, setEffort] = useState('auto')
  const [result, setResult] = useState('')
  const agent = { models: catalogModels, model, onModelChange: setModel, harness, onHarnessChange: setHarness, effort, onEffortChange: setEffort, layout: 'grouped' as const, settingsSummary: `${domain} agent` }
  return <div className="flex h-dvh min-h-0 bg-background text-foreground">
    <aside className="hidden w-64 shrink-0 border-r border-border bg-muted/30 p-4 lg:block">
      <WorkspaceSwitcher items={[{ id: 'workspace-a', name: `${domain} workspace` }, { id: 'workspace-b', name: 'A second workspace with a much longer descriptive name' }]} value={workspace} onChange={setWorkspace} footer={<button type="button" className="w-full rounded-lg p-2 text-left text-sm">New workspace</button>} />
      <p className="mt-8 text-sm text-muted-foreground">No customer data — interactive UI fixture.</p>
    </aside>
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="border-b border-border p-3 lg:hidden"><WorkspaceSwitcher items={[{ id: 'workspace-a', name: `${domain} workspace` }]} value={workspace} onChange={setWorkspace} variant="inline" /></div>
      <EntryComposer heading="What should we work on?" subheading={`One place for your ${domain.toLowerCase()} work.`} agent={agent} placeholder="Describe the outcome you need…" onSubmit={(prompt) => setResult(prompt)} footer={<p role="status" className="text-center text-sm text-muted-foreground">{result ? `Local fixture accepted: ${result}` : 'Attachments are omitted because no upload service is connected.'}</p>} />
      <div className="border-t border-border p-3"><AgentSessionControls {...agent} /></div>
    </main>
  </div>
}
const meta: Meta<typeof WorkspaceControlsDemo> = { title: 'Workspace/Shared controls', component: WorkspaceControlsDemo, parameters: { layout: 'fullscreen' }, argTypes: { domain: { control: 'select', options: names } } }
export default meta
type Story = StoryObj<typeof WorkspaceControlsDemo>
export const Research: Story = {}
export const Tax: Story = { args: { domain: 'Tax' } }
export const Legal: Story = { args: { domain: 'Legal' } }
export const Engineering: Story = { args: { domain: 'Engineering' } }
export const Insurance: Story = { args: { domain: 'Insurance' } }
export const Relationships: Story = { args: { domain: 'Relationships' } }
