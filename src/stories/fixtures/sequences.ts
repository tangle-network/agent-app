/**
 * Sequences fixtures: a video + caption `SequenceTimeline` for the timeline
 * editor, and a dependency-free `VideoFrameProvider` that paints deterministic
 * solid frames — no media decode, no network — so the preview monitor renders
 * something real in stories.
 */

import type { SequenceClip, SequenceTimeline, SequenceTrack } from '../../sequences'
import type { VideoFrameProvider } from '../../sequences-react'

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
export const playgroundReelTimeline: SequenceTimeline = makePlaygroundReelTimeline()

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
