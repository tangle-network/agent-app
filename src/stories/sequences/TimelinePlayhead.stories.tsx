import type { Meta, StoryObj } from '@storybook/react'
import { TimelinePlayhead } from '../../sequences-react'

const meta: Meta<typeof TimelinePlayhead> = {
  title: 'Sequences/TimelinePlayhead',
  component: TimelinePlayhead,
}

export default meta
type Story = StoryObj<typeof TimelinePlayhead>

/** Mock track area: two lane bands so the playhead reads in context. The
 *  playhead positions itself absolutely at frame * zoom. */
function TrackArea(props: { frame: number; zoom: number }) {
  return (
    <div className="relative h-32 w-[620px] overflow-hidden rounded-md border border-[var(--border-default)] bg-[var(--bg-input)]">
      <div className="h-16 border-b border-[var(--border-default)]" />
      <div className="h-9 border-b border-[var(--border-default)]" />
      <TimelinePlayhead frame={props.frame} zoom={props.zoom} />
    </div>
  )
}

export const AtStart: Story = {
  name: 'At Start (frame 0)',
  render: () => <TrackArea frame={0} zoom={1} />,
}

export const MidSequence: Story = {
  name: 'Mid Sequence (frame 150)',
  render: () => <TrackArea frame={150} zoom={1} />,
}

/** frame 90 at zoom 4 = 360px in — the glow line + cap scale with the zoom. */
export const ZoomedIn: Story = {
  name: 'Zoomed In (frame 90 @ 4px/frame)',
  render: () => <TrackArea frame={90} zoom={4} />,
}

/** Positions side by side: start, middle, and the final addressable frame. */
export const Positions: Story = {
  name: 'All Positions',
  render: () => (
    <div className="flex flex-col gap-4">
      {[
        { frame: 0, label: 'frame 0' },
        { frame: 150, label: 'frame 150' },
        { frame: 599, label: 'frame 599 (sequence end)' },
      ].map(({ frame, label }) => (
        <div key={frame}>
          <p className="mb-1 text-xs font-semibold uppercase tracking-[0.05em] text-[var(--text-muted)]">{label}</p>
          <TrackArea frame={frame} zoom={1} />
        </div>
      ))}
    </div>
  ),
}
