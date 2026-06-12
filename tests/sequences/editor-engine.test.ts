import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SequenceTimeline } from '../../src/sequences/model'
import type { EditorTimelineState, TimelineCommand } from '../../src/sequences-react/contracts'
import { COMMAND_HISTORY_LIMIT, createCommandStack } from '../../src/sequences-react/engine/command-stack'
import {
  addCaptionCommand,
  deleteClipCommand,
  moveClipCommand,
  placeClipCommand,
  setClipTextCommand,
  splitClipCommand,
  toggleClipDisabledCommand,
  trimClipCommand,
} from '../../src/sequences-react/engine/commands'
import { createPlaybackClock } from '../../src/sequences-react/engine/playback'
import { applySnap, collectSnapPoints } from '../../src/sequences-react/engine/snap'
import { createZoomMath, frameToPixel, pixelToFrame, snapPixel } from '../../src/sequences-react/engine/zoom'

function makeTimeline(): SequenceTimeline {
  return {
    sequence: {
      id: 'seq-1',
      title: 'Demo',
      fps: 30,
      width: 1920,
      height: 1080,
      aspectRatio: '16:9',
      durationFrames: 300,
      status: 'active',
      metadata: {},
    },
    tracks: [
      { id: 't-video', kind: 'video', name: 'Video 1', sortOrder: 0, locked: false, muted: false, metadata: {} },
      { id: 't-video2', kind: 'video', name: 'Video 2', sortOrder: 1, locked: false, muted: false, metadata: {} },
      { id: 't-caption', kind: 'caption', name: 'Captions', sortOrder: 2, locked: false, muted: false, metadata: {} },
      { id: 't-locked', kind: 'video', name: 'Locked', sortOrder: 3, locked: true, muted: false, metadata: {} },
    ],
    clips: [
      {
        id: 'clip-a',
        trackId: 't-video',
        label: 'Intro',
        startFrame: 0,
        durationFrames: 90,
        sourceInFrame: 0,
        sourceOutFrame: null,
        disabled: false,
        media: { url: 'https://cdn.example/intro.mp4', kind: 'video' },
        generationId: 'gen-1',
        metadata: { take: 1 },
      },
      {
        id: 'clip-b',
        trackId: 't-video',
        label: 'Outro',
        startFrame: 150,
        durationFrames: 90,
        sourceInFrame: 30,
        sourceOutFrame: 240,
        disabled: false,
        media: { url: 'https://cdn.example/outro.mp4', kind: 'video' },
        metadata: {},
      },
      {
        id: 'clip-cap',
        trackId: 't-caption',
        label: 'hello world',
        startFrame: 30,
        durationFrames: 60,
        sourceInFrame: 0,
        sourceOutFrame: null,
        disabled: false,
        text: 'hello world',
        language: 'en',
        metadata: {},
      },
    ],
  }
}

function stateOf(timeline: SequenceTimeline, overrides: Partial<EditorTimelineState> = {}): EditorTimelineState {
  return { timeline, playheadFrame: 0, selectedClipIds: [], zoom: 1, scrollLeft: 0, ...overrides }
}

/** execute → undo must restore the exact pre-state for every command. */
function expectRoundTrip(command: TimelineCommand, before: EditorTimelineState): EditorTimelineState {
  const after = command.execute(before)
  expect(command.undo(after)).toEqual(before)
  return after
}

