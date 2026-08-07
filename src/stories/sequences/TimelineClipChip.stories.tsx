import type { Meta, StoryObj } from '@storybook/react'
import type { SequenceClip, SequenceTrack } from '../../sequences'
import { TimelineClipChip } from '../../sequences-react'
import { clipOf, makeAudioClip, makePlaygroundReelTimeline, makeSolidFrameProvider, trackOf } from './fixtures'

const meta: Meta<typeof TimelineClipChip> = {
  title: 'Sequences/TimelineClipChip',
  component: TimelineClipChip,
}

export default meta
type Story = StoryObj<typeof TimelineClipChip>

const frameProvider = makeSolidFrameProvider()
const reel = makePlaygroundReelTimeline()
const videoTrack = trackOf(reel, 'track-video')
const captionTrack = trackOf(reel, 'track-caption')
const audioTrack: SequenceTrack = {
  id: 'track-music',
  kind: 'audio',
  name: 'Music',
  sortOrder: 2,
  locked: false,
  muted: false,
  metadata: {},
}

interface ChipSpec {
  clip: SequenceClip
  track: SequenceTrack
  selected?: boolean
  canWrite?: boolean
}

/**
 * Chips are absolutely positioned inside a track lane, so each story renders
 * its chip in a minimal lane with the matching lane height (video h-16,
 * audio h-14, caption h-9). All callbacks log to the console; snapping passes
 * through unchanged.
 */
function Chip({ spec }: { spec: ChipSpec }) {
  return (
    <TimelineClipChip
      clip={spec.clip}
      track={spec.track}
      fps={30}
      zoom={1}
      sequenceDurationFrames={600}
      selected={spec.selected ?? false}
      canWrite={spec.canWrite ?? true}
      tabbable={false}
      frameProvider={frameProvider}
      snapMove={(candidate) => ({ startFrame: candidate.startFrame, point: null })}
      snapEdge={(candidate) => ({ frame: candidate.frame, point: null })}
      onSnapPointChange={() => {}}
      onSelect={(clipId, additive) => console.log('onSelect', clipId, { additive })}
      onRequestDelete={(clipId) => console.log('onRequestDelete', clipId)}
      onFocusStep={(clipId, direction) => console.log('onFocusStep', clipId, direction)}
      onCommitMove={(input) => console.log('onCommitMove', input)}
      onCommitTrim={(input) => console.log('onCommitTrim', input)}
      onCommitText={(input) => console.log('onCommitText', input)}
    />
  )
}

function Lane(props: { height: string; children: React.ReactNode }) {
  return (
    <div className={`relative w-[620px] overflow-hidden rounded-md border border-[var(--border-default)] bg-[var(--bg-input)] ${props.height}`}>
      {props.children}
    </div>
  )
}

/** Video clip at rest: poster canvas (solid provider), label, duration badge. */
export const Normal: Story = {
  render: () => (
    <Lane height="h-16">
      <Chip spec={{ clip: clipOf(reel, 'clip-demo'), track: videoTrack }} />
    </Lane>
  ),
}

export const Selected: Story = {
  render: () => (
    <Lane height="h-16">
      <Chip spec={{ clip: clipOf(reel, 'clip-demo'), track: videoTrack, selected: true }} />
    </Lane>
  ),
}

/** Disabled clip: 40% opacity, still selectable. */
export const Disabled: Story = {
  render: () => {
    const base = clipOf(reel, 'clip-demo')
    return (
      <Lane height="h-16">
        <Chip spec={{ clip: { ...base, id: 'clip-disabled', disabled: true }, track: videoTrack }} />
      </Lane>
    )
  },
}

/** Locked track: no trim handles, no grab cursor — same paint. */
export const LockedTrack: Story = {
  name: 'Locked Track',
  render: () => (
    <Lane height="h-16">
      <Chip spec={{ clip: clipOf(reel, 'clip-demo'), track: { ...videoTrack, locked: true } }} />
    </Lane>
  ),
}

/** canWrite=false on an unlocked track renders the same inert state. */
export const ReadOnly: Story = {
  name: 'Read Only (canWrite=false)',
  render: () => (
    <Lane height="h-16">
      <Chip spec={{ clip: clipOf(reel, 'clip-demo'), track: videoTrack, canWrite: false }} />
    </Lane>
  ),
}

/** Caption chip: amber tone, shows the caption text instead of the label. */
export const CaptionClip: Story = {
  name: 'Caption Clip',
  render: () => (
    <Lane height="h-9">
      <Chip spec={{ clip: clipOf(reel, 'cap-2'), track: captionTrack }} />
    </Lane>
  ),
}

/** Audio chip: emerald tone; the waveform canvas stays empty offline. */
export const AudioClip: Story = {
  name: 'Audio Clip',
  render: () => (
    <Lane height="h-14">
      <Chip spec={{ clip: makeAudioClip(), track: audioTrack }} />
    </Lane>
  ),
}

/** 24 frames at zoom 1 = 24px — the label collapses to the timecode badge. */
export const NarrowClip: Story = {
  name: 'Narrow Clip',
  render: () => {
    const base = clipOf(reel, 'clip-demo')
    return (
      <Lane height="h-16">
        <Chip spec={{ clip: { ...base, id: 'clip-narrow', startFrame: 40, durationFrames: 24 }, track: videoTrack }} />
      </Lane>
    )
  },
}

/** Every chip state side by side — the at-a-glance comparison. */
export const AllStates: Story = {
  name: 'All States',
  render: () => {
    const demo = clipOf(reel, 'clip-demo')
    const rows: Array<{ label: string; height: string; spec: ChipSpec }> = [
      { label: 'normal', height: 'h-16', spec: { clip: demo, track: videoTrack } },
      { label: 'selected', height: 'h-16', spec: { clip: demo, track: videoTrack, selected: true } },
      { label: 'disabled', height: 'h-16', spec: { clip: { ...demo, id: 'c-disabled', disabled: true }, track: videoTrack } },
      { label: 'locked track', height: 'h-16', spec: { clip: demo, track: { ...videoTrack, locked: true } } },
      { label: 'read only', height: 'h-16', spec: { clip: demo, track: videoTrack, canWrite: false } },
      { label: 'caption', height: 'h-9', spec: { clip: clipOf(reel, 'cap-2'), track: captionTrack } },
      { label: 'audio', height: 'h-14', spec: { clip: makeAudioClip(), track: audioTrack } },
      {
        label: 'narrow (24f)',
        height: 'h-16',
        spec: { clip: { ...demo, id: 'c-narrow', startFrame: 40, durationFrames: 24 }, track: videoTrack },
      },
    ]
    return (
      <div className="flex flex-col gap-3">
        {rows.map(({ label, height, spec }) => (
          <div key={label}>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-muted)]">{label}</p>
            <Lane height={height}>
              <Chip spec={spec} />
            </Lane>
          </div>
        ))}
      </div>
    )
  },
}
