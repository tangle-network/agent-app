import type { Meta, StoryObj } from '@storybook/react'
import { TimelineGhostLanes, TimelineRuler } from '../../sequences-react'

const meta: Meta<typeof TimelineGhostLanes> = {
  title: 'Sequences/TimelineGhostLanes',
  component: TimelineGhostLanes,
}

export default meta
type Story = StoryObj<typeof TimelineGhostLanes>

/** Ghost lanes are `absolute inset-0`, so every story gives them a bordered,
 *  relatively-positioned track area to fill. */
function Area(props: { width: string; height: string; children: React.ReactNode }) {
  return (
    <div
      className={`relative overflow-hidden rounded-md border border-[var(--border-default)] bg-[var(--bg-input)] ${props.width} ${props.height}`}
    >
      {props.children}
    </div>
  )
}

export const Default: Story = {
  render: () => (
    <Area width="w-[744px]" height="h-36">
      <TimelineGhostLanes laneWidth={600} videoLabel="Video" captionLabel="Captions" />
    </Area>
  ),
}

/** Hosts can rename the lanes through TimelineEditorLabels. */
export const CustomLabels: Story = {
  name: 'Custom Labels',
  render: () => (
    <Area width="w-[744px]" height="h-36">
      <TimelineGhostLanes laneWidth={600} videoLabel="Footage" captionLabel="Subtitles" />
    </Area>
  ),
}

/** laneWidth tracks durationFrames × zoom so the lanes line up under the ruler. */
export const WideTimeline: Story = {
  name: 'Wide Timeline (scrolled)',
  render: () => (
    <div className="w-[744px] overflow-x-auto rounded-md border border-[var(--border-default)]">
      <Area width="w-[2400px]" height="h-36">
        <TimelineGhostLanes laneWidth={2400} videoLabel="Video" captionLabel="Captions" />
      </Area>
    </div>
  ),
}

/** In the editor the ghost lanes sit behind the empty state, under the ruler —
 *  this composite mirrors that stack so spacing can be judged in place. */
export const BehindRuler: Story = {
  name: 'In Context — Ruler + Ghost Lanes',
  render: () => (
    <div className="w-[744px] overflow-hidden rounded-md border border-[var(--border-default)] bg-[var(--bg-input)]">
      <div className="flex">
        <div className="w-36 shrink-0 border-b border-r border-[var(--border-default)]" />
        <TimelineRuler fps={30} durationFrames={600} zoom={1} onScrub={(frame) => console.log('onScrub', frame)} />
      </div>
      <div className="relative h-36">
        <TimelineGhostLanes laneWidth={600} videoLabel="Video" captionLabel="Captions" />
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-xs text-[var(--text-muted)]">empty state renders here</p>
        </div>
      </div>
    </div>
  ),
}
