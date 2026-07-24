/**
 * Caption planning — pure, server-safe helpers that turn transcripts into
 * frame-typed caption chunks and answer "are captions complete?" per language.
 * No store access, no React, no provider coupling: products feed transcript
 * segments in (from any transcription provider) and get chunk bounds out,
 * ready to become `add_caption` operations.
 *
 * All outputs are integer frames at the sequence fps. Seconds appear only on
 * the transcript-segment inputs, because that is what transcription providers
 * emit; the conversion happens exactly once, here.
 */

import {
  MIN_SEQUENCE_CLIP_FRAMES,
  secondsToFrames,
  type SequenceTimeline,
  type TimelineInterval,
} from './model'

/** Server twin of `TranscriptionSegment` (../sequences-react/contracts) —
 *  structurally identical so react-side transcription output feeds
 *  `buildCaptionChunks` without mapping. Keep the shapes in lockstep. */
export interface TranscriptSegment {
  text: string
  startSeconds: number
  endSeconds: number
}

/** One caption clip's worth of text with its timeline bounds. */
export interface CaptionChunk {
  text: string
  startFrame: number
  durationFrames: number
}

/** Define options to configure caption chunk size, duration, and frame rate constraints */
export interface BuildCaptionChunksOptions {
  /** Upper bound on words per caption; segments split on word boundaries. */
  maxWordsPerChunk?: number
  /** Readability floor — chunks shorter than this are extended, never
   *  overlapped: the following chunk's start is pushed forward instead. */
  minDurationSeconds?: number
  fps: number
}

const DEFAULT_MAX_WORDS_PER_CHUNK = 8
const DEFAULT_MIN_DURATION_SECONDS = 0.8

/**
 * Split transcript segments into caption chunks. Within each segment, time is
 * apportioned to chunks by word count (a constant words-per-second estimate).
 * Guarantees, across the WHOLE output regardless of segment boundaries:
 *
 * - starts are strictly increasing and chunks never overlap
 * - every chunk lasts at least the min-duration clamp (and at least
 *   `MIN_SEQUENCE_CLIP_FRAMES`)
 * - a chunk may extend past its segment's end by at most the clamp — the cost
 *   of the readability floor on short tails
 *
 * Whitespace-only segments produce no chunks. Segments may arrive unsorted
 * (providers emit per-channel batches); they are ordered by start before
 * chunking so the no-overlap guarantee holds.
 */
export function buildCaptionChunks(
  segments: TranscriptSegment[],
  opts: BuildCaptionChunksOptions,
): CaptionChunk[] {
  const maxWordsPerChunk = opts.maxWordsPerChunk ?? DEFAULT_MAX_WORDS_PER_CHUNK
  const minDurationSeconds = opts.minDurationSeconds ?? DEFAULT_MIN_DURATION_SECONDS
  if (!Number.isInteger(maxWordsPerChunk) || maxWordsPerChunk < 1) {
    throw new Error('maxWordsPerChunk must be a positive integer')
  }
  if (!Number.isFinite(minDurationSeconds) || minDurationSeconds < 0) {
    throw new Error('minDurationSeconds must be a non-negative finite number')
  }
  segments.forEach((segment, index) => {
    if (!Number.isFinite(segment.startSeconds) || segment.startSeconds < 0) {
      throw new Error(`segment ${index} startSeconds must be a non-negative finite number`)
    }
    if (!Number.isFinite(segment.endSeconds) || segment.endSeconds < segment.startSeconds) {
      throw new Error(`segment ${index} endSeconds must be a finite number >= startSeconds`)
    }
  })
  const minDurationFrames = Math.max(secondsToFrames(minDurationSeconds, opts.fps), MIN_SEQUENCE_CLIP_FRAMES)

  const ordered = [...segments].sort((a, b) => a.startSeconds - b.startSeconds)
  const chunks: CaptionChunk[] = []
  // Earliest frame the next chunk may start at — the no-overlap invariant.
  let cursorFrame = 0

  for (const segment of ordered) {
    const words = segment.text.trim().split(/\s+/).filter((word) => word.length > 0)
    if (words.length === 0) continue
    const segmentDurationSeconds = segment.endSeconds - segment.startSeconds
    const chunkCount = Math.ceil(words.length / maxWordsPerChunk)

    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const wordStart = chunkIndex * maxWordsPerChunk
      const wordEnd = Math.min(wordStart + maxWordsPerChunk, words.length)
      const naturalStartFrame = secondsToFrames(
        segment.startSeconds + (wordStart / words.length) * segmentDurationSeconds,
        opts.fps,
      )
      const naturalEndFrame = secondsToFrames(
        segment.startSeconds + (wordEnd / words.length) * segmentDurationSeconds,
        opts.fps,
      )
      const startFrame = Math.max(naturalStartFrame, cursorFrame)
      const durationFrames = Math.max(naturalEndFrame - startFrame, minDurationFrames)
      chunks.push({
        text: words.slice(wordStart, wordEnd).join(' '),
        startFrame,
        durationFrames,
      })
      cursorFrame = startFrame + durationFrames
    }
  }

  return chunks
}

/** Liberal BCP-47 shape — primary language subtag plus optional 2-8 char
 *  subtags. Deliberately permissive about subtag semantics (no registry
 *  lookup); strict about structure so garbage tags fail before fan-out. */
const LANGUAGE_TAG_SHAPE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

/**
 * Normalize a BCP-47 tag to conventional casing: primary subtag lowercase,
 * 4-letter script subtags Title Case, 2-letter region subtags UPPER, all other
 * subtags lowercase. Throws on empty or structurally invalid tags.
 */
