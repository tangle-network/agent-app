import type { Meta, StoryObj } from '@storybook/react'
import { GenerationCard } from '../../studio-react'
import {
  avatarGeneration,
  failedGeneration,
  queuedGeneration,
  runningGeneration,
  speechGeneration,
  storyboardGeneration,
  teaserA,
  transcriptionGeneration,
  videoGeneration,
} from './fixtures'

const meta: Meta<typeof GenerationCard> = {
  title: 'Studio/GenerationCard',
  component: GenerationCard,
  decorators: [
    (Story) => (
      <div className="w-[340px] p-4">
        <Story />
      </div>
    ),
  ],
  args: {
    generation: teaserA,
    onSelect: (generation) => console.log('onSelect', generation.id),
  },
}

export default meta
type Story = StoryObj<typeof GenerationCard>

export const Succeeded: Story = {}

/** Pending rows render the shimmer placeholder plus the warning badge. */
export const Queued: Story = {
  args: { generation: queuedGeneration },
}

export const Running: Story = {
  args: { generation: runningGeneration },
}

/** Failed rows add the provider error line under the prompt. */
export const Failed: Story = {
  args: { generation: failedGeneration },
}

/** Every media tile variant and status side by side. */
export const AllStates: Story = {
  name: 'All types & statuses',
  // Two-column tile grid — left-anchored so it can never clip.
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="w-[720px] p-4">
        <Story />
      </div>
    ),
  ],
  render: () => (
    <div className="grid grid-cols-2 gap-3">
      {[
        teaserA,
        videoGeneration,
        speechGeneration,
        transcriptionGeneration,
        avatarGeneration,
        storyboardGeneration,
        queuedGeneration,
        runningGeneration,
        failedGeneration,
      ].map((generation) => (
        <GenerationCard
          key={generation.id}
          generation={generation}
          onSelect={(selected) => console.log('onSelect', selected.id)}
        />
      ))}
    </div>
  ),
}
