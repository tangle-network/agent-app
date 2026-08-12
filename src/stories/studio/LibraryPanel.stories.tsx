import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { LibraryPanel } from '../../studio-react'
import type { Generation } from '../../studio'
import { libraryGenerations, libraryTotalCost } from './fixtures'

/** The panel's type tabs are controlled — wire them to local state so the
 *  filter actually filters. */
function PanelDemo({ generations }: { generations: Generation[] }) {
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  return (
    <LibraryPanel
      generations={generations}
      totalCost={libraryTotalCost}
      typeFilter={typeFilter}
      onFilterChange={setTypeFilter}
      onSelect={(generation) => console.log('onSelect', generation.id)}
    />
  )
}

const meta: Meta<typeof LibraryPanel> = {
  title: 'Studio/LibraryPanel',
  component: LibraryPanel,
  decorators: [
    (Story) => (
      <div className="w-[720px] p-4">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof LibraryPanel>

export const Populated: Story = {
  render: () => <PanelDemo generations={libraryGenerations} />,
}

export const Empty: Story = {
  render: () => <PanelDemo generations={[]} />,
}

export const PopulatedVsEmpty: Story = {
  name: 'Populated vs empty',
  render: () => (
    <div className="flex flex-col gap-10">
      <section>
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">Populated</p>
        <PanelDemo generations={libraryGenerations} />
      </section>
      <section>
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">Empty</p>
        <PanelDemo generations={[]} />
      </section>
    </div>
  ),
}