describe('command factories', () => {
  describe('moveClipCommand', () => {
    it('round-trips and emits durable + inverse ops on the same track', () => {
      const timeline = makeTimeline()
      const before = stateOf(timeline)
      const command = moveClipCommand({ timeline, clipId: 'clip-a', startFrame: 60 })

      const after = expectRoundTrip(command, before)
      expect(after.timeline.clips.find((c) => c.id === 'clip-a')?.startFrame).toBe(60)
      expect(command.operations()).toEqual([{ type: 'move_clip', clipId: 'clip-a', startFrame: 60 }])
      expect(command.inverseOperations()).toEqual([{ type: 'move_clip', clipId: 'clip-a', startFrame: 0 }])
    })

    it('clamps the target into the sequence and emits the clamped frame', () => {
      const timeline = makeTimeline()
      const command = moveClipCommand({ timeline, clipId: 'clip-a', startFrame: 280 })
      expect(command.operations()).toEqual([{ type: 'move_clip', clipId: 'clip-a', startFrame: 210 }])
    })

    it('carries trackId both ways on cross-track moves', () => {
      const timeline = makeTimeline()
      const before = stateOf(timeline)
      const command = moveClipCommand({ timeline, clipId: 'clip-a', startFrame: 10, trackId: 't-video2' })

      const after = expectRoundTrip(command, before)
      expect(after.timeline.clips.find((c) => c.id === 'clip-a')?.trackId).toBe('t-video2')
      expect(command.operations()).toEqual([
        { type: 'move_clip', clipId: 'clip-a', startFrame: 10, trackId: 't-video2' },
      ])
      expect(command.inverseOperations()).toEqual([
        { type: 'move_clip', clipId: 'clip-a', startFrame: 0, trackId: 't-video' },
      ])
    })

    it('rejects locked tracks and unknown clips', () => {
      const timeline = makeTimeline()
      expect(() => moveClipCommand({ timeline, clipId: 'clip-a', startFrame: 0, trackId: 't-locked' })).toThrow(/locked/)
      expect(() => moveClipCommand({ timeline, clipId: 'nope', startFrame: 0 })).toThrow(/does not exist/)
    })
  })

  describe('trimClipCommand', () => {
    it('round-trips and restores original bounds + source in-point', () => {
      const timeline = makeTimeline()
      const before = stateOf(timeline)
      const command = trimClipCommand({ timeline, clipId: 'clip-b', startFrame: 160, durationFrames: 70, sourceInFrame: 40 })

      const after = expectRoundTrip(command, before)
      const trimmed = after.timeline.clips.find((c) => c.id === 'clip-b')
      expect(trimmed).toMatchObject({ startFrame: 160, durationFrames: 70, sourceInFrame: 40 })
      expect(command.operations()).toEqual([
        { type: 'trim_clip', clipId: 'clip-b', startFrame: 160, durationFrames: 70, sourceInFrame: 40 },
      ])
      expect(command.inverseOperations()).toEqual([
        { type: 'trim_clip', clipId: 'clip-b', startFrame: 150, durationFrames: 90, sourceInFrame: 30 },
      ])
    })

    it('keeps sourceInFrame unchanged when omitted', () => {
      const timeline = makeTimeline()
      const command = trimClipCommand({ timeline, clipId: 'clip-b', startFrame: 150, durationFrames: 60 })
      expect(command.operations()).toEqual([
        { type: 'trim_clip', clipId: 'clip-b', startFrame: 150, durationFrames: 60, sourceInFrame: 30 },
      ])
    })

    it('rejects bounds outside the sequence', () => {
      const timeline = makeTimeline()
      expect(() => trimClipCommand({ timeline, clipId: 'clip-b', startFrame: 250, durationFrames: 90 })).toThrow(
        /beyond the sequence/,
      )
    })
  })

  describe('placeClipCommand', () => {
    it('inserts the optimistic clip and inverts to delete_clip', () => {
      const timeline = makeTimeline()
      const before = stateOf(timeline)
      const command = placeClipCommand({
        timeline,
        clipId: 'clip-new',
        trackId: 't-video2',
        label: 'B-roll',
        startFrame: 100,
        durationFrames: 50,
        media: { url: 'https://cdn.example/broll.mp4', kind: 'video' },
        generationId: 'gen-9',
        metadata: { source: 'shelf' },
      })

      const after = expectRoundTrip(command, before)
      expect(after.timeline.clips.find((c) => c.id === 'clip-new')).toMatchObject({
        trackId: 't-video2',
        label: 'B-roll',
        startFrame: 100,
        durationFrames: 50,
        sourceInFrame: 0,
        sourceOutFrame: null,
        disabled: false,
        media: { url: 'https://cdn.example/broll.mp4', kind: 'video' },
        generationId: 'gen-9',
        metadata: { source: 'shelf' },
      })
      expect(command.operations()).toEqual([
        {
          type: 'place_clip',
          trackId: 't-video2',
          label: 'B-roll',
          startFrame: 100,
          durationFrames: 50,
          sourceInFrame: 0,
          media: { url: 'https://cdn.example/broll.mp4', kind: 'video' },
          generationId: 'gen-9',
          metadata: { source: 'shelf' },
        },
      ])
      expect(command.inverseOperations()).toEqual([{ type: 'delete_clip', clipId: 'clip-new' }])
    })

    it('rejects duplicate ids, locked tracks, and out-of-bounds placement', () => {
      const timeline = makeTimeline()
      const base = { timeline, label: 'X', startFrame: 0, durationFrames: 10 }
      expect(() => placeClipCommand({ ...base, clipId: 'clip-a', trackId: 't-video2' })).toThrow(/already exists/)
      expect(() => placeClipCommand({ ...base, clipId: 'clip-new', trackId: 't-locked' })).toThrow(/locked/)
      expect(() =>
        placeClipCommand({ ...base, clipId: 'clip-new', trackId: 't-video2', startFrame: 295, durationFrames: 10 }),
      ).toThrow(/beyond the sequence/)
    })
  })

  describe('deleteClipCommand', () => {
    it('removes the clip + selection entry; undo restores the exact clip', () => {
      const timeline = makeTimeline()
      const before = stateOf(timeline, { selectedClipIds: ['clip-a', 'clip-b'] })
      const command = deleteClipCommand({ timeline, clipId: 'clip-a' })

      const after = command.execute(before)
      expect(after.timeline.clips.some((c) => c.id === 'clip-a')).toBe(false)
      expect(after.selectedClipIds).toEqual(['clip-b'])
      const restored = command.undo(after)
      expect(restored.timeline.clips.find((c) => c.id === 'clip-a')).toEqual(
        before.timeline.clips.find((c) => c.id === 'clip-a'),
      )
      expect(command.operations()).toEqual([{ type: 'delete_clip', clipId: 'clip-a' }])
    })

    it('inverts media clips through place_clip with media + product refs', () => {
      const timeline = makeTimeline()
      const command = deleteClipCommand({ timeline, clipId: 'clip-a' })
      expect(command.inverseOperations()).toEqual([
        {
          type: 'place_clip',
          trackId: 't-video',
          label: 'Intro',
          startFrame: 0,
          durationFrames: 90,
          sourceInFrame: 0,
          media: { url: 'https://cdn.example/intro.mp4', kind: 'video' },
          generationId: 'gen-1',
          metadata: { take: 1 },
        },
      ])
    })

    it('inverts caption clips through add_caption with text + language', () => {
      const timeline = makeTimeline()
      const command = deleteClipCommand({ timeline, clipId: 'clip-cap' })
      expect(command.inverseOperations()).toEqual([
        {
          type: 'add_caption',
          text: 'hello world',
          language: 'en',
          startFrame: 30,
          durationFrames: 60,
          trackId: 't-caption',
        },
      ])
    })
  })

  describe('splitClipCommand', () => {
    it('splits with a 1:1 source offset and undo restores the single original', () => {
      const timeline = makeTimeline()
      const before = stateOf(timeline)
      const command = splitClipCommand({ timeline, clipId: 'clip-b', atFrame: 180, newClipId: 'clip-b2' })

      const after = command.execute(before)
      // The head's out-point becomes explicit at the cut, matching what the
      // server-side apply persists.
      expect(after.timeline.clips.find((c) => c.id === 'clip-b')).toMatchObject({
        startFrame: 150,
        durationFrames: 30,
        sourceInFrame: 30,
        sourceOutFrame: 60,
      })
      expect(after.timeline.clips.find((c) => c.id === 'clip-b2')).toMatchObject({
        trackId: 't-video',
        label: 'Outro',
        startFrame: 180,
        durationFrames: 60,
        sourceInFrame: 60,
        sourceOutFrame: 240,
        media: { url: 'https://cdn.example/outro.mp4', kind: 'video' },
      })
      expect(command.undo(after)).toEqual(before)

      expect(command.operations()).toEqual([{ type: 'split_clip', clipId: 'clip-b', atFrame: 180 }])
      // The durable inverse restores the pre-split source window; without
      // sourceOutFrame the head would keep its out-point at the cut.
      expect(command.inverseOperations()).toEqual([
        { type: 'delete_clip', clipId: 'clip-b2' },
        { type: 'trim_clip', clipId: 'clip-b', startFrame: 150, durationFrames: 90, sourceInFrame: 30, sourceOutFrame: 240 },
      ])
    })

    it('rejects cuts at or outside the clip edges', () => {
      const timeline = makeTimeline()
      expect(() => splitClipCommand({ timeline, clipId: 'clip-b', atFrame: 150, newClipId: 'x' })).toThrow(
        /strictly inside/,
      )
      expect(() => splitClipCommand({ timeline, clipId: 'clip-b', atFrame: 240, newClipId: 'x' })).toThrow(
        /strictly inside/,
      )
    })
  })

  describe('addCaptionCommand', () => {
    it('round-trips, mirrors text into the label, and inverts to delete_clip', () => {
      const timeline = makeTimeline()
      const before = stateOf(timeline)
      const command = addCaptionCommand({
        timeline,
        clipId: 'cap-new',
        trackId: 't-caption',
        text: 'bonjour',
        language: 'fr',
        startFrame: 120,
        durationFrames: 45,
      })

      const after = expectRoundTrip(command, before)
      expect(after.timeline.clips.find((c) => c.id === 'cap-new')).toMatchObject({
        trackId: 't-caption',
        label: 'bonjour',
        text: 'bonjour',
        language: 'fr',
        startFrame: 120,
        durationFrames: 45,
      })
      expect(command.operations()).toEqual([
        { type: 'add_caption', text: 'bonjour', language: 'fr', startFrame: 120, durationFrames: 45, trackId: 't-caption' },
      ])
      expect(command.inverseOperations()).toEqual([{ type: 'delete_clip', clipId: 'cap-new' }])
    })

    it('rejects non-caption tracks and empty text', () => {
      const timeline = makeTimeline()
      const base = { timeline, clipId: 'cap-new', startFrame: 0, durationFrames: 30 }
      expect(() => addCaptionCommand({ ...base, trackId: 't-video', text: 'x' })).toThrow(/caption track/)
      expect(() => addCaptionCommand({ ...base, trackId: 't-caption', text: '' })).toThrow(/non-empty/)
    })
  })

  describe('setClipTextCommand', () => {
    it('round-trips text + language and emits exact inverse', () => {
      const timeline = makeTimeline()
      const before = stateOf(timeline)
      const command = setClipTextCommand({ timeline, clipId: 'clip-cap', text: 'goodbye', language: 'es' })

      const after = expectRoundTrip(command, before)
      expect(after.timeline.clips.find((c) => c.id === 'clip-cap')).toMatchObject({
        text: 'goodbye',
        language: 'es',
        label: 'goodbye',
      })
      expect(command.operations()).toEqual([
        { type: 'set_clip_text', clipId: 'clip-cap', text: 'goodbye', language: 'es' },
      ])
      expect(command.inverseOperations()).toEqual([
        { type: 'set_clip_text', clipId: 'clip-cap', text: 'hello world', language: 'en' },
      ])
    })

    it('rejects clips without a text body', () => {
      const timeline = makeTimeline()
      expect(() => setClipTextCommand({ timeline, clipId: 'clip-a', text: 'nope' })).toThrow(/no text body/)
    })
  })

  describe('toggleClipDisabledCommand', () => {
    it('round-trips and emits the flip + its inverse', () => {
      const timeline = makeTimeline()
      const before = stateOf(timeline)
      const command = toggleClipDisabledCommand({ timeline, clipId: 'clip-a' })

      const after = expectRoundTrip(command, before)
      expect(after.timeline.clips.find((c) => c.id === 'clip-a')?.disabled).toBe(true)
      expect(command.operations()).toEqual([{ type: 'set_clip_disabled', clipId: 'clip-a', disabled: true }])
      expect(command.inverseOperations()).toEqual([{ type: 'set_clip_disabled', clipId: 'clip-a', disabled: false }])
    })
  })
})

