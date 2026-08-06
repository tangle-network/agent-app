import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { ImageComposer } from '../../studio-react'

const meta: Meta<typeof ImageComposer> = {
  title: 'Studio/ImageComposer',
  component: ImageComposer,
  decorators: [
    (Story) => (
      <div className="w-[560px] p-4">
        <Story />
      </div>
    ),
  ],
  args: {
    size: '1536x1024',
    quality: 'high',
    imageCount: 1,
    onSizeChange: (value) => console.log('onSizeChange', value),
    onQualityChange: (value) => console.log('onQualityChange', value),
    onImageCountChange: (value) => console.log('onImageCountChange', value),
  },
}

export default meta
type Story = StoryObj<typeof ImageComposer>

export const Default: Story = {}

export const Populated: Story = {
  args: { size: '1024x1024', quality: 'medium', imageCount: 4 },
}

/** Fully wired — the stepper clamps 1–4 via normalizeImageCount. */
export const Interactive: Story = {
  render: function ImageComposerDemo() {
    const [size, setSize] = useState('1536x1024')
    const [quality, setQuality] = useState('high')
    const [imageCount, setImageCount] = useState(2)
    return (
      <ImageComposer
        size={size}
        quality={quality}
        imageCount={imageCount}
        onSizeChange={setSize}
        onQualityChange={setQuality}
        onImageCountChange={setImageCount}
      />
    )
  },
}
