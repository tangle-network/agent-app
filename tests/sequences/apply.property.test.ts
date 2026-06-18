/**
 * Property/fuzz harness for the sequences apply+validate pipeline. fast-check
 * drives random batches of operations through the SAME path a dispatcher uses
 * (validate-then-apply over a refreshing timeline) and asserts the two safety
 * invariants the surface promises:
 *
 *   1. Frame bounds — every persisted clip fits inside [0, sequenceDuration).
 *   2. Source window — every clip with an explicit out-point claims no more
 *      source frames than its [in, out) window holds.
 *
 * The contract is: an operation either lands cleanly (invariants hold) OR fails
 * loud (throws). A persisted clip that violates an invariant WITHOUT a throw is
 * a real bug — the test fails and names it. Operations that throw are expected
 * (a validator rejecting an out-of-bounds plan is the system working).
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { applySequenceOperation } from '../../src/sequences/apply'
import type { SequenceTimeline } from '../../src/sequences/model'
import type { SequenceOperation } from '../../src/sequences/operations'
import { createMemoryStore, makeClip, makeTimeline, makeTrack } from './fixtures'

const SEQUENCE_DURATION = 600
const FPS = 30

function freshTimeline(): SequenceTimeline {
  return makeTimeline({
    fps: FPS,
    durationFrames: SEQUENCE_DURATION,
    tracks: [
      makeTrack({ id: 'v1', kind: 'video', sortOrder: 0 }),
      makeTrack({ id: 'a1', kind: 'audio', sortOrder: 1 }),
      makeTrack({ id: 'c1', kind: 'caption', sortOrder: 2 }),
    ],
    clips: [makeClip({ id: 'seed', trackId: 'v1', startFrame: 0, durationFrames: 60 })],
  })
}

/** A generator of plausible-but-unverified operations: most are in-bounds, some
 *  deliberately stray out of bounds so the validator path is exercised too. */
function operationArbitrary(): fc.Arbitrary<SequenceOperation> {
  const frame = fc.integer({ min: -50, max: SEQUENCE_DURATION + 50 })
  const duration = fc.integer({ min: 1, max: 200 })
  return fc.oneof(
    fc.record({
      type: fc.constant('place_clip' as const),
      trackId: fc.constant('v1'),
      label: fc.constantFrom('a', 'clip', 'shot'),
      startFrame: frame,
      durationFrames: duration,
      media: fc.constant({ url: 'https://cdn.example.com/x.mp4', kind: 'video' as const }),
    }),
    fc.record({
      type: fc.constant('place_clip' as const),
      trackId: fc.constant('v1'),
      label: fc.constant('windowed'),
      startFrame: fc.integer({ min: 0, max: 400 }),
      durationFrames: duration,
      sourceInFrame: fc.integer({ min: 0, max: 50 }),
      sourceOutFrame: fc.integer({ min: 1, max: 300 }),
      media: fc.constant({ url: 'https://cdn.example.com/x.mp4', kind: 'video' as const }),
    }),
    fc.record({
      type: fc.constant('add_caption' as const),
      text: fc.constantFrom('hi', 'caption text'),
      language: fc.constant('en'),
      startFrame: fc.option(frame, { nil: undefined }),
      durationFrames: fc.option(duration, { nil: undefined }),
    }),
    fc.record({
      type: fc.constant('extend_sequence' as const),
      durationFrames: fc.integer({ min: 1, max: SEQUENCE_DURATION + 200 }),
    }),
  )
}

function assertTimelineInvariants(timeline: SequenceTimeline): void {
  const seqEnd = timeline.sequence.durationFrames
  for (const clip of timeline.clips) {
    expect(Number.isInteger(clip.startFrame), `clip ${clip.id} startFrame integer`).toBe(true)
    expect(clip.startFrame, `clip ${clip.id} startFrame >= 0`).toBeGreaterThanOrEqual(0)
    expect(clip.durationFrames, `clip ${clip.id} duration >= 1`).toBeGreaterThanOrEqual(1)
    expect(
      clip.startFrame + clip.durationFrames,
      `clip ${clip.id} fits in sequence [${seqEnd}]`,
    ).toBeLessThanOrEqual(seqEnd)
    if (clip.sourceOutFrame !== null && clip.sourceOutFrame !== undefined) {
      const window = clip.sourceOutFrame - clip.sourceInFrame
      expect(window, `clip ${clip.id} source window positive`).toBeGreaterThan(0)
      expect(
        clip.durationFrames,
        `clip ${clip.id} duration within source window [${clip.sourceInFrame},${clip.sourceOutFrame})`,
      ).toBeLessThanOrEqual(window)
    }
  }
}

describe('sequences apply — property: invariants hold or it fails loud', () => {
  it('random op batches never persist an out-of-bounds / over-claimed clip silently', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(operationArbitrary(), { minLength: 1, maxLength: 12 }), async (operations) => {
        const store = createMemoryStore(freshTimeline())
        const ctx = { playheadFrame: 0 }
        for (const op of operations) {
          try {
            // applySequenceOperation re-validates internally, so a clean return
            // is a real committed write — the invariant MUST hold after it.
            await applySequenceOperation(store, store.timeline, op, ctx)
          } catch {
            // Loud rejection is the system working; nothing to assert.
          }
          // After every op (committed or rejected) the persisted timeline must
          // still satisfy the invariants — a rejected op leaves prior state.
          assertTimelineInvariants(store.timeline)
        }
      }),
      { numRuns: 300 },
    )
  })
})