describe('createCommandStack', () => {
  it('executes, undoes, and redoes with exact state restoration + notifications', () => {
    const timeline = makeTimeline()
    const stack = createCommandStack(timeline)
    const seen: number[] = []
    const unsubscribe = stack.subscribe(() => seen.push(stack.getState().timeline.clips.find((c) => c.id === 'clip-a')!.startFrame))

    stack.execute(moveClipCommand({ timeline: stack.getState().timeline, clipId: 'clip-a', startFrame: 60 }))
    expect(stack.getState().timeline.clips.find((c) => c.id === 'clip-a')?.startFrame).toBe(60)
    expect(stack.canUndo()).toBe(true)
    expect(stack.canRedo()).toBe(false)

    stack.undo()
    expect(stack.getState().timeline.clips.find((c) => c.id === 'clip-a')?.startFrame).toBe(0)
    expect(stack.canRedo()).toBe(true)

    stack.redo()
    expect(stack.getState().timeline.clips.find((c) => c.id === 'clip-a')?.startFrame).toBe(60)
    expect(seen).toEqual([60, 0, 60])

    unsubscribe()
    stack.undo()
    expect(seen).toEqual([60, 0, 60])
  })

  it('clears redo on a new execute', () => {
    const timeline = makeTimeline()
    const stack = createCommandStack(timeline)
    stack.execute(moveClipCommand({ timeline: stack.getState().timeline, clipId: 'clip-a', startFrame: 60 }))
    stack.undo()
    expect(stack.canRedo()).toBe(true)
    stack.execute(moveClipCommand({ timeline: stack.getState().timeline, clipId: 'clip-a', startFrame: 30 }))
    expect(stack.canRedo()).toBe(false)
  })

  it('bounds history at COMMAND_HISTORY_LIMIT', () => {
    const timeline = makeTimeline()
    const stack = createCommandStack(timeline)
    for (let i = 0; i < COMMAND_HISTORY_LIMIT + 5; i += 1) {
      stack.execute(
        moveClipCommand({ timeline: stack.getState().timeline, clipId: 'clip-a', startFrame: i % 2 === 0 ? 1 : 0 }),
      )
    }
    let undos = 0
    while (stack.canUndo()) {
      stack.undo()
      undos += 1
    }
    expect(undos).toBe(COMMAND_HISTORY_LIMIT)
    expect(() => stack.undo()).toThrow(/nothing to undo/)
  })

  it('throws on undo/redo with empty history', () => {
    const stack = createCommandStack(makeTimeline())
    expect(() => stack.undo()).toThrow(/nothing to undo/)
    expect(() => stack.redo()).toThrow(/nothing to redo/)
  })

  it('reset rebases the timeline, keeps history, and undo applies inverses to the rebased state', () => {
    const timeline = makeTimeline()
    const stack = createCommandStack(timeline)
    stack.execute(moveClipCommand({ timeline: stack.getState().timeline, clipId: 'clip-a', startFrame: 60 }))

    const refreshed = makeTimeline()
    refreshed.clips = refreshed.clips.map((clip) => (clip.id === 'clip-a' ? { ...clip, startFrame: 60 } : clip))
    refreshed.clips.push({
      id: 'clip-z',
      trackId: 't-video2',
      label: 'Server clip',
      startFrame: 200,
      durationFrames: 40,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: false,
      metadata: {},
    })
    stack.reset(refreshed)

    expect(stack.canUndo()).toBe(true)
    expect(stack.getState().timeline.clips.some((c) => c.id === 'clip-z')).toBe(true)

    stack.undo()
    const undone = stack.getState().timeline
    expect(undone.clips.find((c) => c.id === 'clip-a')?.startFrame).toBe(0)
    expect(undone.clips.some((c) => c.id === 'clip-z')).toBe(true)
  })

  it('reset clamps the playhead and drops selection ids the refresh removed', () => {
    const timeline = makeTimeline()
    const stack = createCommandStack(timeline)
    stack.execute(deleteClipCommand({ timeline: stack.getState().timeline, clipId: 'clip-b' }))

    const refreshed = makeTimeline()
    refreshed.sequence.durationFrames = 90
    refreshed.clips = refreshed.clips.filter((clip) => clip.id === 'clip-a')
    const before = stack.getState()
    stack.reset(refreshed)
    const state = stack.getState()
    expect(state.playheadFrame).toBeLessThanOrEqual(89)
    expect(state.selectedClipIds.every((id) => refreshed.clips.some((c) => c.id === id))).toBe(true)
    expect(state.zoom).toBe(before.zoom)
  })
})

