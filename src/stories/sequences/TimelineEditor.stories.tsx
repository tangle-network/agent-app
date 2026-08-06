import type { Meta, StoryObj } from '@storybook/react'
import { useMemo, useState } from 'react'
import type { TimelineEditorProps } from '../../sequences-react'
import { SEQUENCE_MEDIA_DRAG_TYPE, TimelineEditor } from '../../sequences-react'
import type { SequenceTimeline } from '../../sequences'
import {
  makeEchoApply,
  makeEmptyTimeline,
  makePlaygroundReelTimeline,
  makeSolidFrameProvider,
  makeStudioCutTimeline,
} from './fixtures'

const meta: Meta<typeof TimelineEditor> = {
  title: 'Sequences/TimelineEditor',
  component: TimelineEditor,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div className="h-screen">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof TimelineEditor>

/**
 * Mounts the editor the way the playground timeline route does: fixed
 * timeline in state, solid-color frame provider (no media decode), and an
 * `onApplyOperations` that echoes index-aligned results so optimistic edits
 * reconcile cleanly. Interactive: drag/trim clips, scrub the ruler, space to
 * play, mod+z / shift+mod+z for undo/redo.
 */
function StoryEditor(props: Omit<TimelineEditorProps, 'frameProvider' | 'onApplyOperations'>) {
  const frameProvider = useMemo(() => makeSolidFrameProvider(), [])
  const onApplyOperations = useMemo(() => makeEchoApply(props.timeline), [props.timeline])
  return (
    <TimelineEditor
      {...props}
      frameProvider={frameProvider}
      onApplyOperations={onApplyOperations}
      onSelectionChange={(clips) => console.log('onSelectionChange', clips.map((clip) => clip.id))}
      onPlayheadChange={(frame) => console.log('onPlayheadChange', frame)}
    />
  )
}

function useTimeline(make: () => SequenceTimeline): SequenceTimeline {
  return useState(make)[0]
}

export const EditorDefault: Story = {
  name: 'Editor — Default (Video + Captions)',
  render: () => {
    const timeline = useTimeline(makePlaygroundReelTimeline)
    return <StoryEditor timeline={timeline} canWrite />
  },
}

/** Six track kinds at once, incl. a locked reference lane and a disabled clip. */
export const EditorPopulated: Story = {
  name: 'Editor — Populated Multi-Track',
  render: () => {
    const timeline = useTimeline(makeStudioCutTimeline)
    return <StoryEditor timeline={timeline} canWrite />
  },
}

/** Zero tracks: ghost lanes keep time legible behind the three empty-state doors. */
export const EditorEmpty: Story = {
  name: 'Editor — Empty (Ghost Lanes + Doors)',
  render: () => {
    const timeline = useTimeline(makeEmptyTimeline)
    return (
      <StoryEditor
        timeline={timeline}
        canWrite
        onStartFromTemplate={() => console.log('onStartFromTemplate')}
        onAddClip={() => console.log('onAddClip')}
        onAskAgent={() => console.log('onAskAgent')}
      />
    )
  },
}

/** Read-only: no edit tools, no trim handles, no export affordance. */
export const EditorReadOnly: Story = {
  name: 'Editor — Read Only',
  render: () => {
    const timeline = useTimeline(makePlaygroundReelTimeline)
    return <StoryEditor timeline={timeline} canWrite={false} />
  },
}

/** Host seams filled: draggable asset shelf, selection side panel, export button. */
export const EditorWithHostPanels: Story = {
  name: 'Editor — Host Shelf + Side Panel + Export',
  render: () => {
    const timeline = useTimeline(makePlaygroundReelTimeline)
    return (
      <StoryEditor
        timeline={timeline}
        canWrite
        onCreateExport={() => console.log('onCreateExport')}
        renderAssetShelf={() => (
          <div className="flex items-center gap-2 px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
              Assets — drag onto a lane
            </span>
            {[
              { label: 'b-roll.mp4', url: 'https://example.com/b-roll.mp4', kind: 'video', durationSeconds: 6 },
              { label: 'logo.png', url: 'https://example.com/logo.png', kind: 'image' },
              { label: 'vo-take.mp3', url: 'https://example.com/vo-take.mp3', kind: 'audio', durationSeconds: 4 },
            ].map((asset) => (
              <button
                key={asset.url}
                type="button"
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(SEQUENCE_MEDIA_DRAG_TYPE, JSON.stringify(asset))
                  event.dataTransfer.effectAllowed = 'copy'
                }}
                onClick={() => console.log('asset clicked', asset.label)}
                className="cursor-grab rounded border border-[var(--border-default)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                {asset.label}
              </button>
            ))}
          </div>
        )}
        renderSidePanel={({ selectedClips, playheadFrame }) => (
          <div className="flex h-full flex-col gap-3 p-3 text-xs text-[var(--text-secondary)]">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">Inspector</p>
              <p className="mt-1 font-mono">playhead: frame {playheadFrame}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
                Selection ({selectedClips.length})
              </p>
              {selectedClips.length === 0 ? (
                <p className="mt-1 text-[var(--text-muted)]">Click a clip to inspect it.</p>
              ) : (
                <ul className="mt-1 flex flex-col gap-1">
                  {selectedClips.map((clip) => (
                    <li key={clip.id} className="rounded border border-[var(--border-default)] px-2 py-1">
                      <span className="font-medium text-[var(--text-primary)]">{clip.label}</span>
                      <span className="ml-2 font-mono text-[var(--text-muted)]">
                        f{clip.startFrame}–{clip.startFrame + clip.durationFrames}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      />
    )
  },
}
