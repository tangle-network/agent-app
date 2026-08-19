import type { Meta, StoryObj } from '@storybook/react'

import type { Generation } from '../../studio/generation'
import { StudioGenerationScreen } from '../../studio-react/studio-generation-screen'
import { queuedGeneration, teaserBatch } from './fixtures'
import {
  installStudioComposerFetchStub,
  noOpGenerated,
  StudioProviders,
  storyMediaActions,
} from './StudioProviders'

const generatingRows: Generation[] = Array.from({ length: 4 }, (_, index) => ({
  ...queuedGeneration,
  id: `local-wide-pending-${index}`,
  prompt: 'A wide cinematic launch sequence with the product crossing a field of light.',
  metadata: {
    generationStatus: 'pending',
    clientRequestId: 'req-wide-pending',
    outputIndex: index,
    outputCount: 4,
    aspectRatio: '16:9',
  },
}))

const singleWideResult: Generation = {
  ...teaserBatch[0]!,
  id: 'gen-single-wide',
  prompt: 'A panoramic product reveal on a mirrored stage, cobalt dusk lighting.',
  metadata: {
    generationStatus: 'succeeded',
    clientRequestId: 'req-single-wide',
    outputIndex: 0,
    outputCount: 1,
    aspectRatio: '16:9',
  },
}

const meta: Meta<typeof StudioGenerationScreen> = {
  title: 'Studio/StudioGenerationScreen',
  // A full-viewport screen: the global `centered` layout shrink-wraps it to
  // content width, which misrepresents the centered results column + dock.
  parameters: { layout: 'fullscreen' },
  component: StudioGenerationScreen,
  decorators: [
    (Story) => {
      installStudioComposerFetchStub()
      return <StudioProviders><div className="min-h-screen"><Story /></div></StudioProviders>
    },
  ],
  args: {
    generations: teaserBatch,
    batchKey: 'req-batch',
    workspaceId: 'ws-demo',
    onGenerated: noOpGenerated,
    onOpenGeneration: (batchKey, first) => console.log('open generation', batchKey, first.id),
    onBack: () => console.log('back'),
    actions: storyMediaActions,
  },
}

export default meta
type Story = StoryObj<typeof StudioGenerationScreen>

export const Generating: Story = {
  args: { generations: generatingRows, batchKey: 'req-wide-pending' },
}

export const Results: Story = {}

export const SingleWideResult: Story = {
  name: 'Single wide result',
  args: { generations: [singleWideResult], batchKey: 'req-single-wide' },
}

export const EmptyAfterDelete: Story = {
  name: 'Empty after delete',
  args: { generations: teaserBatch, batchKey: 'req-deleted-batch' },
}
