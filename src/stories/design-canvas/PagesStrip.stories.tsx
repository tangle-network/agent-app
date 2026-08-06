import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { PagesStrip } from '../../design-canvas-react'
import type { PagesStripProps } from '../../design-canvas-react'
import { makeMultiPageScene, renderFakeThumbnail, renderPendingThumbnail } from './fixtures'

/**
 * Horizontal page-thumbnail strip. Thumbnails come from the host's
 * `renderThumbnail`; these stories use a deterministic SVG fake (and a
 * never-resolving one for the placeholder state). The full editor stories
 * exercise the real Konva thumbnail renderer.
 */
const meta: Meta<typeof PagesStrip> = {
  title: 'Design Canvas/PagesStrip',
  component: PagesStrip,
  decorators: [
    (Story) => (
      <div className="w-[640px] rounded-md border border-[var(--border-default)]">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof PagesStrip>

const pages = makeMultiPageScene().pages

function baseProps(overrides: Partial<PagesStripProps> = {}): PagesStripProps {
  return {
    pages,
    activePageId: pages[1]?.id ?? pages[0]!.id,
    canWrite: true,
    renderThumbnail: renderFakeThumbnail,
    onSelectPage: (pageId) => console.log('[pages story] select', pageId),
    onAddPage: () => console.log('[pages story] add page'),
    onDuplicatePage: (pageId) => console.log('[pages story] duplicate', pageId),
    onDeletePage: (pageId) => console.log('[pages story] delete', pageId),
    onReorderPage: (pageId, toIndex) => console.log('[pages story] reorder', pageId, toIndex),
    ...overrides,
  }
}

/** One page — the delete affordance disables and reorder is meaningless. */
export const SinglePage: Story = {
  name: 'Single page',
  render: () => <PagesStrip {...baseProps({ pages: pages.slice(0, 1), activePageId: pages[0]!.id })} />,
}

/** Three aspect ratios (square / story / banner), middle page active. */
export const MultiPage: Story = {
  name: 'Multi page',
  render: () => <PagesStrip {...baseProps()} />,
}

/** Thumbnails still rendering — the strip falls back to page glyphs. */
export const ThumbnailsPending: Story = {
  name: 'Thumbnails pending',
  render: () => <PagesStrip {...baseProps({ renderThumbnail: renderPendingThumbnail })} />,
}

/** View-only host: no add/duplicate/delete, no drag-reorder. */
export const ReadOnly: Story = {
  name: 'Read only',
  render: () => <PagesStrip {...baseProps({ canWrite: false })} />,
}

/** Review surface: pages are navigated, not authored (management affordances hidden). */
export const ManageDisabled: Story = {
  name: 'Manage pages disabled (review)',
  render: () => <PagesStrip {...baseProps({ canManagePages: false })} />,
}

/** Click-to-switch wired to local state. */
export const Interactive: Story = {
  render: function InteractivePages() {
    const [active, setActive] = useState(pages[1]?.id ?? pages[0]!.id)
    return <PagesStrip {...baseProps({ activePageId: active, onSelectPage: setActive })} />
  },
}

/** Every strip state stacked — hover a tile to see duplicate/delete. */
export const AllStates: Story = {
  name: 'All states (composite)',
  decorators: [],
  render: () => (
    <div className="flex w-[640px] flex-col gap-4">
      {[
        { label: 'Multi page', props: baseProps() },
        { label: 'Single page', props: baseProps({ pages: pages.slice(0, 1), activePageId: pages[0]!.id }) },
        { label: 'Thumbnails pending', props: baseProps({ renderThumbnail: renderPendingThumbnail }) },
        { label: 'Read only', props: baseProps({ canWrite: false }) },
        { label: 'Manage disabled (review)', props: baseProps({ canManagePages: false }) },
      ].map((row) => (
        <div key={row.label} className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{row.label}</span>
          <div className="rounded-md border border-[var(--border-default)]">
            <PagesStrip {...row.props} />
          </div>
        </div>
      ))}
    </div>
  ),
}
