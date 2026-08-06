/**
 * Sequences-area story fixtures. Self-contained on purpose: the shared
 * `src/stories/fixtures/` barrel was absent from the working tree when these
 * stories were written, so this file mirrors its `makePlaygroundReelTimeline`
 * and `makeSolidFrameProvider` byte-for-byte behavior (same shapes, same
 * solid-color provider — no media decode, no network) and adds the
 * multi-track, empty, and lookup variants the sequence stories need. If the
 * shared fixtures return, the reel/provider below can be re-pointed at them.
 */

import type {
  SequenceApplyResult,
  SequenceClip,
  SequenceOperation,
  SequenceTimeline,
  SequenceTrack,
} from '../../sequences'
import type { VideoFrameProvider } from '../../sequences-react'

// ── Two-track reel (video + captions) ─────────────────────────────────────────

export function makePlaygroundReelTimeline(): SequenceTimeline {
  const fps = 30
  const durationFrames = 600 // 20s
  const tracks: SequenceTrack[] = [
    { id: 'track-video', kind: 'video', name: 'Video', sortOrder: 0, locked: false, muted: false, metadata: {} },
    { id: 'track-caption', kind: 'caption', name: 'Captions', sortOrder: 1, locked: false, muted: false, metadata: {} },
  ]
  const clips: SequenceClip[] = [
    {
      id: 'clip-intro',
      trackId: 'track-video',
      label: 'intro.mp4',
      startFrame: 0,
      durationFrames: 180,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: false,
      media: { url: 'https://example.com/intro.mp4', kind: 'video', durationSeconds: 6 },
      metadata: {},
    },
    {
      id: 'clip-demo',
      trackId: 'track-video',
      label: 'demo.mp4',
      startFrame: 190,
      durationFrames: 240,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: false,
      media: { url: 'https://example.com/demo.mp4', kind: 'video', durationSeconds: 8 },
      metadata: {},
    },
    {
      id: 'clip-outro',
      trackId: 'track-video',
      label: 'outro.mp4',
      startFrame: 440,
      durationFrames: 150,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: false,
      media: { url: 'https://example.com/outro.mp4', kind: 'video', durationSeconds: 5 },
      metadata: {},
    },
    {
      id: 'cap-1',
      trackId: 'track-caption',
      label: 'Caption 1',
      startFrame: 10,
      durationFrames: 150,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: false,
      text: 'Meet the agent playground',
      language: 'en',
      metadata: {},
    },
    {
      id: 'cap-2',
      trackId: 'track-caption',
      label: 'Caption 2',
      startFrame: 200,
      durationFrames: 200,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: false,
      text: 'Audit every surface, light and dark',
      language: 'en',
      metadata: {},
    },
  ]
  return {
    sequence: {
      id: 'seq-1',
      title: 'Playground reel',
      fps,
      width: 1920,
      height: 1080,
      aspectRatio: '16:9',
      durationFrames,
      status: 'active',
      metadata: {},
    },
    tracks,
    clips,
  }
}

/** Prebuilt instance for stories that don't need isolation. */
const playgroundReelTimeline: SequenceTimeline = makePlaygroundReelTimeline()

// ── Multi-track studio cut (video ×2, audio, captions, locked reference, agent) ─

