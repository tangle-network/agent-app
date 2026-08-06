import type { Meta, StoryObj } from '@storybook/react'
import { StudioHeader } from '../../studio-react'

const meta: Meta<typeof StudioHeader> = {
  title: 'Studio/StudioHeader',
  component: StudioHeader,
  parameters: { layout: 'fullscreen' },
  args: {
    count: 0,
    canGenerate: true,
    onOpenLibrary: () => console.log('onOpenLibrary'),
  },
}

export default meta
type Story = StoryObj<typeof StudioHeader>

export const CanGenerate: Story = {
  name: 'Can generate',
}

/** Viewers get the browse-only subline. */
export const Viewer: Story = {
  args: { canGenerate: false, count: 10 },
}

/** A nonzero count adds the badge to the Library button. */
export const WithCount: Story = {
  name: 'With count',
  args: { count: 12 },
}

export const AllStates: Story = {
  name: 'All states',
  render: () => (
    <div className="flex flex-col gap-6 bg-background">
      <StudioHeader count={0} canGenerate onOpenLibrary={() => console.log('onOpenLibrary')} />
      <StudioHeader count={12} canGenerate onOpenLibrary={() => console.log('onOpenLibrary')} />
      <StudioHeader count={10} canGenerate={false} onOpenLibrary={() => console.log('onOpenLibrary')} />
    </div>
  ),
}
