import type { Meta, StoryObj } from '@storybook/react'

import { StudioHomeScreen } from '../../studio-react/studio-home-screen'
import { historyGenerations } from './fixtures'
import {
  installStudioComposerFetchStub,
  noOpGenerated,
  StudioProviders,
  storyMediaActions,
} from './StudioProviders'

const meta: Meta<typeof StudioHomeScreen> = {
  title: 'Studio/StudioHomeScreen',
  component: StudioHomeScreen,
  decorators: [
    (Story) => {
      installStudioComposerFetchStub()
      return <StudioProviders><div className="min-h-screen"><Story /></div></StudioProviders>
    },
  ],
  args: {
    generations: historyGenerations.slice(0, 12),
    workspaceId: 'ws-demo',
    onGenerated: noOpGenerated,
    onOpenGeneration: (batchKey, first) => console.log('open generation', batchKey, first.id),
    onOpenHistory: () => console.log('open history'),
    actions: storyMediaActions,
  },
}

export default meta
type Story = StoryObj<typeof StudioHomeScreen>

export const Populated: Story = {}

export const Empty: Story = {
  args: { generations: [] },
}
