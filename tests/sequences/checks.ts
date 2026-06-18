/**
 * Deterministic timeline check helpers — the in-repo port of the live eval's
 * sequences checks (design-canvas-demo/src/sequences-checks.ts). Pure frame
 * math over a `SequenceTimeline` + decision log: clip counts/order, video
 * gaps, caption coverage, export queue state, decision-log completeness. No
 * LLM, no rendering, no demo deps — the same shape the deterministic eval runs
 * so a green CI here means the agent-drivable seam is gated without a key.
 */

import type { SequenceClip, SequenceDecision, SequenceTimeline, SequenceTrack } from '../../src/sequences/model'

interface SequenceCheckResult {
  id: string
  passed: boolean
  detail: string
}

export type SequenceCheckFn = (
  timeline: SequenceTimeline,
  decisions: SequenceDecision[],
) => SequenceCheckResult

function tracksByKind(timeline: SequenceTimeline, kind: SequenceTrack['kind']): SequenceTrack[] {
  return timeline.tracks.filter((track) => track.kind === kind)
}

function clipsOnTrack(timeline: SequenceTimeline, trackId: string): SequenceClip[] {
  return timeline.clips
    .filter((clip) => clip.trackId === trackId)
    .sort((a, b) => a.startFrame - b.startFrame)
}

function clipsOnKind(timeline: SequenceTimeline, kind: SequenceTrack['kind']): SequenceClip[] {
  const ids = new Set(tracksByKind(timeline, kind).map((track) => track.id))
  return timeline.clips
    .filter((clip) => ids.has(clip.trackId))
    .sort((a, b) => a.startFrame - b.startFrame)
}

function clipEnd(clip: SequenceClip): number {
  return clip.startFrame + clip.durationFrames
}

/** Frame intervals NOT covered by any enabled clip on a kind, within [0, end). */
function gapsOnKind(
  timeline: SequenceTimeline,
  kind: SequenceTrack['kind'],
  end: number,
): Array<{ from: number; to: number }> {
  const intervals = clipsOnKind(timeline, kind)
    .filter((clip) => !clip.disabled)
    .map((clip) => ({ from: clip.startFrame, to: clipEnd(clip) }))
    .sort((a, b) => a.from - b.from)
  const gaps: Array<{ from: number; to: number }> = []
  let cursor = 0
  for (const interval of intervals) {
    if (interval.from > cursor) gaps.push({ from: cursor, to: interval.from })
    cursor = Math.max(cursor, interval.to)
  }
  if (cursor < end) gaps.push({ from: cursor, to: end })
  return gaps
}

/** True iff any two enabled clips on the same track overlap. */
function hasOverlapOnKind(timeline: SequenceTimeline, kind: SequenceTrack['kind']): boolean {
  for (const track of tracksByKind(timeline, kind)) {
    const clips = clipsOnTrack(timeline, track.id).filter((clip) => !clip.disabled)
    for (let i = 1; i < clips.length; i++) {
      if ((clips[i] as SequenceClip).startFrame < clipEnd(clips[i - 1] as SequenceClip)) return true
    }
  }
  return false
}

function captionLanguages(timeline: SequenceTimeline): Set<string> {
  const langs = new Set<string>()
  for (const clip of clipsOnKind(timeline, 'caption')) {
    if (!clip.disabled && typeof clip.text === 'string' && clip.text.length > 0 && typeof clip.language === 'string') {
      langs.add(clip.language.toLowerCase())
    }
  }
  return langs
}

/** At least `min` enabled clips on video tracks. */
export function checkVideoClipCount(min: number): SequenceCheckFn {
  return (timeline) => {
    const clips = clipsOnKind(timeline, 'video').filter((c) => !c.disabled)
    return {
      id: 'video-clip-count',
      passed: clips.length >= min,
      detail: `${clips.length} enabled video clip(s); expected >= ${min}`,
    }
  }
}

