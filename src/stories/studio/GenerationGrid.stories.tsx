import type { Meta, StoryObj } from '@storybook/react'
import { GenerationGrid } from '../../studio-react'
import type { Generation } from '../../studio'
import {
  failedGeneration,
  libraryGenerations,
  queuedGeneration,
  runningGeneration,
} from './fixtures'

const meta: Meta<typeof GenerationGrid> = {
  title: 'Studio/GenerationGrid',
  component: GenerationGrid,
  decorators: [
    (Story) => (
      <div className="w-[720px] p-4">
        <Story />
      </div>
    ),
  ],
  args: {
    generations: libraryGenerations,
    typeFilter: null,
    onSelect: (generation) => console.log('onSelect', generation.id),
  },
}

export default meta
type Story = StoryObj<typeof GenerationGrid>

export const Populated: Story = {}

export const Empty: Story = {
  args: { generations: [] },
}

/** A type filter with no matching rows changes the empty-state copy. */
export const EmptyFiltered: Story = {
  name: 'Empty — filtered',
  args: { generations: [], typeFilter: 'video' },
}

/** In-flight runs arrive as pending/running rows — the grid shimmers them. */
export const Loading: Story = {
  args: {
    generations: [runningGeneration, queuedGeneration, failedGeneration] satisfies Generation[],
  },
}

/** The three faces a human needs to compare: content, shimmer, empty. */
export const AllStates: Story = {
  name: 'All states',
  render: () => (
    <div className="flex flex-col gap-8">
      {(
        [
          ['Populated', libraryGenerations, null],
          ['Loading (in-flight)', [runningGeneration, queuedGeneration], null],
          ['Empty — filtered', [], 'video'],
        ] as Array<[string, Generation[], string | null]>
      ).map(([label, generations, typeFilter]) => (
        <section key={label}>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">{label}</p>
          <GenerationGrid
            generations={generations}
            typeFilter={typeFilter}
            onSelect={(generation) => console.log('onSelect', generation.id)}
          />
        </section>
      ))}
    </div>
  ),
}
