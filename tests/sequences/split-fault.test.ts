/**
 * Fault-injection test for the split_clip safe-ordering invariant (apply.ts).
 *
 * The store is non-transactional (SQLite D1), so a split between two writes can
 * crash. apply.ts orders the writes tail-FIRST, head-shorten-SECOND on purpose:
 * if the second write fails, the cut content is visible TWICE (the new tail plus
 * the still-full-length original) — recoverable — instead of being silently
 * DROPPED from the timeline. This test forces a throw on exactly the second
 * write and proves the content was duplicated, never lost.
 */

import { describe, expect, it } from 'vitest'
import { applySequenceOperation } from '../../src/sequences/apply'
import type { SequenceTimeline } from '../../src/sequences/model'
import { createMemoryStore, makeClip, makeTimeline, makeTrack } from './fixtures'

function setup(): SequenceTimeline {
  return makeTimeline({
    fps: 30,
    durationFrames: 600,
    tracks: [makeTrack({ id: 'v1', kind: 'video', sortOrder: 0 })],
    clips: [
      makeClip({
        id: 'clip-a',
        trackId: 'v1',
        startFrame: 100,
        durationFrames: 80,
        sourceInFrame: 10,
        sourceOutFrame: 90,
        generationId: 'gen-1',
        metadata: { origin: 'fault-test' },
      }),
    ],
  })
}

describe('split_clip fault injection — content duplicated, never dropped', () => {
  it('a throw on the head-shorten write leaves the original full-length AND a created tail', async () => {
    const timeline = setup()
    const store = createMemoryStore(timeline)

    // Wrap updateClip so the FIRST update (the head-shorten, which is the second
    // store write of the split) throws. createClip (the tail) is untouched.
    const realUpdate = store.updateClip.bind(store)
    let updateCalls = 0
    store.updateClip = async (clipId, patch) => {
      updateCalls += 1
      if (updateCalls === 1) throw new Error('simulated D1 write failure mid-split')
      return realUpdate(clipId, patch)
    }

    await expect(
      applySequenceOperation(store, timeline, { type: 'split_clip', clipId: 'clip-a', atFrame: 130 }, ctx()),
    ).rejects.toThrow('simulated D1 write failure mid-split')

    const clips = store.timeline.clips
    // The original head must STILL hold its full pre-split duration — the cut
    // content was not removed by the failed shorten.
    const original = clips.find((clip) => clip.id === 'clip-a')
    expect(original, 'original clip survives').toBeDefined()
    expect(original!.durationFrames, 'original keeps full length (head not shortened)').toBe(80)
    expect(original!.startFrame + original!.durationFrames, 'original still covers up to frame 180').toBe(180)

    // The tail was created BEFORE the failing write, so the cut content is now
    // present a SECOND time — visible twice, recoverable, never dropped.
    const tail = clips.find((clip) => clip.id !== 'clip-a' && clip.startFrame === 130)
    expect(tail, 'tail clip was created before the failure').toBeDefined()
    expect(tail!.durationFrames, 'tail covers the cut-to-end span').toBe(50)
    expect(tail!.sourceInFrame, 'tail source advances by the cut offset').toBe(10 + 30)

    // The frames 130..180 are covered by BOTH clips — duplication, not a gap.
    const coverAt = (frame: number) =>
      clips.filter((c) => c.startFrame <= frame && frame < c.startFrame + c.durationFrames)
    expect(coverAt(150).length, 'cut region covered twice (duplicated, not dropped)').toBe(2)
  })
})

function ctx() {
  return { playheadFrame: 0 }
}
