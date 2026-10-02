import type { Meta, StoryObj } from '@storybook/react'
import { ConnectToChatGPT } from './chatgpt'
import type { ConnectToChatGPTProps } from './chatgpt-types'

// Render fixtures, not registered apps or hosted acceptance evidence.
const enrollment = { enrollmentId: 'fixture-enrollment', agentId: 'fixture-agent', workspaceId: 'fixture-workspace', threadId: 'fixture-thread' }
const setup = {
  app: { name: 'Builder' }, enrollment, endpoint: 'https://builder.example/api/agents/mcp',
} satisfies ConnectToChatGPTProps
const registration = { connectionId: 'asdk_app_fixture', endpoint: setup.endpoint }
const meta = {
  title: 'Integrations/Connect to ChatGPT', component: ConnectToChatGPT,
  args: setup,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof ConnectToChatGPT>
export default meta

type Story = StoryObj<typeof meta>
export const Setup: Story = {}
export const Registered: Story = { args: { connection: { status: 'registered', registration } } }
export const Connected: Story = { args: { connection: { status: 'connected', registration, enrollment } } }
export const Checking: Story = { args: { connection: { status: 'checking' } } }
export const Error: Story = { args: { connection: { status: 'error' } } }
export const MissingConfiguration: Story = { args: { endpoint: '' } }
export const StaleConversation: Story = {
  args: { connection: { status: 'connected', registration, enrollment: { ...enrollment, threadId: 'previous-thread' } } },
}
export const TwoApps: Story = {
  render: () => <div className="grid min-w-0 gap-6 lg:grid-cols-2">
    <ConnectToChatGPT {...setup} />
    <ConnectToChatGPT
      app={{ name: 'GTM — international enterprise and partner development workspace' }}
      enrollment={{ ...enrollment, enrollmentId: 'gtm-enrollment', agentId: 'gtm-agent' }}
      endpoint="https://gtm.example/api/agents/mcp"
      connection={{ status: 'registered', registration: { connectionId: 'connector_fixture', endpoint: 'https://gtm.example/api/agents/mcp' } }}
    />
  </div>,
}
