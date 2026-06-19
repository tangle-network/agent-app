// @vitest-environment jsdom
/**
 * Keyboard-editing parity for the timeline editor: clips are keyboard-focusable
 * (roving tabindex) and Delete on a focused chip removes it through the command
 * stack; ArrowLeft/Right step the playhead by whole frames (Shift = larger);
 * Alt+Arrow nudges the selected clip; and a zero-track sequence renders a
 * centered empty state instead of a blank lane area.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SequenceOperation } from '../../src/sequences/operations'
import type { SequenceTimeline } from '../../src/sequences/model'
import { TimelineEditor } from '../../src/sequences-react/components/TimelineEditor'

function fixtureTimeline(): SequenceTimeline {
  return {
    sequence: {
      id: 'seq-1',
      title: 'Launch teaser',
      fps: 30,
      width: 1920,
      height: 1080,
      aspectRatio: '16:9',
      durationFrames: 300,
      status: 'draft',
      metadata: {},
    },
    tracks: [
      { id: 'track-video', kind: 'video', name: 'Video 1', sortOrder: 0, locked: false, muted: false, metadata: {} },
      { id: 'track-audio', kind: 'audio', name: 'Audio 1', sortOrder: 1, locked: false, muted: false, metadata: {} },
    ],
    clips: [
      {
        id: 'clip-video',
        trackId: 'track-video',
        label: 'Opening shot',
        startFrame: 30,
        durationFrames: 90,
        sourceInFrame: 0,
        sourceOutFrame: null,
        disabled: false,
        media: { url: 'https://media.invalid/opening.mp4', kind: 'video', durationSeconds: 12 },
        metadata: {},
      },
      {
        id: 'clip-audio',
        trackId: 'track-audio',
        label: 'Bed music',
        startFrame: 0,
        durationFrames: 300,
        sourceInFrame: 0,
        sourceOutFrame: null,
        disabled: false,
        media: { url: 'https://media.invalid/bed.mp3', kind: 'audio', durationSeconds: 30 },
        metadata: {},
      },
    ],
  }
}

function emptyTimeline(): SequenceTimeline {
  const base = fixtureTimeline()
  return { ...base, tracks: [], clips: [] }
}

beforeAll(() => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('network disabled in tests')))
})

afterEach(() => {
  cleanup()
})

describe('TimelineEditor keyboard editing', () => {
  it('makes exactly one clip the roving Tab stop and focuses it', () => {
    render(
      createElement(TimelineEditor, {
        timeline: fixtureTimeline(),
        canWrite: true,
        onApplyOperations: vi.fn(async () => {}),
      }),
    )

    const chips = Array.from(document.querySelectorAll('[data-clip-id]')) as HTMLElement[]
    const tabbable = chips.filter((chip) => chip.tabIndex === 0)
    // Roving tabindex: one tab stop, the rest reachable by arrow walk.
    expect(tabbable).toHaveLength(1)
    expect(chips.filter((chip) => chip.tabIndex === -1)).toHaveLength(chips.length - 1)

    const focusTarget = tabbable[0] as HTMLElement
    focusTarget.focus()
    expect(document.activeElement).toBe(focusTarget)
  })

  it('Delete on a focused clip removes it through onApplyOperations', async () => {
    const applied: SequenceOperation[][] = []
    const onApplyOperations = vi.fn(async (operations: SequenceOperation[]) => {
      applied.push(operations)
    })
    render(
      createElement(TimelineEditor, {
        timeline: fixtureTimeline(),
        canWrite: true,
        onApplyOperations,
      }),
    )

    const chip = document.querySelector('[data-clip-id="clip-video"]') as HTMLElement
    chip.focus()
    fireEvent.keyDown(chip, { key: 'Delete' })

    await waitFor(() => expect(applied).toHaveLength(1))
    expect(applied[0]?.[0]).toMatchObject({ type: 'delete_clip', clipId: 'clip-video' })
  })

  it('Enter on a focused clip selects it (Shift makes it additive)', () => {
    const onSelectionChange = vi.fn()
    render(
      createElement(TimelineEditor, {
        timeline: fixtureTimeline(),
        canWrite: true,
        onApplyOperations: vi.fn(async () => {}),
        onSelectionChange,
      }),
    )

    const video = document.querySelector('[data-clip-id="clip-video"]') as HTMLElement
    fireEvent.keyDown(video, { key: 'Enter' })
    expect((onSelectionChange.mock.calls.at(-1)?.[0] as Array<{ id: string }>).map((c) => c.id)).toEqual(['clip-video'])

    const audio = document.querySelector('[data-clip-id="clip-audio"]') as HTMLElement
    fireEvent.keyDown(audio, { key: 'Enter', shiftKey: true })
    expect(
      (onSelectionChange.mock.calls.at(-1)?.[0] as Array<{ id: string }>).map((c) => c.id).sort(),
    ).toEqual(['clip-audio', 'clip-video'])
  })

  it('ArrowRight/ArrowLeft step the playhead by one frame (Shift steps by ten)', () => {
    render(
      createElement(TimelineEditor, {
        timeline: fixtureTimeline(),
        canWrite: true,
        onApplyOperations: vi.fn(async () => {}),
      }),
    )

    // Playhead starts at frame 0 → 0:00.00 in the transport readout.
    expect(screen.getAllByText('0:00.00').length).toBeGreaterThanOrEqual(1)

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    // 1 frame at 30fps = 0:00.01.
    expect(screen.getByText('0:00.01')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true })
    // +10 frames → frame 11 → 0:00.11.
    expect(screen.getByText('0:00.11')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'ArrowLeft', shiftKey: true })
    // -10 frames → frame 1 → 0:00.01.
    expect(screen.getByText('0:00.01')).toBeTruthy()

    // Cannot step before frame 0.
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(screen.getAllByText('0:00.00').length).toBeGreaterThanOrEqual(1)
  })

  it('Alt+Arrow nudges the selected clip by whole frames through a move command', async () => {
    const applied: SequenceOperation[][] = []
    const onApplyOperations = vi.fn(async (operations: SequenceOperation[]) => {
      applied.push(operations)
    })
    render(
      createElement(TimelineEditor, {
        timeline: fixtureTimeline(),
        canWrite: true,
        onApplyOperations,
      }),
    )

    const chip = document.querySelector('[data-clip-id="clip-video"]') as HTMLElement
    fireEvent.keyDown(chip, { key: 'Enter' })

    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true })
    await waitFor(() => expect(applied).toHaveLength(1))
    // Clip started at frame 30; one frame right → 31.
    expect(applied[0]?.[0]).toMatchObject({ type: 'move_clip', clipId: 'clip-video', startFrame: 31 })
  })

  it('does not nudge a clip when none is selected', () => {
    const onApplyOperations = vi.fn(async () => {})
    render(
      createElement(TimelineEditor, {
        timeline: fixtureTimeline(),
        canWrite: true,
        onApplyOperations,
      }),
    )

    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true })
    expect(onApplyOperations).not.toHaveBeenCalled()
  })
})

describe('TimelineEditor empty state', () => {
  it('renders a centered empty state when the sequence has no tracks', () => {
    render(
      createElement(TimelineEditor, {
        timeline: emptyTimeline(),
        canWrite: true,
        onApplyOperations: vi.fn(async () => {}),
      }),
    )

    expect(document.querySelector('[data-timeline-empty]')).toBeTruthy()
    expect(screen.getByText('This sequence has no tracks yet')).toBeTruthy()
    // No track lanes rendered.
    expect(document.querySelector('[data-lane-track]')).toBeNull()
  })

  it('does not render the empty state once a track exists', () => {
    render(
      createElement(TimelineEditor, {
        timeline: fixtureTimeline(),
        canWrite: true,
        onApplyOperations: vi.fn(async () => {}),
      }),
    )
    expect(document.querySelector('[data-timeline-empty]')).toBeNull()
    expect(document.querySelector('[data-lane-track]')).toBeTruthy()
  })
})