describe('command stack failure safety', () => {
  it('a throwing undo leaves history and state intact instead of destroying the entry', () => {
    const timeline = makeTimeline()
    const stack = createCommandStack(timeline)
    stack.execute(moveClipCommand({ timeline: stack.getState().timeline, clipId: 'clip-a', startFrame: 60 }))

    // Rebase removes the command's target clip — its undo transform now throws.
    const refreshed = makeTimeline()
    refreshed.clips = refreshed.clips.filter((clip) => clip.id !== 'clip-a')
    stack.reset(refreshed)

    const stateBefore = stack.getState()
    expect(() => stack.undo()).toThrow(/clip-a does not exist/)
    expect(stack.getState()).toBe(stateBefore)
    expect(stack.canUndo()).toBe(true)
    expect(stack.canRedo()).toBe(false)

    // Restore the clip; the kept entry now undoes cleanly.
    stack.reset(makeTimeline())
    stack.undo()
    expect(stack.getState().timeline.clips.find((c) => c.id === 'clip-a')?.startFrame).toBe(0)
  })

  it('a throwing redo leaves the redo stack intact', () => {
    const timeline = makeTimeline()
    const stack = createCommandStack(timeline)
    stack.execute(moveClipCommand({ timeline: stack.getState().timeline, clipId: 'clip-a', startFrame: 60 }))
    stack.undo()

    const refreshed = makeTimeline()
    refreshed.clips = refreshed.clips.filter((clip) => clip.id !== 'clip-a')
    stack.reset(refreshed)

    expect(() => stack.redo()).toThrow(/clip-a does not exist/)
    expect(stack.canRedo()).toBe(true)
  })
})

