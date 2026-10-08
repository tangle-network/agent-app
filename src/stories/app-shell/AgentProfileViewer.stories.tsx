import type { Meta, StoryObj } from '@storybook/react'
import { AgentProfileViewer } from '../../web-react/agent-profile-viewer'

const meta: Meta<typeof AgentProfileViewer> = {
  title: 'App Shell/Agent profile viewer',
  component: AgentProfileViewer,
  parameters: { layout: 'fullscreen' },
  args: { profile: {
    name: 'Front desk', description: 'Helps guests and coordinates with the team.', version: '1',
    model: { default: 'provider/model', reasoningEffort: 'medium' },
    prompt: { systemPrompt: 'You are the front desk coordinator.',
      instructions: ['Read the reference files before answering.', 'Confirm availability through the approved tools.'] },
    tools: { 'reference.read': true, 'booking.request': true },
    permissions: { 'booking.request': 'ask' },
    mcp: { hospitality: { transport: 'http', url: 'https://example.test/mcp' } },
    resources: { files: [{ path: 'reference/activities.md', resource: { kind: 'inline',
      name: 'Activities', content: '# Activity guide\nAsk the owner to add verified instructors and contact details.' } }],
      skills: [{ kind: 'inline', name: 'activity-coordination', content: 'Gather the requested activity and preferred time. Ask the owner when information is missing.' }] },
  } },
  render: args => <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
    <div className="mx-auto max-w-5xl"><AgentProfileViewer {...args} /></div>
  </main>,
}
export default meta
type Story = StoryObj<typeof AgentProfileViewer>
export const Complete: Story = {}
export const Empty: Story = { args: { profile: { name: 'New agent' } } }
export const Copilot: Story = { args: { defaultExpanded: false }, render: args =>
  <aside className="min-h-screen max-w-sm bg-background p-4 text-foreground"><AgentProfileViewer {...args} /></aside> }

export const InWorkspace: Story = { args: { showIdentity: false } }