export function makeStudioCutTimeline(): SequenceTimeline {
  const fps = 30
  const durationFrames = 900 // 30s
  const tracks: SequenceTrack[] = [
    { id: 'track-ref', kind: 'reference', name: 'Storyboard ref', sortOrder: 0, locked: true, muted: false, metadata: {} },
    { id: 'track-a-roll', kind: 'video', name: 'A-roll', sortOrder: 1, locked: false, muted: false, metadata: {} },
    { id: 'track-b-roll', kind: 'video', name: 'B-roll', sortOrder: 2, locked: false, muted: false, metadata: {} },
    { id: 'track-music', kind: 'audio', name: 'Music', sortOrder: 3, locked: false, muted: false, metadata: {} },
    { id: 'track-captions', kind: 'caption', name: 'Captions', sortOrder: 4, locked: false, muted: false, metadata: {} },
    { id: 'track-agent', kind: 'agent', name: 'Agent passes', sortOrder: 5, locked: false, muted: false, metadata: {} },
  ]
  const clips: SequenceClip[] = [
    {
      id: 'clip-boards',
      trackId: 'track-ref',
      label: 'boards-v3.mp4',
      startFrame: 0,
      durationFrames: 900,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: false,
      media: { url: 'https://example.com/boards-v3.mp4', kind: 'video', durationSeconds: 30 },
      metadata: {},
    },
    {
      id: 'clip-cold-open',
      trackId: 'track-a-roll',
      label: 'cold-open.mp4',
      startFrame: 0,
      durationFrames: 150,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: false,
      media: { url: 'https://example.com/cold-open.mp4', kind: 'video', durationSeconds: 5 },
      metadata: {},
    },
    {
      id: 'clip-interview',
      trackId: 'track-a-roll',
      label: 'interview.mp4',
      startFrame: 170,
      durationFrames: 300,
      sourceInFrame: 45,
      sourceOutFrame: null,
      disabled: false,
      media: { url: 'https://example.com/interview.mp4', kind: 'video', durationSeconds: 20 },
      metadata: {},
    },
    {
      id: 'clip-alt-take',
      trackId: 'track-a-roll',
      label: 'alt-take (unused).mp4',
      startFrame: 490,
      durationFrames: 120,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: true,
      media: { url: 'https://example.com/alt-take.mp4', kind: 'video', durationSeconds: 4 },
      metadata: {},
    },
    {
      id: 'clip-walkout',
      trackId: 'track-a-roll',
      label: 'walkout.mp4',
      startFrame: 630,
      durationFrames: 240,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: false,
      media: { url: 'https://example.com/walkout.mp4', kind: 'video', durationSeconds: 8 },
      metadata: {},
    },
    {
      id: 'clip-overlay-map',
      trackId: 'track-b-roll',
      label: 'map-overlay.mp4',
      startFrame: 200,
      durationFrames: 120,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: false,
      media: { url: 'https://example.com/map-overlay.mp4', kind: 'video', durationSeconds: 4 },
      metadata: {},
    },
    {
      id: 'clip-overlay-ui',
      trackId: 'track-b-roll',
      label: 'ui-macro.mp4',
      startFrame: 560,
      durationFrames: 150,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: false,
      media: { url: 'https://example.com/ui-macro.mp4', kind: 'video', durationSeconds: 5 },
      metadata: {},
    },
    {
      id: 'clip-score',
      trackId: 'track-music',
      label: 'score-bed.mp3',
      startFrame: 0,
      durationFrames: 540,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: false,
      media: { url: 'https://example.com/score-bed.mp3', kind: 'audio', durationSeconds: 18 },
      metadata: {},
    },
    {
      id: 'clip-sting',
      trackId: 'track-music',
      label: 'sting.mp3',
      startFrame: 820,
      durationFrames: 60,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: false,
      media: { url: 'https://example.com/sting.mp3', kind: 'audio', durationSeconds: 2 },
      metadata: {},
    },
    {
      id: 'cap-hook',
      trackId: 'track-captions',
      label: 'Hook',
      startFrame: 15,
      durationFrames: 120,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: false,
      text: 'Every cut, reviewed by an agent.',
      language: 'en',
      metadata: {},
    },
    {
      id: 'cap-interview',
      trackId: 'track-captions',
      label: 'Interview quote',
      startFrame: 210,
      durationFrames: 210,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: false,
      text: '“We shipped the season in a weekend.”',
      language: 'en',
      metadata: {},
    },
    {
      id: 'cap-outro',
      trackId: 'track-captions',
      label: 'Outro CTA',
      startFrame: 660,
      durationFrames: 180,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: false,
      text: 'Cut your own at tangle.network',
      language: 'en',
      metadata: {},
    },
    {
      id: 'clip-agent-pass-1',
      trackId: 'track-agent',
      label: 'auto-cut pass',
      startFrame: 170,
      durationFrames: 300,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: false,
      metadata: {},
    },
    {
      id: 'clip-agent-pass-2',
      trackId: 'track-agent',
      label: 'caption draft',
      startFrame: 660,
      durationFrames: 180,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: false,
      metadata: {},
    },
  ]
  return {
    sequence: {
      id: 'seq-studio',
      title: 'Studio cut',
      fps,
      width: 1920,
      height: 1080,
      aspectRatio: '16:9',
      durationFrames,
      status: 'active',
      metadata: {},
    },
    tracks,
    clips,
  }
}

