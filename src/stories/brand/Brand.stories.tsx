import type { Meta, StoryObj } from '@storybook/react'
import { BrandHeader, Logo, TangleKnot } from '../../brand'

const meta: Meta<typeof Logo> = {
  title: 'Brand/Logo',
  component: Logo,
  parameters: { layout: 'centered' },
}

export default meta
type Story = StoryObj<typeof Logo>

export const Default: Story = {
  args: { size: 'md' },
}

export const SizeSm: Story = {
  name: 'Size sm',
  args: { size: 'sm' },
}

export const SizeLg: Story = {
  name: 'Size lg',
  args: { size: 'lg' },
}

export const SizeXl: Story = {
  name: 'Size xl',
  args: { size: 'xl' },
}

export const IconOnly: Story = {
  name: 'Icon Only',
  args: { size: 'md', iconOnly: true },
}

export const KnotSizes: Story = {
  name: 'TangleKnot — All Sizes',
  render: () => (
    <div className="flex items-end gap-6 text-foreground">
      <TangleKnot size={24} />
      <TangleKnot size={28} />
      <TangleKnot size={36} />
      <TangleKnot size={48} />
    </div>
  ),
}

export const Header: Story = {
  name: 'BrandHeader',
  parameters: { layout: 'fullscreen' },
  render: () => (
    <BrandHeader title="Launch Poster">
      <button className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
        Sessions
      </button>
      <button className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
        Approvals
      </button>
    </BrandHeader>
  ),
}

/** Every brand surface together — the visual smoke check for the theme tokens. */
export const All: Story = {
  name: 'All',
  render: () => (
    <div className="flex w-[640px] flex-col items-start gap-8">
      <BrandHeader title="Launch Poster" className="w-full rounded-lg border border-border">
        <button className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
          Approvals
        </button>
      </BrandHeader>
      <div className="flex flex-col gap-4 text-foreground">
        <Logo size="sm" />
        <Logo size="md" />
        <Logo size="lg" />
        <Logo size="xl" />
      </div>
      <div className="flex items-end gap-6">
        <TangleKnot size={24} />
        <TangleKnot size={36} />
        <TangleKnot size={48} />
      </div>
    </div>
  ),
}