/** Enabled video clips never overlap (the assembled cut is a clean lay-down). */
export function checkVideoClipsOrdered(): SequenceCheckFn {
  return (timeline) => {
    const overlap = hasOverlapOnKind(timeline, 'video')
    return {
      id: 'video-clips-ordered',
      passed: !overlap,
      detail: overlap ? 'two enabled video clips overlap' : 'no enabled video clips overlap',
    }
  }
}

/** No gap on the video track up to `coverToFrames`; omitted → cover to the last
 *  clip end (no interior holes). */
export function checkNoVideoGaps(coverToFrames?: number): SequenceCheckFn {
  return (timeline) => {
    const clips = clipsOnKind(timeline, 'video').filter((c) => !c.disabled)
    if (clips.length === 0) {
      return { id: 'no-video-gaps', passed: false, detail: 'no video clips to cover' }
    }
    const end = coverToFrames ?? Math.max(...clips.map(clipEnd))
    const gaps = gapsOnKind(timeline, 'video', end).filter((g) => g.to > g.from)
    return {
      id: 'no-video-gaps',
      passed: gaps.length === 0,
      detail:
        gaps.length === 0
          ? `video covered contiguously to frame ${end}`
          : `gap(s) on video track: ${gaps.map((g) => `${g.from}-${g.to}`).join(', ')}`,
    }
  }
}

/** Every listed BCP-47 language has at least one caption clip. */
export function checkCaptionLanguages(languages: string[]): SequenceCheckFn {
  return (timeline) => {
    const present = captionLanguages(timeline)
    const missing = languages.filter((lang) => !present.has(lang.toLowerCase()))
    return {
      id: 'caption-languages',
      passed: missing.length === 0,
      detail:
        missing.length === 0
          ? `all languages present: ${languages.join(', ')}`
          : `missing caption language(s): ${missing.join(', ')} (present: ${[...present].join(', ') || 'none'})`,
    }
  }
}

/** At least `min` caption clips in the given language. */
export function checkCaptionCount(language: string, min: number): SequenceCheckFn {
  return (timeline) => {
    const count = clipsOnKind(timeline, 'caption').filter(
      (clip) =>
        !clip.disabled &&
        typeof clip.language === 'string' &&
        clip.language.toLowerCase() === language.toLowerCase() &&
        typeof clip.text === 'string' &&
        clip.text.length > 0,
    ).length
    return {
      id: `caption-count-${language.toLowerCase()}`,
      passed: count >= min,
      detail: `${count} ${language} caption(s); expected >= ${min}`,
    }
  }
}

/** At least one export queued, optionally constrained to a specific format. The
 *  decision log is the source of truth — the export tool records an agent_edit
 *  row carrying the queue_export instruction. */
export function checkExportQueued(format?: string): SequenceCheckFn {
  return (_timeline, decisions) => {
    const queued = decisions.filter(
      (d) => d.kind === 'export' || (d.kind === 'agent_edit' && /queue_export/.test(d.instruction)),
    )
    const formatHit =
      format === undefined
        ? queued.length > 0
        : decisions.some((d) => new RegExp(`"format"\\s*:\\s*"${format}"`).test(d.instruction))
    return {
      id: 'export-queued',
      passed: formatHit,
      detail: formatHit
        ? `export queued${format ? ` (${format})` : ''}`
        : `no ${format ?? ''} export queued in the decision log`,
    }
  }
}

/** At least `min` agent_edit rows — every mutating agent tool call left an
 *  auditable decision. */
export function checkDecisionLogComplete(min: number): SequenceCheckFn {
  return (_timeline, decisions) => {
    const agentEdits = decisions.filter((d) => d.kind === 'agent_edit')
    return {
      id: 'decision-log-complete',
      passed: agentEdits.length >= min,
      detail: `${agentEdits.length} agent_edit decision row(s); expected >= ${min}`,
    }
  }
}

/** Video clip count reached `minVideoClips` (a split raised it above the base). */
export function checkSplitOccurred(minVideoClips: number): SequenceCheckFn {
  return (timeline) => {
    const count = clipsOnKind(timeline, 'video').length
    return {
      id: 'split-occurred',
      passed: count >= minVideoClips,
      detail: `${count} video clip(s) after split; expected >= ${minVideoClips}`,
    }
  }
}
