import type { Meta, StoryObj } from '@storybook/react'
import { useEffect, useMemo } from 'react'
import type { SequenceTimeline } from '../../sequences'
import type { VideoFrameProvider } from '../../sequences-react'
import { createPlaybackClock, PreviewCanvas } from '../../sequences-react'
import { makePlaygroundReelTimeline, makeSolidFrameProvider } from './fixtures'

const meta: Meta<typeof PreviewCanvas> = {
  title: 'Sequences/PreviewCanvas',
  component: PreviewCanvas,
  decorators: [
    (Story) => (
      <div className="flex h-[480px] w-full max-w-[860px]">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof PreviewCanvas>

/**
 * Standalone monitor mount: a real `PlaybackClock` (the editor's own engine
 * piece) sought to a fixed frame, plus the solid-color provider. The canvas
 * letterboxes to the sequence's 16:9 and paints the topmost active video clip
 * plus any caption bar.
 */
function PreviewAtFrame(props: { timeline: SequenceTimeline; frame: number; provider?: VideoFrameProvider }) {
  const clock = useMemo(
    () =>
      createPlaybackClock({
        fps: props.timeline.sequence.fps,
        durationFrames: props.timeline.sequence.durationFrames,
      }),
    [props.timeline],
  )
  const frameProvider = useMemo(() => props.provider ?? makeSolidFrameProvider(), [props.provider])
  useEffect(() => () => clock.dispose(), [clock])
  useEffect(() => {
    clock.seek(props.frame)
  }, [clock, props.frame])
  return <PreviewCanvas timeline={props.timeline} clock={clock} frameProvider={frameProvider} />
}

/** Frame 100: intro.mp4 active + "Meet the agent playground" caption bar. */
export const WithFrameAndCaption: Story = {
  name: 'With Frame + Caption',
  render: () => <PreviewAtFrame timeline={makePlaygroundReelTimeline()} frame={100} />,
}

/** Frame 435 sits in the 10-frame gap between demo.mp4 and outro.mp4 — black base, no caption. */
export const GapNoMedia: Story = {
  name: 'Gap — No Media at Playhead',
  render: () => <PreviewAtFrame timeline={makePlaygroundReelTimeline()} frame={435} />,
}

/** Frame 500: outro.mp4 active, no caption — solid frame only. */
export const FrameNoCaption: Story = {
  name: 'Frame — No Caption',
  render: () => <PreviewAtFrame timeline={makePlaygroundReelTimeline()} frame={500} />,
}

/** A provider whose drawFrame rejects surfaces the monitor's error bar. */
export const DrawError: Story = {
  name: 'Draw Error',
  render: () => (
    <PreviewAtFrame
      timeline={makePlaygroundReelTimeline()}
      frame={100}
      provider={{
        async drawFrame() {
          throw new Error('decode failed: unsupported codec')
        },
        prefetch() {},
        dispose() {},
      }}
    />
  ),
}

/** The three paint states side by side: caption frame, black gap, plain frame. */
export const AllStates: Story = {
  name: 'All States',
  // Three-column grid up to 1100px wide — left-anchored so it can never clip.
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="w-full max-w-[1100px]">
        <Story />
      </div>
    ),
  ],
  render: () => (
    <div className="grid grid-cols-3 gap-4">
      {[
        { label: 'frame 100 — video + caption', frame: 100 },
        { label: 'frame 435 — gap (black)', frame: 435 },
        { label: 'frame 500 — video only', frame: 500 },
      ].map(({ label, frame }) => (
        <figure key={frame} className="flex flex-col gap-2">
          <div className="flex h-56 overflow-hidden rounded-md border border-[var(--border-default)]">
            <PreviewAtFrame timeline={makePlaygroundReelTimeline()} frame={frame} />
          </div>
          <figcaption className="text-xs text-[var(--text-muted)]">{label}</figcaption>
        </figure>
      ))}
    </div>
  ),
}
