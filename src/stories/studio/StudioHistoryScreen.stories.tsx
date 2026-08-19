import type { Meta, StoryObj } from '@storybook/react'

import { StudioHistoryScreen } from '../../studio-react/studio-history-screen'
import {
  fakeFetchGenerationsPage,
  historyGenerations,
  makeGenerationPage,
} from './fixtures'
import { StudioProviders, storyMediaActions } from './StudioProviders'

const fetchHistory = fakeFetchGenerationsPage(historyGenerations)
const firstPage = makeGenerationPage(historyGenerations.slice(0, 12), 'studio-history:12')

const meta: Meta<typeof StudioHistoryScreen> = {
  title: 'Studio/StudioHistoryScreen',
  component: StudioHistoryScreen,
  decorators: [
    (Story) => <StudioProviders><div className="min-h-screen"><Story /></div></StudioProviders>,
  ],
  args: {
    fetchPage: fetchHistory,
    initialPage: firstPage,
    onBack: () => console.log('back'),
    actions: storyMediaActions,
  },
}

export default meta
type Story = StoryObj<typeof StudioHistoryScreen>

export const Populated: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Search prompt text, switch the media filter, and scroll past the first 12 rows to exercise the real in-memory paging port.',
      },
    },
  },
}

export const SelectMode: Story = {
  name: 'Select mode (interactive)',
  parameters: {
    docs: {
      description: {
        story: 'Select mode is internal by design. Hover a tile and click its circle to enter; select more tiles to exercise the batch toolbar. This repository has no existing Storybook play-function convention, so the story keeps the interaction manual.',
      },
    },
  },
}

export const Empty: Story = {
  args: {
    fetchPage: fakeFetchGenerationsPage([]),
    initialPage: makeGenerationPage([]),
  },
  parameters: {
    docs: {
      description: {
        story: 'The unfiltered empty-library state. Reach the no-matches state from Populated by searching for a phrase absent from the prompts.',
      },
    },
  },
}

export const LoadError: Story = {
  name: 'Load error',
  args: {
    initialPage: undefined,
    fetchPage: async () => { throw new Error('Fixture history endpoint unavailable') },
  },
}
