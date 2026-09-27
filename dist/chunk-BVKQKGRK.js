// src/sequences/model.ts
var MIN_SEQUENCE_CLIP_FRAMES = 1;
function secondsToFrames(seconds, fps) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("seconds must be a non-negative finite number");
  assertFps(fps);
  return Math.round(seconds * fps);
}
function framesToSeconds(frames, fps) {
  if (!Number.isInteger(frames) || frames < 0) throw new Error("frames must be a non-negative integer");
  assertFps(fps);
  return frames / fps;
}
function formatSeconds(seconds) {
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(2)}s`;
}
function formatTimecode(frames, fps) {
  assertFps(fps);
  if (!Number.isInteger(frames) || frames < 0) throw new Error("frames must be a non-negative integer");
  const totalSeconds = Math.floor(frames / fps);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const residualFrames = frames % fps;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(residualFrames).padStart(2, "0")}`;
}
function clampClipStart(input) {
  assertSequenceDuration(input.sequenceDurationFrames);
  assertClipDuration(input.durationFrames);
  return Math.max(0, Math.min(input.sequenceDurationFrames - input.durationFrames, input.startFrame));
}
function clampClipDuration(input) {
  assertSequenceDuration(input.sequenceDurationFrames);
  if (input.startFrame < 0 || input.startFrame >= input.sequenceDurationFrames) {
    throw new Error("startFrame must be inside the sequence");
  }
  return Math.max(MIN_SEQUENCE_CLIP_FRAMES, Math.min(input.durationFrames, input.sequenceDurationFrames - input.startFrame));
}
function assertClipFitsSequence(input) {
  assertSequenceDuration(input.sequenceDurationFrames);
  assertClipDuration(input.durationFrames);
  if (!Number.isInteger(input.startFrame) || input.startFrame < 0) {
    throw new Error(`${input.label} startFrame must be a non-negative integer`);
  }
  if (input.startFrame + input.durationFrames > input.sequenceDurationFrames) {
    throw new Error(`${input.label} extends beyond the sequence duration`);
  }
}
function chooseCaptionPlacement(input) {
  const preferredDurationFrames = Math.min(input.fps * 3, input.sequenceDurationFrames);
  const minimumDurationFrames = Math.min(input.fps, preferredDurationFrames);
  const occupied = input.occupiedIntervals.map((interval) => ({
    startFrame: Math.max(0, interval.startFrame),
    endFrame: Math.min(input.sequenceDurationFrames, interval.endFrame)
  })).filter((interval) => interval.endFrame > interval.startFrame).sort((a, b) => a.startFrame - b.startFrame);
  const merged = [];
  for (const interval of occupied) {
    const last = merged[merged.length - 1];
    if (last && interval.startFrame <= last.endFrame) last.endFrame = Math.max(last.endFrame, interval.endFrame);
    else merged.push({ ...interval });
  }
  const gaps = [];
  let cursor = 0;
  for (const interval of merged) {
    if (interval.startFrame > cursor) gaps.push({ startFrame: cursor, endFrame: interval.startFrame });
    cursor = interval.endFrame;
  }
  if (cursor < input.sequenceDurationFrames) gaps.push({ startFrame: cursor, endFrame: input.sequenceDurationFrames });
  const usable = gaps.filter((gap2) => gap2.endFrame - gap2.startFrame >= minimumDurationFrames);
  const latestUsable = usable[usable.length - 1];
  if (latestUsable === void 0) {
    throw new Error(
      `no free gap of at least ${minimumDurationFrames} frames on the caption track \u2014 pass explicit startFrame/durationFrames or clear space first`
    );
  }
  const gap = usable.find((candidate) => candidate.endFrame > input.playheadFrame) ?? latestUsable;
  const durationFrames = Math.min(preferredDurationFrames, gap.endFrame - gap.startFrame);
  const startFrame = Math.max(gap.startFrame, Math.min(input.playheadFrame, gap.endFrame - durationFrames));
  return { startFrame, durationFrames };
}
function snapshotFrame(timeline, frame) {
  if (!Number.isInteger(frame) || frame < 0) throw new Error("frame must be a non-negative integer");
  if (frame >= timeline.sequence.durationFrames) {
    throw new Error(`frame ${frame} is beyond the sequence (${timeline.sequence.durationFrames} frames)`);
  }
  const trackById = new Map(timeline.tracks.map((track) => [track.id, track]));
  const sortedTracks = [...timeline.tracks].sort((a, b) => a.sortOrder - b.sortOrder);
  const trackOrder = new Map(sortedTracks.map((track, index) => [track.id, index]));
  const active = timeline.clips.filter((clip) => !clip.disabled && clip.startFrame <= frame && frame < clip.startFrame + clip.durationFrames).map((clip) => {
    const track = trackById.get(clip.trackId);
    if (!track) throw new Error(`clip ${clip.id} references unknown track ${clip.trackId}`);
    return { track, clip };
  }).sort((a, b) => (trackOrder.get(a.track.id) ?? 0) - (trackOrder.get(b.track.id) ?? 0));
  const captions = active.filter(({ track, clip }) => track.kind === "caption" && typeof clip.text === "string" && clip.text.length > 0).map(({ clip }) => ({ text: clip.text, language: clip.language, clipId: clip.id }));
  return {
    frame,
    seconds: framesToSeconds(frame, timeline.sequence.fps),
    active,
    captions
  };
}
function trackIntervals(timeline, trackId) {
  return timeline.clips.filter((clip) => clip.trackId === trackId && !clip.disabled).map((clip) => ({ startFrame: clip.startFrame, endFrame: clip.startFrame + clip.durationFrames })).sort((a, b) => a.startFrame - b.startFrame);
}
function assertFps(fps) {
  if (!Number.isInteger(fps) || fps <= 0) throw new Error("fps must be a positive integer");
}
function assertSequenceDuration(sequenceDurationFrames) {
  if (!Number.isInteger(sequenceDurationFrames) || sequenceDurationFrames < MIN_SEQUENCE_CLIP_FRAMES) {
    throw new Error("sequenceDurationFrames must be a positive integer");
  }
}
function assertClipDuration(durationFrames) {
  if (!Number.isInteger(durationFrames) || durationFrames < MIN_SEQUENCE_CLIP_FRAMES) {
    throw new Error("durationFrames must be a positive integer");
  }
}

export {
  MIN_SEQUENCE_CLIP_FRAMES,
  secondsToFrames,
  framesToSeconds,
  formatSeconds,
  formatTimecode,
  clampClipStart,
  clampClipDuration,
  assertClipFitsSequence,
  chooseCaptionPlacement,
  snapshotFrame,
  trackIntervals
};
//# sourceMappingURL=chunk-BVKQKGRK.js.map