export function normalizeLanguageTag(tag: string): string {
  const trimmed = tag.trim()
  if (trimmed.length === 0) throw new Error('language tag must be a non-empty string')
  const normalized = trimmed
    .split('-')
    .map((subtag, index) => {
      const lower = subtag.toLowerCase()
      if (index === 0) return lower
      if (subtag.length === 4 && /^[a-z]+$/.test(lower)) return lower.charAt(0).toUpperCase() + lower.slice(1)
      if (subtag.length === 2 && /^[a-z]+$/.test(lower)) return lower.toUpperCase()
      return lower
    })
    .join('-')
  if (!LANGUAGE_TAG_SHAPE.test(normalized)) {
    throw new Error(`invalid BCP-47 language tag '${tag}' — expected a shape like 'en', 'pt-BR', or 'zh-Hans'`)
  }
  return normalized
}

/** Define options to specify target languages and an optional source language for fan-out operations */
export interface LanguageFanoutOptions {
  languages: string[]
  /** Excluded from the plan (exact normalized match only — 'en' does not
   *  exclude 'en-US'; a regional variant of the source is still a valid
   *  fan-out target). */
  sourceLanguage?: string
}

/**
 * Plan which caption languages to generate: normalized, deduped (first
 * occurrence wins), source excluded. Throws on an empty request or any
 * invalid tag — a malformed fan-out request must fail before any generation
 * is queued. Returns [] when every requested language IS the source; the
 * caller reports "nothing to fan out" rather than erroring.
 */
export function planLanguageFanout(opts: LanguageFanoutOptions): string[] {
  if (opts.languages.length === 0) {
    throw new Error('languages must contain at least one BCP-47 tag')
  }
  const source = opts.sourceLanguage === undefined ? null : normalizeLanguageTag(opts.sourceLanguage)
  const seen = new Set<string>()
  const planned: string[] = []
  for (const raw of opts.languages) {
    const tag = normalizeLanguageTag(raw)
    if (tag === source || seen.has(tag)) continue
    seen.add(tag)
    planned.push(tag)
  }
  return planned
}

/** Coverage for one caption language across the sequence. `language` is the
 *  clip's stored tag verbatim (no normalization — coverage reports what is
 *  actually on the timeline); null groups caption clips with no tag. */
export interface CaptionCoverageEntry {
  language: string | null
  coveredFrames: number
  totalFrames: number
  /** Uncovered intervals, ascending; endFrame exclusive. */
  gaps: TimelineInterval[]
}

/**
 * Per-language caption coverage over [0, durationFrames). A frame counts as
 * covered when an enabled, non-empty-text clip on a caption-kind track spans
 * it. Overlapping clips merge (no double counting). Returns one entry per
 * distinct language, null first then lexicographic; [] when the timeline has
 * no caption clips at all.
 */
export function captionCoverage(timeline: SequenceTimeline): CaptionCoverageEntry[] {
  const totalFrames = timeline.sequence.durationFrames
  if (!Number.isInteger(totalFrames) || totalFrames < 1) {
    throw new Error('sequence durationFrames must be a positive integer')
  }
  const captionTrackIds = new Set(
    timeline.tracks.filter((track) => track.kind === 'caption').map((track) => track.id),
  )

  const intervalsByLanguage = new Map<string | null, TimelineInterval[]>()
  for (const clip of timeline.clips) {
    if (!captionTrackIds.has(clip.trackId) || clip.disabled) continue
    if (typeof clip.text !== 'string' || clip.text.length === 0) continue
    const startFrame = Math.max(0, clip.startFrame)
    const endFrame = Math.min(totalFrames, clip.startFrame + clip.durationFrames)
    if (endFrame <= startFrame) continue
    const language = clip.language ?? null
    const intervals = intervalsByLanguage.get(language)
    if (intervals) intervals.push({ startFrame, endFrame })
    else intervalsByLanguage.set(language, [{ startFrame, endFrame }])
  }

  const entries: CaptionCoverageEntry[] = []
  for (const [language, intervals] of intervalsByLanguage) {
    const merged = mergeIntervals(intervals)
    const coveredFrames = merged.reduce((sum, interval) => sum + (interval.endFrame - interval.startFrame), 0)
    entries.push({ language, coveredFrames, totalFrames, gaps: complementIntervals(merged, totalFrames) })
  }
  entries.sort((a, b) => {
    if (a.language === null) return b.language === null ? 0 : -1
    if (b.language === null) return 1
    return a.language < b.language ? -1 : a.language > b.language ? 1 : 0
  })
  return entries
}

/** Merge overlapping/adjacent intervals. Input need not be sorted; output is
 *  ascending and disjoint. */
function mergeIntervals(intervals: TimelineInterval[]): TimelineInterval[] {
  const sorted = [...intervals].sort((a, b) => a.startFrame - b.startFrame)
  const merged: TimelineInterval[] = []
  for (const interval of sorted) {
    const last = merged[merged.length - 1]
    if (last && interval.startFrame <= last.endFrame) {
      last.endFrame = Math.max(last.endFrame, interval.endFrame)
    } else {
      merged.push({ startFrame: interval.startFrame, endFrame: interval.endFrame })
    }
  }
  return merged
}

/** Complement of disjoint sorted intervals within [0, totalFrames). */
function complementIntervals(merged: TimelineInterval[], totalFrames: number): TimelineInterval[] {
  const gaps: TimelineInterval[] = []
  let cursor = 0
  for (const interval of merged) {
    if (interval.startFrame > cursor) gaps.push({ startFrame: cursor, endFrame: interval.startFrame })
    cursor = Math.max(cursor, interval.endFrame)
  }
  if (cursor < totalFrames) gaps.push({ startFrame: cursor, endFrame: totalFrames })
  return gaps
}
