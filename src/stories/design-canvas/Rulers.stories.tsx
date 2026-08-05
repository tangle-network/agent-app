import type { Meta, StoryObj } from '@storybook/react'
import { Rulers } from '../../design-canvas-react'
import type { RulersProps } from '../../design-canvas-react'
import { makeLaunchPosterScene } from './fixtures'

/**
 * Zoom-scaled canvas rulers with saved-guide rendering. Pure DOM (no Konva) —
 * they position absolutely against the workspace corner, so each story wraps
 * them in a relative box standing in for the canvas viewport. Drag out of a
 * ruler to create a guide; drag a guide back in to delete it.
 */
const meta: Meta<typeof Rulers> = {
  title: 'Design Canvas/Rulers',
  component: Rulers,
}

export default meta
type Story = StoryObj<typeof Rulers>

const posterPage = makeLaunchPosterScene().pages[0]!

function RulerFrame({ label, ...props }: RulersProps & { label: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{label}</span>
      {/* Inline style for the frame size: the rulers are absolutely positioned,
          so a collapsed wrapper hides them entirely — don't rely on a utility
          class being present in the preview's stylesheet. */}
      <div
        className="relative overflow-hidden rounded-md border border-[var(--border-default)] bg-[var(--canvas-backdrop)]"
        style={{ height: 320, width: 560 }}
      >
        <Rulers {...props} />
      </div>
    </div>
  )
}

const onGuidesChange = (guides: { vertical: number[]; horizontal: number[] }) =>
  console.log('[rulers story] guides', guides)

/** 1080×1080 page at 100% — ticks every 100 doc px. */
export const AtFullZoom: Story = {
  name: 'Zoom 100%',
  render: () => (
    <RulerFrame
      label="Zoom 100%"
      pageWidth={posterPage.width}
      pageHeight={posterPage.height}
      zoom={1}
      scrollLeft={0}
      scrollTop={0}
      showRulers
      guides={{ vertical: [], horizontal: [] }}
      onGuidesChange={onGuidesChange}
    />
  ),
}

/** Zoomed to 50% and scrolled — tick density adapts, labels stay legible. */
export const ZoomedAndScrolled: Story = {
  name: 'Zoom 50% + scrolled',
  render: () => (
    <RulerFrame
      label="Zoom 50% + scrolled"
      pageWidth={posterPage.width}
      pageHeight={posterPage.height}
      zoom={0.5}
      scrollLeft={140}
      scrollTop={60}
      showRulers
      guides={{ vertical: [], horizontal: [] }}
      onGuidesChange={onGuidesChange}
    />
  ),
}

/** Saved center guides from the poster scene render as marker lines. */
export const WithGuides: Story = {
  name: 'With saved guides',
  render: () => (
    <RulerFrame
      label="With saved guides"
      pageWidth={posterPage.width}
      pageHeight={posterPage.height}
      zoom={0.5}
      scrollLeft={0}
      scrollTop={0}
      showRulers
      guides={posterPage.guides}
      onGuidesChange={onGuidesChange}
    />
  ),
}

/** Hidden rulers render nothing — the workspace grid cell collapses. */
export const Hidden: Story = {
  render: () => (
    <RulerFrame
      label="Hidden (renders null)"
      pageWidth={posterPage.width}
      pageHeight={posterPage.height}
      zoom={1}
      scrollLeft={0}
      scrollTop={0}
      showRulers={false}
      guides={{ vertical: [], horizontal: [] }}
      onGuidesChange={onGuidesChange}
    />
  ),
}

/** Density + guide states side by side. */
export const AllStates: Story = {
  name: 'All states (composite)',
  render: () => (
    <div className="flex flex-wrap items-start gap-4">
      <RulerFrame
        label="Zoom 100%"
        pageWidth={posterPage.width}
        pageHeight={posterPage.height}
        zoom={1}
        scrollLeft={0}
        scrollTop={0}
        showRulers
        guides={{ vertical: [], horizontal: [] }}
        onGuidesChange={onGuidesChange}
      />
      <RulerFrame
        label="Zoom 50% + guides"
        pageWidth={posterPage.width}
        pageHeight={posterPage.height}
        zoom={0.5}
        scrollLeft={140}
        scrollTop={60}
        showRulers
        guides={posterPage.guides}
        onGuidesChange={onGuidesChange}
      />
    </div>
  ),
}
