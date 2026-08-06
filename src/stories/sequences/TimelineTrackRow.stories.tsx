import type { Meta, StoryObj } from '@storybook/react'
import type { SequenceClip, SequenceTrack } from '../../sequences'
import { TimelineTrackRow } from '../../sequences-react'
import { clipsOf, makeAudioClip, makePlaygroundReelTimeline, makeSolidFrameProvider, trackOf } from './fixtures'

const meta: Meta<typeof TimelineTrackRow> = {
  title: 'Sequences/TimelineTrackRow',
  component: TimelineTrackRow,
  decorators: [
    (Story) => (
      <div className="w-[780px] overflow-x-auto rounded-md border border-[var(--border-default)] bg-[var(--bg-input)]">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof TimelineTrackRow>

const frameProvider = makeSolidFrameProvider()
const reel = makePlaygroundReelTimeline()
const videoTrack = trackOf(reel, 'track-video')
const captionTrack = trackOf(reel, 'track-caption')

/** Row with every callback wired to the console; snapping passes through
 *  unchanged so drag/trim gestures stay 1:1 with pointer movement. */
function Row(props: { track: SequenceTrack; clips: SequenceClip[]; selected?: string[]; canWrite?: boolean }) {
  return (
    <TimelineTrackRow
      track={props.track}
      clips={props.clips}
      fps={30}
      zoom={1}
      sequenceDurationFrames={600}
      selectedClipIds={new Set(props.selected ?? [])}
      tabbableClipId={null}
      canWrite={props.canWrite ?? true}
      frameProvider={frameProvider}
      snapMove={(candidate) => ({ startFrame: candidate.startFrame, point: null })}
      snapEdge={(candidate) => ({ frame: candidate.frame, point: null })}
      onSnapPointChange={() => {}}
      onSelectClip={(clipId, additive) => console.log('onSelectClip', clipId, { additive })}
      onRequestDeleteClip={(clipId) => console.log('onRequestDeleteClip', clipId)}
      onFocusStepClip={(clipId, direction) => console.log('onFocusStepClip', clipId, direction)}
      onCommitMove={(input) => console.log('onCommitMove', input)}
      onCommitTrim={(input) => console.log('onCommitTrim', input)}
      onCommitText={(input) => console.log('onCommitText', input)}
      onLaneSeek={(frame) => console.log('onLaneSeek', frame)}
    />
  )
}

export const VideoRow: Story = {
  name: 'Video Row',
  render: () => <Row track={videoTrack} clips={clipsOf(reel, 'track-video')} />,
}

export const CaptionRow: Story = {
  name: 'Caption Row',
  render: () => <Row track={captionTrack} clips={clipsOf(reel, 'track-caption')} />,
}

export const AudioRow: Story = {
  name: 'Audio Row',
  render: () => {
    const audioTrack: SequenceTrack = {
      id: 'track-music',
      kind: 'audio',
      name: 'Music',
      sortOrder: 2,
      locked: false,
      muted: false,
      metadata: {},
    }
    return <Row track={audioTrack} clips={[makeAudioClip()]} />
  },
}

/** Lock glyph in the header; chips lose trim handles and the grab cursor. */
export const LockedRow: Story = {
  name: 'Locked Row',
  render: () => <Row track={{ ...videoTrack, locked: true }} clips={clipsOf(reel, 'track-video')} />,
}

/** Mute glyph + 60% lane opacity. */
export const MutedRow: Story = {
  name: 'Muted Row',
  render: () => <Row track={{ ...videoTrack, muted: true }} clips={clipsOf(reel, 'track-video')} />,
}

export const WithSelectedClip: Story = {
  name: 'With Selected Clip',
  render: () => <Row track={videoTrack} clips={clipsOf(reel, 'track-video')} selected={['clip-demo']} />,
}

/** canWrite=false: header stays, chips render inert (no trim handles). */
export const ReadOnlyRow: Story = {
  name: 'Read-Only Row',
  render: () => <Row track={videoTrack} clips={clipsOf(reel, 'track-video')} canWrite={false} />,
}

/** Every row state stacked as a mini track area — the at-a-glance comparison. */
export const AllRows: Story = {
  name: 'All Row States',
  render: () => (
    <div>
      <Row track={videoTrack} clips={clipsOf(reel, 'track-video')} selected={['clip-demo']} />
      <Row track={{ ...videoTrack, id: 'track-b-roll', name: 'B-roll (locked)', locked: true }} clips={[]} />
      <Row
        track={{ id: 'track-music', kind: 'audio', name: 'Music', sortOrder: 3, locked: false, muted: false, metadata: {} }}
        clips={[makeAudioClip()]}
      />
      <Row track={captionTrack} clips={clipsOf(reel, 'track-caption')} />
      <Row track={{ ...captionTrack, id: 'track-muted', name: 'Muted lane', muted: true }} clips={[]} />
    </div>
  ),
}
