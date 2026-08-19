import type { Meta, StoryObj } from '@storybook/react'

import type { Generation } from '../../studio/generation'
import { MediaTile } from '../../studio-react/media-tile'
import {
  queuedGeneration,
  speechGenerationPlayable,
  storyboardGeneration,
  teaserBatch,
  videoGeneration,
} from './fixtures'
import { StudioProviders, storyMediaActions } from './StudioProviders'

const imageGeneration = teaserBatch[0]!
const open = (generation: Generation) => console.log('open', generation.id)
const requestDelete = (generation: Generation) => console.log('request delete', generation.id)
const toggleSelect = (id: string) => console.log('toggle select', id)

const meta: Meta<typeof MediaTile> = {
  title: 'Studio/MediaTile',
  component: MediaTile,
  decorators: [
    (Story) => (
      <StudioProviders>
        <div className="p-4"><Story /></div>
      </StudioProviders>
    ),
  ],
  render: (args) => <div className="w-[300px] max-w-full"><MediaTile {...args} /></div>,
  args: {
    generation: imageGeneration,
    context: 'history',
    onOpen: open,
    actions: storyMediaActions,
    onRequestDelete: requestDelete,
    onToggleSelect: toggleSelect,
  },
}

export default meta
type Story = StoryObj<typeof MediaTile>

export const Image: Story = {}

export const Video: Story = {
  args: { generation: videoGeneration },
}

export const AudioIdle: Story = {
  name: 'Audio idle',
  args: { generation: speechGenerationPlayable },
}

export const InVault: Story = {
  name: 'In vault',
  args: { generation: storyboardGeneration },
}

export const Selected: Story = {
  args: { selectMode: true, selected: true },
}

export const SelectMode: Story = {
  name: 'Select mode',
  args: { selectMode: true },
}

export const Generating: Story = {
  args: { generation: queuedGeneration },
}

export const AllStates: Story = {
  name: 'All states',
  render: (args) => (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-[3px]">
      <MediaTile {...args} generation={imageGeneration} />
      <MediaTile {...args} generation={videoGeneration} />
      <MediaTile {...args} generation={speechGenerationPlayable} />
      <MediaTile {...args} generation={storyboardGeneration} />
      <MediaTile {...args} generation={imageGeneration} selectMode />
      <MediaTile {...args} generation={imageGeneration} selectMode selected />
      <MediaTile {...args} generation={queuedGeneration} />
    </div>
  ),
}