describe('clip-id resolution (local → server aliases)', () => {
  it('placeClipCommand resolves its target through a LIVE alias map at undo/emission time', () => {
    const timeline = makeTimeline()
    const aliases = new Map<string, string>()
    const command = placeClipCommand({
      timeline,
      clipId: 'local-1',
      trackId: 't-video2',
      label: 'Optimistic',
      startFrame: 0,
      durationFrames: 30,
      resolveClipId: (id) => aliases.get(id) ?? id,
    })

    // Pre-commit: no alias yet — the inverse references the local id.
    expect(command.inverseOperations()).toEqual([{ type: 'delete_clip', clipId: 'local-1' }])

    // The host committed and reconciled; a refresh replaced the local clip
    // with the server-minted id.
    aliases.set('local-1', 'srv-9')
    const refreshed = makeTimeline()
    refreshed.clips.push({
      id: 'srv-9',
      trackId: 't-video2',
      label: 'Optimistic',
      startFrame: 0,
      durationFrames: 30,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: false,
      metadata: {},
    })

    expect(command.inverseOperations()).toEqual([{ type: 'delete_clip', clipId: 'srv-9' }])
    const undone = command.undo(stateOf(refreshed))
    expect(undone.timeline.clips.some((c) => c.id === 'srv-9')).toBe(false)
  })

  it('splitClipCommand resolves both halves through aliases', () => {
    const timeline = makeTimeline()
    const aliases = new Map<string, string>([['local-tail', 'srv-tail']])
    const command = splitClipCommand({
      timeline,
      clipId: 'clip-b',
      atFrame: 180,
      newClipId: 'local-tail',
      resolveClipId: (id) => aliases.get(id) ?? id,
    })
    expect(command.execute(stateOf(timeline)).timeline.clips.some((c) => c.id === 'srv-tail')).toBe(true)
    expect(command.inverseOperations()[0]).toEqual({ type: 'delete_clip', clipId: 'srv-tail' })
  })
})

