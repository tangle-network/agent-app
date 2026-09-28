import type { Meta, StoryObj } from '@storybook/react'
import { useMemo } from 'react'
import { userEvent, within } from 'storybook/test'
import { LineSetup } from '../../hosted-agent/react'
import type { LineSetupSnapshot } from '../../hosted-agent/react'
import {
  createSetupClient, createSetupRefreshFailureClient, setupConnected, setupDisconnected, setupEmpty,
  setupManualNumberReconnect, setupMultiNumberDisconnected,
} from './fixtures'

const meta: Meta<typeof LineSetup> = {
  title: 'Hosted agent/Lines/Setup',
  component: LineSetup,
  parameters: { layout: 'padded' },
  decorators: [(Story) => <div style={{ maxWidth: 760, padding: 16 }}><Story /></div>],
}

export default meta
type Story = StoryObj<typeof LineSetup>

function SetupFixture({ snapshot, scopeKey, initialTargetId, failRefreshAfterMutation = false }: {
  snapshot: LineSetupSnapshot
  scopeKey: string
  initialTargetId?: string
  failRefreshAfterMutation?: boolean
}) {
  const client = useMemo(() => failRefreshAfterMutation
    ? createSetupRefreshFailureClient(snapshot) : createSetupClient(snapshot), [snapshot, failRefreshAfterMutation])
  return <LineSetup client={client} scopeKey={scopeKey} canManage initialTargetId={initialTargetId} />
}

export const Connected: Story = {
  render: () => <SetupFixture snapshot={setupConnected} scopeKey="storybook-connected" initialTargetId="agent_guide" />,
}

export const DisconnectConfirmation: Story = {
  render: () => <SetupFixture snapshot={setupConnected} scopeKey="storybook-confirmation" initialTargetId="agent_guide" />,
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: 'Disconnect line' }))
  },
}

export const RefreshAfterConnectError: Story = {
  render: () => <SetupFixture snapshot={setupEmpty} scopeKey="storybook-connect-refresh-error" failRefreshAfterMutation />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole('button', { name: 'Connect Email' }))
    await canvas.findByText('The updated line could not be loaded.')
  },
}

export const RefreshAfterDisconnectError: Story = {
  render: () => <SetupFixture snapshot={setupConnected} scopeKey="storybook-disconnect-refresh-error" failRefreshAfterMutation />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole('button', { name: 'Disconnect line' }))
    await userEvent.click(await canvas.findByRole('button', { name: /^Disconnect$/ }))
    await canvas.findByText('The updated line could not be loaded.')
  },
}

export const Disconnected: Story = {
  render: () => <SetupFixture snapshot={setupDisconnected} scopeKey="storybook-disconnected" initialTargetId="agent_guide" />,
}

export const SameConnectionNumbers: Story = {
  render: () => <SetupFixture snapshot={setupMultiNumberDisconnected} scopeKey="storybook-multi-number" initialTargetId="agent_guide" />,
}

export const ManualNumberReconnect: Story = {
  render: () => <SetupFixture snapshot={setupManualNumberReconnect} scopeKey="storybook-manual-number" initialTargetId="agent_guide" />,
}

export const Empty: Story = {
  render: () => <SetupFixture snapshot={{ ...setupEmpty, connections: [] }} scopeKey="storybook-empty" />,
}

export const Loading: Story = {
  args: {
    client: { load: () => new Promise(() => {}), connect: async () => {}, disconnect: async () => {} },
    scopeKey: 'storybook-loading', canManage: true,
  },
}

export const LoadError: Story = {
  args: {
    client: { load: async () => { throw new Error('Lines could not be loaded.') }, connect: async () => {}, disconnect: async () => {} },
    scopeKey: 'storybook-error', canManage: true,
  },
}

function InteractiveSetup() {
  return <SetupFixture snapshot={setupEmpty} scopeKey="storybook-interactive" initialTargetId="agent_guide" />
}

export const InteractiveDark: Story = {
  name: 'Interactive · dark',
  globals: { agentTheme: 'agent-dark' },
  render: () => <InteractiveSetup />,
}

export const InteractiveLight: Story = {
  name: 'Interactive · light',
  globals: { agentTheme: 'agent-light' },
  render: () => <InteractiveSetup />,
}
