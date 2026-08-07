import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { formatTimecode } from '../../sequences/model'
import { TimelineRuler } from '../../sequences-react'

const meta: Meta<typeof TimelineRuler> = {
  title: 'Sequences/TimelineRuler',
  component: TimelineRuler,
}

export default meta
type Story = StoryObj<typeof TimelineRuler>

/** 600 frames at zoom 1 = 600px wide — one click or drag scrubs. */
export const FitZoom: Story = {
  name: 'Fit Zoom (1 px/frame)',
  render: () => (
    <div className="w-[600px] overflow-hidden rounded-t-md border border-[var(--border-default)]">
      <TimelineRuler fps={30} durationFrames={600} zoom={1} onScrub={(frame) => console.log('onScrub', frame)} />
    </div>
  ),
}

/** Zoom 4: major ticks spread out, minor ticks appear. Scrolls horizontally. */
export const ZoomedIn: Story = {
  name: 'Zoomed In (4 px/frame)',
  render: () => (
    <div className="w-[720px] overflow-x-auto rounded-t-md border border-[var(--border-default)]">
      <TimelineRuler fps={30} durationFrames={600} zoom={4} onScrub={(frame) => console.log('onScrub', frame)} />
    </div>
  ),
}

/** Click/drag the ruler — the readout tracks the scrubbed frame. */
export const InteractiveScrub: Story = {
  name: 'Interactive Scrub',
  render: () => {
    const [frame, setFrame] = useState(0)
    return (
      <div className="w-[600px]">
        <div className="overflow-hidden rounded-t-md border border-[var(--border-default)]">
          <TimelineRuler fps={30} durationFrames={600} zoom={1} onScrub={setFrame} />
        </div>
        <p className="mt-2 font-mono text-xs text-[var(--text-secondary)]">
          frame {frame} · {formatTimecode(frame, 30)}
        </p>
      </div>
    )
  },
}

/** Tick density adapts to zoom: the same 20s ruler at three magnifications. */
export const ZoomLadder: Story = {
  name: 'Zoom Ladder',
  render: () => (
    <div className="flex w-[720px] flex-col gap-4">
      {[
        { zoom: 0.5, label: 'zoom 0.5 — whole cut compressed' },
        { zoom: 1, label: 'zoom 1 — fit' },
        { zoom: 4, label: 'zoom 4 — frame work' },
      ].map(({ zoom, label }) => (
        <div key={zoom}>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-muted)]">{label}</p>
          <div className="overflow-x-auto rounded-t-md border border-[var(--border-default)]">
            <TimelineRuler fps={30} durationFrames={600} zoom={zoom} onScrub={(frame) => console.log('onScrub', frame)} />
          </div>
        </div>
      ))}
    </div>
  ),
}