describe('durable inverse fidelity', () => {
  it('delete inverse carries sourceOutFrame and disabled so server-side undo restores them', () => {
    const timeline = makeTimeline()
    timeline.clips = timeline.clips.map((clip) => (clip.id === 'clip-b' ? { ...clip, disabled: true } : clip))
    const command = deleteClipCommand({ timeline, clipId: 'clip-b' })
    expect(command.inverseOperations()).toEqual([
      {
        type: 'place_clip',
        trackId: 't-video',
        label: 'Outro',
        startFrame: 150,
        durationFrames: 90,
        sourceInFrame: 30,
        sourceOutFrame: 240,
        disabled: true,
        media: { url: 'https://cdn.example/outro.mp4', kind: 'video' },
        metadata: {},
      },
    ])
  })

  it('trimClipCommand rejects claiming more source frames than the stored window holds', () => {
    const timeline = makeTimeline()
    // clip-b: window [30, 240) = 210 frames; duration 211 from sourceIn 30 overflows.
    expect(() =>
      trimClipCommand({ timeline, clipId: 'clip-b', startFrame: 0, durationFrames: 211 }),
    ).toThrow(/source window \[30, 240\)/)
  })
})

describe('zoom math', () => {
  it('maps the slider exponentially between minZoom and maxZoom', () => {
    const zoomMath = createZoomMath({ minZoom: 0.5, maxZoom: 50 })
    expect(zoomMath.sliderToZoom(0)).toBeCloseTo(0.5, 10)
    expect(zoomMath.sliderToZoom(1)).toBeCloseTo(50, 10)
    expect(zoomMath.sliderToZoom(0.5)).toBeCloseTo(Math.sqrt(0.5 * 50), 10)
  })

  it('round-trips slider ↔ zoom', () => {
    const zoomMath = createZoomMath({ minZoom: 0.5, maxZoom: 50 })
    for (const slider of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      expect(zoomMath.zoomToSlider(zoomMath.sliderToZoom(slider))).toBeCloseTo(slider, 10)
    }
    for (const zoom of [0.5, 1, 2, 10, 50]) {
      expect(zoomMath.sliderToZoom(zoomMath.zoomToSlider(zoom))).toBeCloseTo(zoom, 10)
    }
  })

  it('clamps overshoot and rejects invalid input', () => {
    const zoomMath = createZoomMath({ minZoom: 1, maxZoom: 10 })
    expect(zoomMath.sliderToZoom(-0.5)).toBe(1)
    expect(zoomMath.sliderToZoom(1.5)).toBe(10)
    expect(zoomMath.zoomToSlider(100)).toBe(1)
    expect(() => zoomMath.sliderToZoom(Number.NaN)).toThrow(/finite/)
    expect(() => createZoomMath({ minZoom: 0, maxZoom: 10 })).toThrow(/minZoom/)
    expect(() => createZoomMath({ minZoom: 10, maxZoom: 10 })).toThrow(/maxZoom/)
  })

  it('converts frame ↔ pixel through zoom + scrollLeft', () => {
    const view = { zoom: 2.5, scrollLeft: 37 }
    expect(frameToPixel(120, view)).toBe(120 * 2.5 - 37)
    expect(pixelToFrame(frameToPixel(120, view), view)).toBe(120)
    expect(pixelToFrame(-500, view)).toBe(0)
  })

  it('snaps to the device pixel grid', () => {
    expect(snapPixel(10.3, 2)).toBe(10.5)
    expect(snapPixel(10.3, 1)).toBe(10)
    expect(() => snapPixel(10, 0)).toThrow(/devicePixelRatio/)
  })
})

