import type { Meta, StoryObj } from '@storybook/react'
import { ResultCanvas } from '../../studio-react'
import type { Generation } from '../../studio'
import {
  failedGeneration,
  queuedGeneration,
  runningGeneration,
  teaserA,
  teaserBatch,
} from './fixtures'

const meta: Meta<typeof ResultCanvas> = {
  title: 'Studio/ResultCanvas',
  component: ResultCanvas,
  decorators: [
    (Story) => (
      <div className="w-[640px] p-4">
        <Story />
      </div>
    ),
  ],
  args: {
    batch: [],
    onOpenLibrary: () => console.log('onOpenLibrary'),
    onSelect: (generation) => console.log('onSelect', generation.id),
  },
}

export default meta
type Story = StoryObj<typeof ResultCanvas>

/** Before the first run: the "Your creations appear here" empty card. */
export const Empty: Story = {}

export const SingleResult: Story = {
  name: 'Single result',
  args: { batch: [teaserA] },
}

/** A 4-image run tiles 2-up with the "N results from this run" footer. */
export const Batch: Story = {
  args: { batch: teaserBatch },
}

/** Any pending/running member flips the header to "Generating…" + shimmer. */
export const Generating: Story = {
  args: { batch: [runningGeneration, queuedGeneration] satisfies Generation[] },
}

export const Failed: Story = {
  args: { batch: [failedGeneration] },
}

/** Every run state stacked for a single-glance comparison. */
export const AllStates: Story = {
  name: 'All states',
  render: () => (
    <div className="flex flex-col gap-8">
      {(
        [
          ['Empty', []],
          ['Single result', [teaserA]],
          ['Batch of four', teaserBatch],
          ['Generating…', [runningGeneration, queuedGeneration]],
          ['Last run failed', [failedGeneration]],
        ] as Array<[string, Generation[]]>
      ).map(([label, batch]) => (
        <section key={label}>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">{label}</p>
          <ResultCanvas
            batch={batch}
            onOpenLibrary={() => console.log('onOpenLibrary')}
            onSelect={(generation) => console.log('onSelect', generation.id)}
          />
        </section>
      ))}
    </div>
  ),
}
