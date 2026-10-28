import type { Meta, StoryObj } from '@storybook/react'
import { AgentSetupBlock } from '../../web-react/agent-setup-block'

const meta: Meta<typeof AgentSetupBlock> = {
  title: 'App Shell/Agent setup',
  component: AgentSetupBlock,
  parameters: { layout: 'centered' },
  args: {
    productName: 'Tangle Widget',
    setupUrl: 'https://widget.tangle.tools/agent-setup.md',
    markdown: '# Set up Tangle Widget\n\nFollow the product setup steps.',
  },
}
export default meta

type Story = StoryObj<typeof AgentSetupBlock>
export const Default: Story = {}
