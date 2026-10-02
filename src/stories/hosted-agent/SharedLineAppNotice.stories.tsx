import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { expect, fn, within } from 'storybook/test'
import { SharedLineAppNotice } from '../../hosted-agent/react/SharedLineAppNotice'

const meta: Meta<typeof SharedLineAppNotice> = {
  title: 'Hosted agent/Lines/Shared app conversation',
  component: SharedLineAppNotice,
  parameters: { layout: 'padded' },
  decorators: [(Story) => <div style={{ maxWidth: 900, padding: 16 }}><Story /></div>],
}

export default meta
type Story = StoryObj<typeof SharedLineAppNotice>

const apps = [
  { id: 'app-front-desk', name: 'Front Desk' },
  { id: 'app-reservations', name: 'Reservations' },
  { id: 'app-guest-care', name: 'Guest Care' },
] as const

function InteractiveNotice() {
  const [open, setOpen] = useState(true)
  return (
    <SharedLineAppNotice
      apps={apps}
      open={open}
      onKeepSharing={() => setOpen(false)}
      onRequestDedicatedNumber={fn()}
    />
  )
}

export const Light: Story = {
  globals: { agentTheme: 'agent-light' },
  render: () => <InteractiveNotice />,
}

export const Dark: Story = {
  globals: { agentTheme: 'agent-dark' },
  render: () => <InteractiveNotice />,
}

export const OneApp: Story = {
  args: { apps: [apps[0]], open: true, onKeepSharing: fn() },
}

export const DuplicateRegistration: Story = {
  args: {
    apps: [...apps, { id: apps[0].id, name: 'Old Front Desk label' }],
    open: true,
    onKeepSharing: fn(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole('heading', { name: 'These apps share one text conversation' })
    await expect(canvas.getAllByRole('listitem')).toHaveLength(3)
  },
}
