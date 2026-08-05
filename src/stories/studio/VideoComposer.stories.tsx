import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { VideoComposer } from '../../studio-react'

const meta: Meta<typeof VideoComposer> = {
  title: 'Studio/VideoComposer',
  component: VideoComposer,
  decorators: [
    (Story) => (
      <div className="w-[560px] p-4">
        <Story />
      </div>
    ),
  ],
  args: {
    duration: '6',
    resolution: '720p',
    aspectRatio: '16:9',
    referenceImageUrl: '',
    onDurationChange: (value) => console.log('onDurationChange', value),
    onResolutionChange: (value) => console.log('onResolutionChange', value),
    onAspectRatioChange: (value) => console.log('onAspectRatioChange', value),
    onReferenceImageUrlChange: (value) => console.log('onReferenceImageUrlChange', value),
  },
}

export default meta
type Story = StoryObj<typeof VideoComposer>

export const Default: Story = {}

export const Populated: Story = {
  args: {
    duration: '12',
    resolution: '1080p',
    aspectRatio: '9:16',
    referenceImageUrl: 'https://cdn.example.com/storyboard-frame.png',
  },
}

export const Interactive: Story = {
  render: function VideoComposerDemo() {
    const [duration, setDuration] = useState('6')
    const [resolution, setResolution] = useState('720p')
    const [aspectRatio, setAspectRatio] = useState('16:9')
    const [referenceImageUrl, setReferenceImageUrl] = useState('')
    return (
      <VideoComposer
        duration={duration}
        resolution={resolution}
        aspectRatio={aspectRatio}
        referenceImageUrl={referenceImageUrl}
        onDurationChange={setDuration}
        onResolutionChange={setResolution}
        onAspectRatioChange={setAspectRatio}
        onReferenceImageUrlChange={setReferenceImageUrl}
      />
    )
  },
}
