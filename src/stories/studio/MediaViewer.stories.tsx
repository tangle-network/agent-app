import type { Meta, StoryObj } from '@storybook/react'

import { MediaViewerModal } from '../../studio-react/media-viewer'
import {
  speechGenerationPlayable,
  storyboardGeneration,
  teaserBatch,
  videoGeneration,
} from './fixtures'
import { StudioProviders, storyMediaActions } from './StudioProviders'

const meta: Meta<typeof MediaViewerModal> = {
  title: 'Studio/MediaViewer',
  component: MediaViewerModal,
  decorators: [
    (Story) => (
      <StudioProviders>
        <div className="min-h-screen bg-[radial-gradient(circle_at_top,hsl(var(--accent)),hsl(var(--background))_55%)] p-8">
          <p className="text-sm text-muted-foreground">Backdrop canvas behind the portaled viewer.</p>
          <Story />
        </div>
      </StudioProviders>
    ),
  ],
  args: {
    generation: teaserBatch[0]!,
    onClose: () => console.log('close viewer'),
    actions: storyMediaActions,
    onRequestDelete: (generation) => console.log('request delete', generation.id),
  },
}

export default meta
type Story = StoryObj<typeof MediaViewerModal>

export const ImageOpen: Story = { name: 'Image open' }

export const VideoOpen: Story = {
  name: 'Video open',
  args: { generation: videoGeneration },
}

export const AudioOpen: Story = {
  name: 'Audio open',
  args: { generation: speechGenerationPlayable },
}

export const SavedToVault: Story = {
  name: 'Saved to vault',
  args: { generation: storyboardGeneration },
}