describe('snapping', () => {
  it('collects clip edges, playhead, and sequence end, sorted by frame', () => {
    const points = collectSnapPoints(makeTimeline(), 45)
    expect(points).toContainEqual({ frame: 0, kind: 'clip-start', clipId: 'clip-a' })
    expect(points).toContainEqual({ frame: 90, kind: 'clip-end', clipId: 'clip-a' })
    expect(points).toContainEqual({ frame: 150, kind: 'clip-start', clipId: 'clip-b' })
    expect(points).toContainEqual({ frame: 240, kind: 'clip-end', clipId: 'clip-b' })
    expect(points).toContainEqual({ frame: 30, kind: 'clip-start', clipId: 'clip-cap' })
    expect(points).toContainEqual({ frame: 45, kind: 'playhead' })
    expect(points).toContainEqual({ frame: 300, kind: 'sequence-end' })
    expect(points.map((p) => p.frame)).toEqual([...points.map((p) => p.frame)].sort((a, b) => a - b))
  })

  it('threshold is measured in pixels at the current zoom', () => {
    const points = collectSnapPoints(makeTimeline(), 45)
    // zoom 2 px/frame, default 10px threshold → 5 frames: 146 is 4 frames from 150.
    const atLowZoom = applySnap(146, points, { zoom: 2 })
    expect(atLowZoom).toEqual({ frame: 150, snapped: true, point: { frame: 150, kind: 'clip-start', clipId: 'clip-b' } })
    // zoom 10 px/frame → 1 frame threshold: the same 4-frame gap no longer snaps.
    const atHighZoom = applySnap(146, points, { zoom: 10 })
    expect(atHighZoom).toEqual({ frame: 146, snapped: false, point: null })
  })

  it('honors an explicit thresholdPx', () => {
    const points = collectSnapPoints(makeTimeline(), 45)
    expect(applySnap(140, points, { zoom: 2, thresholdPx: 30 }).frame).toBe(150)
    expect(applySnap(140, points, { zoom: 2, thresholdPx: 10 }).snapped).toBe(false)
  })

  it('exclude removes the dragged clip’s own edges from consideration', () => {
    const points = collectSnapPoints(makeTimeline(), 45)
    const excludeClipB = (point: { frame: number; kind: string }) =>
      'clipId' in point && (point as { clipId?: string }).clipId === 'clip-b'
    expect(applySnap(151, points, { zoom: 2 }).frame).toBe(150)
    expect(applySnap(151, points, { zoom: 2, exclude: excludeClipB }).snapped).toBe(false)
  })

  it('keeps the first candidate on distance ties', () => {
    const points = [
      { frame: 100, kind: 'clip-end' as const },
      { frame: 110, kind: 'clip-start' as const },
    ]
    const result = applySnap(105, points, { zoom: 2 })
    expect(result.snapped).toBe(true)
    expect(result.frame).toBe(100)
  })
})

