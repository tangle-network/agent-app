// @vitest-environment jsdom
/**
 * Timeline editor component tests: the pure interaction math every gesture
 * routes through (drag→frames, trim clamps, ruler tick density, letterboxing,
 * snap-edge selection, composite undo steps) plus a rendered smoke pass over
 * `TimelineEditor` — fixture timeline in, edits out through
 * `onApplyOperations`, optimistic rollback on rejection.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement, StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SequenceOperation } from '../../src/sequences/operations'
import type { SequenceTimeline } from '../../src/sequences/model'
import type { EditorTimelineState, TimelineCommand } from '../../src/sequences-react/contracts'
import {
  captionFontPx,
  chooseMoveSnap,
  clipChipGeometry,
  framesFromPixelDelta,
  letterboxRect,
  moveDragStartFrame,
  selectTickStepSeconds,
  trimEndDrag,
  trimStartDrag,
} from '../../src/sequences-react/components/interaction-math'
import { compositeCommand } from '../../src/sequences-react/components/composite-command'
import { TimelineEditor } from '../../src/sequences-react/components/TimelineEditor'

// ---------------------------------------------------------------------------
// Pure interaction math
// ---------------------------------------------------------------------------

describe('framesFromPixelDelta', () => {
  it('quantizes pixel deltas to whole frames at the current zoom', () => {
    expect(framesFromPixelDelta(40, 4)).toBe(10)
    // Math.round half-frame ties round toward +∞: -6.5 → -6.
    expect(framesFromPixelDelta(-13, 2)).toBe(-6)
    expect(framesFromPixelDelta(-14, 2)).toBe(-7)
    expect(framesFromPixelDelta(0.4, 1)).toBe(0)
  })

  it('rejects non-positive zoom', () => {
    expect(() => framesFromPixelDelta(10, 0)).toThrow(/zoom/)
    expect(() => framesFromPixelDelta(10, -2)).toThrow(/zoom/)
  })
})

describe('moveDragStartFrame', () => {
  it('clamps at frame 0 and at the sequence tail', () => {
    expect(
      moveDragStartFrame({ originStartFrame: 10, durationFrames: 30, deltaFrames: -50, sequenceDurationFrames: 300 }),
    ).toBe(0)
    expect(
      moveDragStartFrame({ originStartFrame: 10, durationFrames: 30, deltaFrames: 500, sequenceDurationFrames: 300 }),
    ).toBe(270)
    expect(
      moveDragStartFrame({ originStartFrame: 10, durationFrames: 30, deltaFrames: 25, sequenceDurationFrames: 300 }),
    ).toBe(35)
  })
})

describe('trimStartDrag', () => {
  it('keeps the clip end invariant and shifts sourceInFrame by the start delta', () => {
    const result = trimStartDrag({ originStartFrame: 100, originDurationFrames: 60, originSourceInFrame: 20, deltaFrames: 15 })
    expect(result).toEqual({ startFrame: 115, durationFrames: 45, sourceInFrame: 35 })
  })

  it('stops at the source-material wall (sourceInFrame cannot go below 0)', () => {
    const result = trimStartDrag({ originStartFrame: 100, originDurationFrames: 60, originSourceInFrame: 20, deltaFrames: -50 })
    expect(result).toEqual({ startFrame: 80, durationFrames: 80, sourceInFrame: 0 })
  })

  it('stops one minimum clip length before the end', () => {
    const result = trimStartDrag({ originStartFrame: 100, originDurationFrames: 60, originSourceInFrame: 20, deltaFrames: 999 })
    expect(result.startFrame).toBe(159)
    expect(result.durationFrames).toBe(1)
  })
})

describe('trimEndDrag', () => {
  it('extends up to the sequence end', () => {
    expect(
      trimEndDrag({ originStartFrame: 250, originDurationFrames: 20, sourceInFrame: 0, deltaFrames: 999, sequenceDurationFrames: 300 }),
    ).toEqual({ durationFrames: 50 })
  })

  it('extends only as far as the remaining source material', () => {
    expect(
      trimEndDrag({
        originStartFrame: 0,
        originDurationFrames: 20,
        sourceInFrame: 30,
        deltaFrames: 999,
        sequenceDurationFrames: 300,
        sourceDurationFrames: 90,
      }),
    ).toEqual({ durationFrames: 60 })
  })

  it('never shrinks below the minimum clip length', () => {
    expect(
      trimEndDrag({ originStartFrame: 0, originDurationFrames: 20, sourceInFrame: 0, deltaFrames: -999, sequenceDurationFrames: 300 }),
    ).toEqual({ durationFrames: 1 })
  })
})

describe('selectTickStepSeconds', () => {
  it('densifies as zoom rises', () => {
    // 30fps: 1s = 30 frames. zoom 4 → 120px per second ≥ 80 → 1s ticks.
    expect(selectTickStepSeconds({ zoom: 4, fps: 30 })).toBe(1)
    // zoom 0.6 → 18px/s; 5s → 90px ≥ 80.
    expect(selectTickStepSeconds({ zoom: 0.6, fps: 30 })).toBe(5)
    expect(selectTickStepSeconds({ zoom: 0.3, fps: 30 })).toBe(10)
    expect(selectTickStepSeconds({ zoom: 0.1, fps: 30 })).toBe(30)
  })

  it('grows in whole minutes past the step table', () => {
    // zoom 0.0002 at 30fps → 60s ticks are 0.36px apart; needs ceil(80/0.36)=223 → 240s? No:
    // pxPerMinute = 60*30*0.0002 = 0.36 → ceil(80/0.36) = 223 minutes → 13380s.
    const step = selectTickStepSeconds({ zoom: 0.0002, fps: 30 })
    expect(step % 60).toBe(0)
    expect(step * 30 * 0.0002).toBeGreaterThanOrEqual(80)
  })
})

describe('letterboxRect', () => {
  it('letterboxes wide media in a tall container', () => {
    expect(letterboxRect({ containerWidth: 400, containerHeight: 400, mediaWidth: 1920, mediaHeight: 1080 })).toEqual({
      x: 0,
      y: (400 - 225) / 2,
      width: 400,
      height: 225,
    })
  })

  it('pillarboxes tall media in a wide container', () => {
    const rect = letterboxRect({ containerWidth: 800, containerHeight: 450, mediaWidth: 1080, mediaHeight: 1920 })
    expect(rect.height).toBe(450)
    expect(rect.width).toBeCloseTo(450 * (1080 / 1920))
    expect(rect.x).toBeCloseTo((800 - rect.width) / 2)
  })
})

describe('captionFontPx / clipChipGeometry', () => {
  it('scales caption type with canvas height and floors at 12px', () => {
    expect(captionFontPx(1080)).toBe(60)
    expect(captionFontPx(90)).toBe(12)
  })

  it('floors chip width at 2px so 1-frame clips stay grabbable', () => {
    expect(clipChipGeometry({ startFrame: 30, durationFrames: 1, zoom: 0.5 })).toEqual({ left: 15, width: 2 })
    expect(clipChipGeometry({ startFrame: 0, durationFrames: 60, zoom: 2 })).toEqual({ left: 0, width: 120 })
  })
})

describe('chooseMoveSnap', () => {
  const startPoint = { frame: 100, kind: 'clip-end' as const }
  const endPoint = { frame: 200, kind: 'clip-start' as const }

  it('passes through when neither edge snapped', () => {
    expect(
      chooseMoveSnap({
        candidateStartFrame: 150,
        durationFrames: 30,
        startSnap: { frame: 150, snapped: false, point: null },
        endSnap: { frame: 180, snapped: false, point: null },
      }),
    ).toEqual({ startFrame: 150, point: null })
  })

  it('prefers the nearer snapped edge and re-expresses end snaps as starts', () => {
    // Candidate start 104 (end 134): start edge is 4 frames from 100; end edge
    // would need to travel 66 to reach 200 — start wins.
    expect(
      chooseMoveSnap({
        candidateStartFrame: 104,
        durationFrames: 30,
        startSnap: { frame: 100, snapped: true, point: startPoint },
        endSnap: { frame: 200, snapped: false, point: null },
      }),
    ).toEqual({ startFrame: 100, point: startPoint })

    // Only the end edge snapped: start = 200 - 30.
    expect(
      chooseMoveSnap({
        candidateStartFrame: 168,
        durationFrames: 30,
        startSnap: { frame: 168, snapped: false, point: null },
        endSnap: { frame: 200, snapped: true, point: endPoint },
      }),
    ).toEqual({ startFrame: 170, point: endPoint })
  })
})

describe('compositeCommand', () => {
  function probeCommand(id: string, log: string[]): TimelineCommand {
    return {
      label: id,
      execute: (state: EditorTimelineState) => {
        log.push(`execute:${id}`)
        return state
      },
      undo: (state: EditorTimelineState) => {
        log.push(`undo:${id}`)
        return state
      },
      operations: () => [{ type: 'delete_clip', clipId: id } satisfies SequenceOperation],
      inverseOperations: () => [{ type: 'set_clip_disabled', clipId: id, disabled: false } satisfies SequenceOperation],
    }
  }

  it('executes in order, undoes in reverse, and flattens operations accordingly', () => {
    const log: string[] = []
    const composite = compositeCommand('batch', [probeCommand('a', log), probeCommand('b', log)])
    const state = {} as EditorTimelineState
    composite.execute(state)
    composite.undo(state)
    expect(log).toEqual(['execute:a', 'execute:b', 'undo:b', 'undo:a'])
    expect(composite.operations().map((op) => (op as { clipId: string }).clipId)).toEqual(['a', 'b'])
    expect(composite.inverseOperations().map((op) => (op as { clipId: string }).clipId)).toEqual(['b', 'a'])
  })

  it('rejects empty batches', () => {
    expect(() => compositeCommand('empty', [])).toThrow(/at least one command/)
  })
})

// ---------------------------------------------------------------------------
// TimelineEditor smoke
// ---------------------------------------------------------------------------

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
      { id: 'track-captions', kind: 'caption', name: 'Captions', sortOrder: 2, locked: false, muted: false, metadata: {} },
    ],
    clips: [
      {
        id: 'clip-video',
        trackId: 'track-video',
        label: 'Opening shot',
        startFrame: 0,
        durationFrames: 150,
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
      {
        id: 'clip-caption',
        trackId: 'track-captions',
        label: 'Hello caption',
        startFrame: 60,
        durationFrames: 60,
        sourceInFrame: 0,
        sourceOutFrame: null,
        disabled: false,
        text: 'Hello caption',
        metadata: {},
      },
    ],
  }
}

beforeAll(() => {
  // The audio chip's waveform load fetches its media URL on mount; tests run
  // network-free, so the fetch fails fast and the chip records the error.
  vi.stubGlobal('fetch', () => Promise.reject(new Error('network disabled in tests')))
})

afterEach(() => {
  cleanup()
})

describe('TimelineEditor', () => {
  it('renders transport, ruler, tracks, and clips from a fixture timeline', () => {
    const onApplyOperations = vi.fn(async () => {})
    render(
      createElement(TimelineEditor, {
        timeline: fixtureTimeline(),
        canWrite: true,
        onApplyOperations,
      }),
    )

    expect(screen.getByLabelText('Play')).toBeTruthy()
    expect(screen.getByLabelText('Undo')).toBeTruthy()
    expect(screen.getByLabelText('Toggle snapping')).toBeTruthy()
    expect(screen.getByText('Video 1')).toBeTruthy()
    expect(screen.getByText('Audio 1')).toBeTruthy()
    expect(screen.getByText('Captions')).toBeTruthy()
    expect(screen.getByText('Opening shot')).toBeTruthy()
    expect(screen.getByText('Bed music')).toBeTruthy()
    expect(screen.getByText('Hello caption')).toBeTruthy()
    // Timecode readout: playhead at 0 over a 10s sequence. '0:00.00' also
    // appears as the ruler's first tick label, so match all.
    expect(screen.getAllByText('0:00.00').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('/ 0:10.00', { exact: false })).toBeTruthy()
    expect((screen.getByLabelText('Undo') as HTMLButtonElement).disabled).toBe(true)
    expect(onApplyOperations).not.toHaveBeenCalled()
  })

  it('hides write controls when canWrite is false', () => {
    render(
      createElement(TimelineEditor, {
        timeline: fixtureTimeline(),
        canWrite: false,
        onApplyOperations: vi.fn(async () => {}),
      }),
    )
    expect(screen.queryByLabelText('Add caption at playhead')).toBeNull()
    expect(screen.queryByLabelText('Split clip at playhead')).toBeNull()
  })

  it('adds a caption optimistically, emits the operation, and emits the inverse on undo', async () => {
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

    fireEvent.click(screen.getByLabelText('Add caption at playhead'))
    expect(screen.getByText('New caption')).toBeTruthy()
    expect(applied).toHaveLength(1)
    expect(applied[0]?.[0]).toMatchObject({
      type: 'add_caption',
      text: 'New caption',
      trackId: 'track-captions',
      startFrame: 0,
      durationFrames: 60,
    })

    const undoButton = screen.getByLabelText('Undo') as HTMLButtonElement
    expect(undoButton.disabled).toBe(false)
    fireEvent.click(undoButton)
    expect(screen.queryByText('New caption')).toBeNull()
    expect(applied).toHaveLength(2)
    expect(applied[1]?.[0]).toMatchObject({ type: 'delete_clip' })
  })

  it('reconciles optimistic ids from apply results so undo after a refresh targets the server id', async () => {
    const serverClip = {
      id: 'srv-caption-1',
      trackId: 'track-captions',
      label: 'New caption',
      startFrame: 0,
      durationFrames: 60,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: false,
      text: 'New caption',
      metadata: {},
    }
    const applied: SequenceOperation[][] = []
    const onApplyOperations = vi.fn(async (operations: SequenceOperation[]) => {
      applied.push(operations)
      // What a host route built on applySequenceOperations resolves with.
      return [{ kind: 'clip' as const, clip: serverClip }]
    })
    const { rerender } = render(
      createElement(TimelineEditor, { timeline: fixtureTimeline(), canWrite: true, onApplyOperations }),
    )

    fireEvent.click(screen.getByLabelText('Add caption at playhead'))
    await waitFor(() => expect(onApplyOperations).toHaveBeenCalledTimes(1))

    // Server refresh: the committed caption returns under its minted id and
    // the optimistic local clip is gone.
    const refreshed = fixtureTimeline()
    refreshed.clips.push({ ...serverClip })
    rerender(createElement(TimelineEditor, { timeline: refreshed, canWrite: true, onApplyOperations }))

    fireEvent.click(screen.getByLabelText('Undo'))
    await waitFor(() => expect(applied).toHaveLength(2))
    expect(applied[1]?.[0]).toEqual({ type: 'delete_clip', clipId: 'srv-caption-1' })
    expect(screen.queryByText('New caption')).toBeNull()
  })

  it('rolls the edit back without emitting an inverse when persistence rejects', async () => {
    const onApplyOperations = vi.fn(async () => {
      throw new Error('workspace is read-only right now')
    })
    render(
      createElement(TimelineEditor, {
        timeline: fixtureTimeline(),
        canWrite: true,
        onApplyOperations,
      }),
    )

    fireEvent.click(screen.getByLabelText('Add caption at playhead'))
    expect(screen.getByText('New caption')).toBeTruthy()

    await waitFor(() => {
      expect(screen.queryByText('New caption')).toBeNull()
    })
    expect(screen.getByRole('alert').textContent).toContain('workspace is read-only right now')
    // Exactly one emission: the rejected commit, no inverse for the rollback.
    expect(onApplyOperations).toHaveBeenCalledTimes(1)
    expect((screen.getByLabelText('Undo') as HTMLButtonElement).disabled).toBe(true)
  })

  it('selects a clip on click and surfaces it to onSelectionChange', () => {
    const onSelectionChange = vi.fn()
    render(
      createElement(TimelineEditor, {
        timeline: fixtureTimeline(),
        canWrite: true,
        onApplyOperations: vi.fn(async () => {}),
        onSelectionChange,
      }),
    )

    const chip = document.querySelector('[data-clip-id="clip-video"]') as HTMLElement
    expect(chip).toBeTruthy()
    // A press-and-release without movement is a click-select.
    fireEvent.pointerDown(chip, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(chip, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })

    const lastCall = onSelectionChange.mock.calls.at(-1)?.[0] as Array<{ id: string }>
    expect(lastCall.map((clip) => clip.id)).toEqual(['clip-video'])
  })

  it('survives the StrictMode mount/unmount/remount probe with a live playback clock', () => {
    // StrictMode double-invokes mount effects in development. The playback clock
    // must be rebuilt on remount rather than seeked after disposal — a clock
    // created in render and disposed in a cleanup is reused across the probe,
    // and the regression throws "PlaybackClock is disposed" during the remount,
    // failing this render.
    render(
      createElement(
        StrictMode,
        null,
        createElement(TimelineEditor, {
          timeline: fixtureTimeline(),
          canWrite: true,
          onApplyOperations: vi.fn(async () => {}),
        }),
      ),
    )

    // Driving the transport proves the surviving clock is the live instance, not
    // a disposed placeholder: play() would throw on a disposed clock.
    fireEvent.click(screen.getByLabelText('Play'))
    expect(screen.getByLabelText('Pause')).toBeTruthy()
  })
})
