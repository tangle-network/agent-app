import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { MemoryRouter } from 'react-router'
import { LibraryDrawer } from '../../studio-react'
import type { Generation } from '../../studio'
import {
  demoVaultHref,
  libraryGenerations,
  libraryTotalCost,
  teaserA,
} from './fixtures'

/**
 * The drawer is a Radix sheet that portals over the page; it opens on mount
 * and every piece of its controlled state (open, filter, selection) lives
 * locally. Closing it leaves the page stub with a reopen button. A router is
 * required for the Vault / "Open in Vault" Links.
 */
function DrawerDemo({
  generations,
  initialSelected = null,
}: {
  generations: Generation[]
  initialSelected?: Generation | null
}) {
  const [open, setOpen] = useState(true)
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  const [selected, setSelected] = useState<Generation | null>(initialSelected)
  return (
    <MemoryRouter>
      <div className="flex h-64 items-center justify-center">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground"
        >
          Open library
        </button>
      </div>
      <LibraryDrawer
        open={open}
        onOpenChange={(next) => {
          console.log('onOpenChange', next)
          setOpen(next)
          if (!next) setSelected(null)
        }}
        generations={generations}
        totalCost={libraryTotalCost}
        typeFilter={typeFilter}
        onFilterChange={setTypeFilter}
        vaultHref={demoVaultHref}
        selected={selected}
        onSelect={(generation) => {
          console.log('onSelect', generation?.id ?? null)
          setSelected(generation)
        }}
      />
    </MemoryRouter>
  )
}

const meta: Meta<typeof LibraryDrawer> = {
  title: 'Studio/LibraryDrawer',
  component: LibraryDrawer,
  parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj<typeof LibraryDrawer>

/** List view: stats row, Vault button, type tabs, card grid. */
export const OpenPopulated: Story = {
  name: 'Open — populated',
  render: () => <DrawerDemo generations={libraryGenerations} />,
}

export const OpenEmpty: Story = {
  name: 'Open — empty',
  render: () => <DrawerDemo generations={[]} />,
}

/** Detail view: back button replaces the title, GenerationDetail fills the body. */
export const OpenWithSelected: Story = {
  name: 'Open — with selection',
  render: () => <DrawerDemo generations={libraryGenerations} initialSelected={teaserA} />,
}
