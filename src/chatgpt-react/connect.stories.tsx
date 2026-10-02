import type { Meta, StoryObj } from '@storybook/react'
import { ChatGPTConnect } from './index'
import { creativeExample, gtmExample } from './fixtures'

const meta = {
  title: 'Connections/ChatGPT',
  component: ChatGPTConnect,
  args: gtmExample,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof ChatGPTConnect>
export default meta
type Story = StoryObj<typeof meta>
export const Setup: Story = {}
export const Creative: Story = { args: creativeExample }
export const Checking: Story = { args: { state: { status: 'checking' } } }
export const Connected: Story = { args: { state: { status: 'connected' } } }
export const Error: Story = { args: { state: { status: 'error', message: 'Connection could not be checked. Try again.' }, onCheck: () => {} } }
export const MissingEndpoint: Story = { args: { endpoint: '' } }
