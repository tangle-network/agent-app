import type { Meta, StoryObj } from '@storybook/react'
import { MemoryRouter } from 'react-router'
import { GenerationDetail } from '../../studio-react'
import type { Generation } from '../../studio'
import {
  demoVaultHref,
  failedGeneration,
  storageFailedGeneration,
  teaserA,
  transcriptionGeneration,
  videoGeneration,
} from './fixtures'

// GenerationDetail renders a react-router `Link` for "Open in Vault".
const meta: Meta<typeof GenerationDetail> = {
  title: 'Studio/GenerationDetail',
  component: GenerationDetail,
  decorators: [
    (Story) => (
      <MemoryRouter>
        <div className="w-[640px] p-4">
          <Story />
        </div>
      </MemoryRouter>
    ),
  ],
  args: {
    generation: teaserA,
    vaultHref: demoVaultHref,
    onNavigate: () => console.log('onNavigate'),
  },
}

export default meta
type Story = StoryObj<typeof GenerationDetail>

/** Succeeded image with a vault path — the "Open in Vault" button shows. */
export const ImageSucceeded: Story = {
  name: 'Image — succeeded',
}

export const VideoSucceeded: Story = {
  name: 'Video — succeeded',
  args: { generation: videoGeneration },
}

/** Transcriptions render their result as a scrollable pre block. */
export const Transcription: Story = {
  args: { generation: transcriptionGeneration },
}

/** No result, no vault path — error text instead of the vault button. */
export const Failed: Story = {
  args: { generation: failedGeneration },
}

/** Media generated but never persisted: storage error, no vault button. */
export const StorageFailed: Story = {
  name: 'Storage failed',
  args: { generation: storageFailedGeneration },
}

export const AllStates: Story = {
  name: 'All states',
  render: () => (
    <div className="flex flex-col gap-10">
      {(
        [
          ['Image — succeeded', teaserA],
          ['Video — succeeded', videoGeneration],
          ['Transcription', transcriptionGeneration],
          ['Failed', failedGeneration],
          ['Storage failed', storageFailedGeneration],
        ] as Array<[string, Generation]>
      ).map(([label, generation]) => (
        <section key={label} className="border-b border-border pb-8 last:border-b-0">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
          <GenerationDetail
            generation={generation}
            vaultHref={demoVaultHref}
            onNavigate={() => console.log('onNavigate')}
          />
        </section>
      ))}
    </div>
  ),
}