// ── Empty sequence (zero tracks → ghost lanes + empty state) ──────────────────

export function makeEmptyTimeline(): SequenceTimeline {
  return {
    sequence: {
      id: 'seq-empty',
      title: 'Untitled sequence',
      fps: 30,
      width: 1920,
      height: 1080,
      aspectRatio: '16:9',
      durationFrames: 600,
      status: 'draft',
      metadata: {},
    },
    tracks: [],
    clips: [],
  }
}

// ── Single clips for focused chip/row stories ─────────────────────────────────

export function makeAudioClip(): SequenceClip {
  return {
    id: 'clip-score-solo',
    trackId: 'track-music',
    label: 'score-bed.mp3',
    startFrame: 30,
    durationFrames: 300,
    sourceInFrame: 0,
    sourceOutFrame: null,
    disabled: false,
    media: { url: 'https://example.com/score-bed.mp3', kind: 'audio', durationSeconds: 18 },
    metadata: {},
  }
}

// ── Lookup helpers (strict-safe: throw instead of undefined-indexing) ─────────

export function trackOf(timeline: SequenceTimeline, trackId: string): SequenceTrack {
  const track = timeline.tracks.find((candidate) => candidate.id === trackId)
  if (!track) throw new Error(`fixture track missing: ${trackId}`)
  return track
}

export function clipsOf(timeline: SequenceTimeline, trackId: string): SequenceClip[] {
  return timeline.clips.filter((clip) => clip.trackId === trackId)
}

export function clipOf(timeline: SequenceTimeline, clipId: string): SequenceClip {
  const clip = timeline.clips.find((candidate) => candidate.id === clipId)
  if (!clip) throw new Error(`fixture clip missing: ${clipId}`)
  return clip
}

// ── Frame provider (deterministic solid color — no media decode) ─────────────

/**
 * Simplest valid `VideoFrameProvider`: paints a deterministic solid color into
 * the preview rect. `drawFrame` never touches network or <video>/<img>. The
 * color cycles by second so scrubbing is visibly distinct.
 */
export function makeSolidFrameProvider(): VideoFrameProvider {
  const palette = ['#1e293b', '#3b82f6', '#f59e0b', '#22c55e', '#ef4444', '#a855f7']
  return {
    async drawFrame(mediaUrl, sourceSeconds, ctx, rect) {
      const color = palette[Math.floor(sourceSeconds) % palette.length] ?? '#1e293b'
      ctx.fillStyle = color
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
      ctx.fillStyle = 'rgba(255,255,255,0.7)'
      ctx.font = `${Math.max(12, Math.round(rect.height / 12))}px sans-serif`
      ctx.fillText(
        `${mediaUrl.split('/').pop()} @ ${sourceSeconds.toFixed(1)}s`,
        rect.x + 12,
        rect.y + rect.height / 2,
      )
    },
    prefetch() {
      /* no-op: nothing to warm for a solid-color provider */
    },
    dispose() {
      /* no-op: no pooled resources */
    },
  }
}

/**
 * Host `onApplyOperations` stand-in: logs the operations and echoes an
 * index-aligned `SequenceApplyResult[]` so the editor's optimistic-id
 * reconciliation has a well-formed reply for any edit (playground pattern).
 */
export function makeEchoApply(timeline: SequenceTimeline) {
  return async (operations: SequenceOperation[]): Promise<SequenceApplyResult[]> => {
    console.log('onApplyOperations', operations)
    return operations.map(() => ({ kind: 'sequence' as const, sequence: timeline.sequence }))
  }
}