describe('playback clock', () => {
  describe('server-safe import boundary', () => {
    it('constructs without rAF globals and fails loud only on play()', () => {
      expect(typeof (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame).toBe('undefined')
      const clock = createPlaybackClock({ fps: 30, durationFrames: 300 })
      expect(clock.getFrame()).toBe(0)
      expect(() => clock.play()).toThrow(/requestAnimationFrame/)
    })
  })

  describe('with stubbed rAF + performance', () => {
    let fakeNow = 0
    let nextRafId = 1
    let rafQueue: Array<{ id: number; cb: (time: number) => void }> = []

    const tickFrame = (ms: number): void => {
      fakeNow += ms
      const batch = rafQueue
      rafQueue = []
      for (const entry of batch) entry.cb(fakeNow)
    }

    beforeEach(() => {
      fakeNow = 0
      nextRafId = 1
      rafQueue = []
      vi.stubGlobal('performance', { now: () => fakeNow })
      vi.stubGlobal('requestAnimationFrame', (cb: (time: number) => void) => {
        const id = nextRafId
        nextRafId += 1
        rafQueue.push({ id, cb })
        return id
      })
      vi.stubGlobal('cancelAnimationFrame', (id: number) => {
        rafQueue = rafQueue.filter((entry) => entry.id !== id)
      })
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('advances by wall-clock time at the sequence fps', () => {
      const clock = createPlaybackClock({ fps: 30, durationFrames: 300 })
      const frames: number[] = []
      clock.subscribe((frame) => frames.push(frame))

      clock.play()
      tickFrame(500)
      expect(clock.getFrame()).toBe(15)
      tickFrame(500)
      expect(clock.getFrame()).toBe(30)
      expect(frames).toEqual([15, 30])
    })

    it('emits one callback per animation frame even when the frame holds', () => {
      const clock = createPlaybackClock({ fps: 30, durationFrames: 300 })
      const listener = vi.fn()
      clock.subscribe(listener)
      clock.play()
      tickFrame(10)
      tickFrame(10)
      expect(listener).toHaveBeenCalledTimes(2)
      expect(clock.getFrame()).toBe(0)
    })

    it('clamps at the final frame and pauses', () => {
      const clock = createPlaybackClock({ fps: 30, durationFrames: 60 })
      clock.play()
      tickFrame(3000)
      expect(clock.getFrame()).toBe(59)
      expect(clock.isPlaying()).toBe(false)
      tickFrame(1000)
      expect(clock.getFrame()).toBe(59)
    })

    it('play from the final frame restarts at 0', () => {
      const clock = createPlaybackClock({ fps: 30, durationFrames: 60 })
      clock.play()
      tickFrame(3000)
      clock.play()
      expect(clock.getFrame()).toBe(0)
      tickFrame(100)
      expect(clock.getFrame()).toBe(3)
    })

    it('seek clamps, rounds, notifies, and re-anchors mid-play', () => {
      const clock = createPlaybackClock({ fps: 30, durationFrames: 300 })
      const frames: number[] = []
      clock.subscribe((frame) => frames.push(frame))

      clock.seek(-5)
      expect(clock.getFrame()).toBe(0)
      clock.seek(99999)
      expect(clock.getFrame()).toBe(299)
      clock.seek(2.6)
      expect(clock.getFrame()).toBe(3)
      expect(frames).toEqual([0, 299, 3])

      clock.seek(0)
      clock.play()
      tickFrame(1000)
      expect(clock.getFrame()).toBe(30)
      clock.seek(100)
      tickFrame(1000)
      expect(clock.getFrame()).toBe(130)
    })

    it('pause freezes the playhead', () => {
      const clock = createPlaybackClock({ fps: 30, durationFrames: 300 })
      clock.play()
      tickFrame(500)
      clock.pause()
      expect(clock.isPlaying()).toBe(false)
      tickFrame(500)
      expect(clock.getFrame()).toBe(15)
    })

    it('dispose stops the loop and play afterwards throws', () => {
      const clock = createPlaybackClock({ fps: 30, durationFrames: 300 })
      const listener = vi.fn()
      clock.subscribe(listener)
      clock.play()
      clock.dispose()
      tickFrame(500)
      expect(listener).not.toHaveBeenCalled()
      expect(() => clock.play()).toThrow(/disposed/)
    })

    it('rejects invalid construction', () => {
      expect(() => createPlaybackClock({ fps: 0, durationFrames: 10 })).toThrow(/fps/)
      expect(() => createPlaybackClock({ fps: 30, durationFrames: 0 })).toThrow(/durationFrames/)
    })
  })
})
