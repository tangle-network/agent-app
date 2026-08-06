import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { SpeechComposer } from '../../studio-react'

const meta: Meta<typeof SpeechComposer> = {
  title: 'Studio/SpeechComposer',
  component: SpeechComposer,
  decorators: [
    (Story) => (
      <div className="w-[560px] p-4">
        <Story />
      </div>
    ),
  ],
  args: {
    voice: 'alloy',
    onVoiceChange: (value) => console.log('onVoiceChange', value),
  },
}

export default meta
type Story = StoryObj<typeof SpeechComposer>

export const Default: Story = {}

export const Populated: Story = {
  args: { voice: 'shimmer' },
}

export const Interactive: Story = {
  render: function SpeechComposerDemo() {
    const [voice, setVoice] = useState('alloy')
    return <SpeechComposer voice={voice} onVoiceChange={setVoice} />
  },
}
