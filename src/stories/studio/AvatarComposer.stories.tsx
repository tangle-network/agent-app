import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { AvatarComposer } from '../../studio-react'

const meta: Meta<typeof AvatarComposer> = {
  title: 'Studio/AvatarComposer',
  component: AvatarComposer,
  decorators: [
    (Story) => (
      <div className="w-[560px] p-4">
        <Story />
      </div>
    ),
  ],
  args: {
    audioUrl: '',
    imageUrl: '',
    avatarId: '',
    onAudioUrlChange: (value) => console.log('onAudioUrlChange', value),
    onImageUrlChange: (value) => console.log('onImageUrlChange', value),
    onAvatarIdChange: (value) => console.log('onAvatarIdChange', value),
  },
}

export default meta
type Story = StoryObj<typeof AvatarComposer>

export const Default: Story = {}

export const Populated: Story = {
  args: {
    audioUrl: 'https://cdn.example.com/voiceover-take-3.mp3',
    imageUrl: 'https://cdn.example.com/presenter-portrait.png',
    avatarId: 'avtr_9f2k1',
  },
}

export const Interactive: Story = {
  render: function AvatarComposerDemo() {
    const [audioUrl, setAudioUrl] = useState('')
    const [imageUrl, setImageUrl] = useState('')
    const [avatarId, setAvatarId] = useState('')
    return (
      <AvatarComposer
        audioUrl={audioUrl}
        imageUrl={imageUrl}
        avatarId={avatarId}
        onAudioUrlChange={setAudioUrl}
        onImageUrlChange={setImageUrl}
        onAvatarIdChange={setAvatarId}
      />
    )
  },
}
