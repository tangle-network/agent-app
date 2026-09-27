import {
  MIN_SEQUENCE_CLIP_FRAMES,
  assertClipFitsSequence,
  chooseCaptionPlacement,
  clampClipStart,
  formatTimecode,
  framesToSeconds,
  secondsToFrames,
  snapshotFrame,
  trackIntervals
} from "./chunk-BVKQKGRK.js";

// src/sequences-react/components/TimelineEditor.tsx
import { useEffect as useEffect3, useMemo as useMemo3, useRef as useRef3, useState as useState3, useSyncExternalStore } from "react";

// src/sequences-react/contracts.ts
var DEFAULT_TIMELINE_LABELS = {
  splitClip: "Split here",
  splitClipAriaLabel: "Split clip at playhead",
  addCaption: "Add caption",
  addCaptionAriaLabel: "Add caption at playhead",
  createExport: "Export\u2026",
  emptyTitle: "This sequence has no tracks yet",
  emptyBody: "Start from a template, drop in a clip, or hand it to the agent.",
  emptyTemplateDoor: "Start from a template",
  emptyClipDoor: "Add a clip",
  emptyAgentDoor: "Ask the agent",
  smallScreenTitle: "Best edited on a larger screen",
  smallScreenBody: "The timeline needs room to scrub and trim. Open this cut on a tablet or desktop to edit.",
  ghostVideoLane: "Video",
  ghostCaptionLane: "Captions"
};

// src/sequences-react/engine/command-stack.ts
var COMMAND_HISTORY_LIMIT = 200;
function createCommandStack(initial) {
  let state = {
    timeline: initial,
    playheadFrame: 0,
    selectedClipIds: [],
    zoom: 1,
    scrollLeft: 0
  };
  const undoStack = [];
  const redoStack = [];
  const listeners = /* @__PURE__ */ new Set();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    execute(command) {
      state = command.execute(state);
      undoStack.push(command);
      if (undoStack.length > COMMAND_HISTORY_LIMIT) {
        undoStack.splice(0, undoStack.length - COMMAND_HISTORY_LIMIT);
      }
      redoStack.length = 0;
      notify();
    },
    // Both transforms run BEFORE the stacks move: a throwing transform (the
    // documented missing-clip path after reset()) leaves history and state
    // exactly as they were, so the entry is never silently destroyed and the
    // caller can retry after the next refresh restores the target.
    undo() {
      const command = undoStack[undoStack.length - 1];
      if (!command) throw new Error("nothing to undo \u2014 guard with canUndo() before calling undo()");
      state = command.undo(state);
      undoStack.pop();
      redoStack.push(command);
      notify();
    },
    redo() {
      const command = redoStack[redoStack.length - 1];
      if (!command) throw new Error("nothing to redo \u2014 guard with canRedo() before calling redo()");
      state = command.execute(state);
      redoStack.pop();
      undoStack.push(command);
      notify();
    },
    canUndo() {
      return undoStack.length > 0;
    },
    canRedo() {
      return redoStack.length > 0;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState() {
      return state;
    },
    /** Rebase onto a server-refreshed timeline. History survives (see module
     *  header); selection drops ids the refresh removed and the playhead
     *  clamps into the new duration so view state never dangles. */
    reset(timeline) {
      const liveClipIds = new Set(timeline.clips.map((clip) => clip.id));
      state = {
        ...state,
        timeline,
        playheadFrame: Math.max(0, Math.min(state.playheadFrame, timeline.sequence.durationFrames - 1)),
        selectedClipIds: state.selectedClipIds.filter((id) => liveClipIds.has(id))
      };
      notify();
    }
  };
}

// src/sequences-react/engine/commands.ts
var identityClipId = (clipId) => clipId;
function requireClip(timeline, clipId, context) {
  const clip = timeline.clips.find((candidate) => candidate.id === clipId);
  if (!clip) throw new Error(`${context}: clip ${clipId} does not exist in sequence ${timeline.sequence.id}`);
  return clip;
}
function requireUnlockedTrack(timeline, trackId, context) {
  const track = timeline.tracks.find((candidate) => candidate.id === trackId);
  if (!track) throw new Error(`${context}: track ${trackId} does not exist in sequence ${timeline.sequence.id}`);
  if (track.locked) throw new Error(`${context}: track ${track.name} (${trackId}) is locked`);
  return track;
}
function assertNewClipId(timeline, clipId, context) {
  if (timeline.clips.some((candidate) => candidate.id === clipId)) {
    throw new Error(`${context}: clip id ${clipId} already exists in sequence ${timeline.sequence.id}`);
  }
}
function patchClip(state, clipId, context, patch) {
  requireClip(state.timeline, clipId, context);
  return {
    ...state,
    timeline: {
      ...state.timeline,
      clips: state.timeline.clips.map((clip) => clip.id === clipId ? { ...clip, ...patch } : clip)
    }
  };
}
function insertClip(state, clip, context) {
  assertNewClipId(state.timeline, clip.id, context);
  return {
    ...state,
    timeline: { ...state.timeline, clips: [...state.timeline.clips, clip] }
  };
}
function removeClip(state, clipId, context) {
  requireClip(state.timeline, clipId, context);
  return {
    ...state,
    timeline: {
      ...state.timeline,
      clips: state.timeline.clips.filter((clip) => clip.id !== clipId)
    },
    selectedClipIds: state.selectedClipIds.filter((id) => id !== clipId)
  };
}
function moveClipCommand(input) {
  const context = "move_clip";
  const clip = requireClip(input.timeline, input.clipId, context);
  const targetTrackId = input.trackId ?? clip.trackId;
  requireUnlockedTrack(input.timeline, targetTrackId, context);
  if (!Number.isInteger(input.startFrame)) throw new Error(`${context}: startFrame must be an integer frame`);
  const targetStart = clampClipStart({
    startFrame: input.startFrame,
    durationFrames: clip.durationFrames,
    sequenceDurationFrames: input.timeline.sequence.durationFrames
  });
  const originalStart = clip.startFrame;
  const originalTrackId = clip.trackId;
  const trackChanged = targetTrackId !== originalTrackId;
  const clipId = input.clipId;
  const resolve = input.resolveClipId ?? identityClipId;
  return {
    label: `Move ${clip.label}`,
    execute: (state) => patchClip(state, resolve(clipId), context, { startFrame: targetStart, trackId: targetTrackId }),
    undo: (state) => patchClip(state, resolve(clipId), context, { startFrame: originalStart, trackId: originalTrackId }),
    operations: () => [
      { type: "move_clip", clipId: resolve(clipId), startFrame: targetStart, ...trackChanged ? { trackId: targetTrackId } : {} }
    ],
    inverseOperations: () => [
      { type: "move_clip", clipId: resolve(clipId), startFrame: originalStart, ...trackChanged ? { trackId: originalTrackId } : {} }
    ]
  };
}
function trimClipCommand(input) {
  const context = "trim_clip";
  const clip = requireClip(input.timeline, input.clipId, context);
  assertClipFitsSequence({
    startFrame: input.startFrame,
    durationFrames: input.durationFrames,
    sequenceDurationFrames: input.timeline.sequence.durationFrames,
    label: `${context} ${clip.label}`
  });
  if (input.sourceInFrame !== void 0 && (!Number.isInteger(input.sourceInFrame) || input.sourceInFrame < 0)) {
    throw new Error(`${context}: sourceInFrame must be a non-negative integer`);
  }
  const targetSourceIn = input.sourceInFrame ?? clip.sourceInFrame;
  if (clip.sourceOutFrame !== null && targetSourceIn + input.durationFrames > clip.sourceOutFrame) {
    throw new Error(
      `${context}: needs ${input.durationFrames} source frames from ${targetSourceIn} but ${clip.label} has source window [${clip.sourceInFrame}, ${clip.sourceOutFrame})`
    );
  }
  const target = { startFrame: input.startFrame, durationFrames: input.durationFrames, sourceInFrame: targetSourceIn };
  const original = { startFrame: clip.startFrame, durationFrames: clip.durationFrames, sourceInFrame: clip.sourceInFrame };
  const clipId = input.clipId;
  const resolve = input.resolveClipId ?? identityClipId;
  return {
    label: `Trim ${clip.label}`,
    execute: (state) => patchClip(state, resolve(clipId), context, target),
    undo: (state) => patchClip(state, resolve(clipId), context, original),
    operations: () => [{ type: "trim_clip", clipId: resolve(clipId), ...target }],
    inverseOperations: () => [{ type: "trim_clip", clipId: resolve(clipId), ...original }]
  };
}
function placeClipCommand(input) {
  const context = "place_clip";
  assertNewClipId(input.timeline, input.clipId, context);
  requireUnlockedTrack(input.timeline, input.trackId, context);
  assertClipFitsSequence({
    startFrame: input.startFrame,
    durationFrames: input.durationFrames,
    sequenceDurationFrames: input.timeline.sequence.durationFrames,
    label: `${context} ${input.label}`
  });
  const sourceInFrame = input.sourceInFrame ?? 0;
  if (!Number.isInteger(sourceInFrame) || sourceInFrame < 0) {
    throw new Error(`${context}: sourceInFrame must be a non-negative integer`);
  }
  const clip = {
    id: input.clipId,
    trackId: input.trackId,
    label: input.label,
    startFrame: input.startFrame,
    durationFrames: input.durationFrames,
    sourceInFrame,
    sourceOutFrame: null,
    disabled: false,
    ...input.media ? { media: { url: input.media.url, kind: input.media.kind } } : {},
    ...input.generationId !== void 0 ? { generationId: input.generationId } : {},
    ...input.assetId !== void 0 ? { assetId: input.assetId } : {},
    metadata: input.metadata ?? {}
  };
  const clipId = input.clipId;
  const resolve = input.resolveClipId ?? identityClipId;
  return {
    label: `Place ${input.label}`,
    execute: (state) => insertClip(state, { ...structuredClone(clip), id: resolve(clipId) }, context),
    undo: (state) => removeClip(state, resolve(clipId), context),
    operations: () => [
      {
        type: "place_clip",
        trackId: clip.trackId,
        label: clip.label,
        startFrame: clip.startFrame,
        durationFrames: clip.durationFrames,
        sourceInFrame,
        ...input.media ? { media: { url: input.media.url, kind: input.media.kind } } : {},
        ...input.generationId !== void 0 ? { generationId: input.generationId } : {},
        ...input.assetId !== void 0 ? { assetId: input.assetId } : {},
        ...input.metadata !== void 0 ? { metadata: input.metadata } : {}
      }
    ],
    inverseOperations: () => [{ type: "delete_clip", clipId: resolve(clipId) }]
  };
}
function deleteClipCommand(input) {
  const context = "delete_clip";
  const snapshot = structuredClone(requireClip(input.timeline, input.clipId, context));
  const track = input.timeline.tracks.find((candidate) => candidate.id === snapshot.trackId);
  if (!track) throw new Error(`${context}: clip ${snapshot.id} references unknown track ${snapshot.trackId}`);
  const captionText = track.kind === "caption" && typeof snapshot.text === "string" && snapshot.text.length > 0 ? snapshot.text : null;
  const clipId = input.clipId;
  const resolve = input.resolveClipId ?? identityClipId;
  return {
    label: `Delete ${snapshot.label}`,
    execute: (state) => removeClip(state, resolve(clipId), context),
    undo: (state) => insertClip(state, { ...structuredClone(snapshot), id: resolve(clipId) }, context),
    operations: () => [{ type: "delete_clip", clipId: resolve(clipId) }],
    inverseOperations: () => captionText !== null ? [
      {
        type: "add_caption",
        text: captionText,
        ...snapshot.language !== void 0 ? { language: snapshot.language } : {},
        startFrame: snapshot.startFrame,
        durationFrames: snapshot.durationFrames,
        trackId: snapshot.trackId
      }
    ] : [
      {
        type: "place_clip",
        trackId: snapshot.trackId,
        label: snapshot.label,
        startFrame: snapshot.startFrame,
        durationFrames: snapshot.durationFrames,
        sourceInFrame: snapshot.sourceInFrame,
        ...snapshot.sourceOutFrame !== null ? { sourceOutFrame: snapshot.sourceOutFrame } : {},
        ...snapshot.disabled ? { disabled: true } : {},
        ...snapshot.media ? { media: { url: snapshot.media.url, kind: snapshot.media.kind } } : {},
        ...snapshot.generationId !== void 0 ? { generationId: snapshot.generationId } : {},
        ...snapshot.assetId !== void 0 ? { assetId: snapshot.assetId } : {},
        metadata: structuredClone(snapshot.metadata)
      }
    ]
  };
}
function splitClipCommand(input) {
  const context = "split_clip";
  const original = structuredClone(requireClip(input.timeline, input.clipId, context));
  assertNewClipId(input.timeline, input.newClipId, context);
  if (!Number.isInteger(input.atFrame)) throw new Error(`${context}: atFrame must be an integer frame`);
  const clipEnd = original.startFrame + original.durationFrames;
  if (input.atFrame <= original.startFrame || input.atFrame >= clipEnd) {
    throw new Error(
      `${context}: atFrame ${input.atFrame} must fall strictly inside clip ${original.id} [${original.startFrame}, ${clipEnd})`
    );
  }
  const headDurationFrames = input.atFrame - original.startFrame;
  const tailDurationFrames = clipEnd - input.atFrame;
  const tail = {
    ...structuredClone(original),
    id: input.newClipId,
    startFrame: input.atFrame,
    durationFrames: tailDurationFrames,
    sourceInFrame: original.sourceInFrame + headDurationFrames
  };
  const clipId = input.clipId;
  const newClipId = input.newClipId;
  const resolve = input.resolveClipId ?? identityClipId;
  const headSourceOutFrame = original.sourceInFrame + headDurationFrames;
  return {
    label: `Split ${original.label}`,
    execute: (state) => insertClip(
      patchClip(state, resolve(clipId), context, { durationFrames: headDurationFrames, sourceOutFrame: headSourceOutFrame }),
      { ...structuredClone(tail), id: resolve(newClipId) },
      context
    ),
    undo: (state) => patchClip(removeClip(state, resolve(newClipId), context), resolve(clipId), context, {
      ...structuredClone(original),
      id: resolve(clipId)
    }),
    operations: () => [{ type: "split_clip", clipId: resolve(clipId), atFrame: input.atFrame }],
    inverseOperations: () => [
      { type: "delete_clip", clipId: resolve(newClipId) },
      {
        type: "trim_clip",
        clipId: resolve(clipId),
        startFrame: original.startFrame,
        durationFrames: original.durationFrames,
        sourceInFrame: original.sourceInFrame,
        // Restores the pre-split window; without it the head keeps its
        // out-point at the cut while regaining the full duration.
        sourceOutFrame: original.sourceOutFrame
      }
    ]
  };
}
function addCaptionCommand(input) {
  const context = "add_caption";
  assertNewClipId(input.timeline, input.clipId, context);
  const track = requireUnlockedTrack(input.timeline, input.trackId, context);
  if (track.kind !== "caption") {
    throw new Error(`${context}: track ${track.name} (${track.id}) is kind ${track.kind}; captions require a caption track`);
  }
  if (typeof input.text !== "string" || input.text.length === 0) {
    throw new Error(`${context}: text must be a non-empty string`);
  }
  assertClipFitsSequence({
    startFrame: input.startFrame,
    durationFrames: input.durationFrames,
    sequenceDurationFrames: input.timeline.sequence.durationFrames,
    label: context
  });
  const clip = {
    id: input.clipId,
    trackId: input.trackId,
    label: input.text,
    startFrame: input.startFrame,
    durationFrames: input.durationFrames,
    sourceInFrame: 0,
    sourceOutFrame: null,
    disabled: false,
    text: input.text,
    ...input.language !== void 0 ? { language: input.language } : {},
    metadata: {}
  };
  const clipId = input.clipId;
  const resolve = input.resolveClipId ?? identityClipId;
  return {
    label: `Add caption`,
    execute: (state) => insertClip(state, { ...structuredClone(clip), id: resolve(clipId) }, context),
    undo: (state) => removeClip(state, resolve(clipId), context),
    operations: () => [
      {
        type: "add_caption",
        text: input.text,
        ...input.language !== void 0 ? { language: input.language } : {},
        startFrame: input.startFrame,
        durationFrames: input.durationFrames,
        trackId: input.trackId
      }
    ],
    inverseOperations: () => [{ type: "delete_clip", clipId: resolve(clipId) }]
  };
}
function setClipTextCommand(input) {
  const context = "set_clip_text";
  const clip = requireClip(input.timeline, input.clipId, context);
  if (typeof clip.text !== "string") {
    throw new Error(`${context}: clip ${clip.id} has no text body; create caption text through add_caption`);
  }
  if (typeof input.text !== "string" || input.text.length === 0) {
    throw new Error(`${context}: text must be a non-empty string`);
  }
  const originalText = clip.text;
  const originalLanguage = clip.language;
  const targetLanguage = input.language ?? clip.language;
  const mirrorsLabel = clip.label === clip.text;
  const clipId = input.clipId;
  const resolve = input.resolveClipId ?? identityClipId;
  return {
    label: `Edit caption text`,
    execute: (state) => patchClip(state, resolve(clipId), context, {
      text: input.text,
      language: targetLanguage,
      ...mirrorsLabel ? { label: input.text } : {}
    }),
    undo: (state) => patchClip(state, resolve(clipId), context, {
      text: originalText,
      language: originalLanguage,
      ...mirrorsLabel ? { label: originalText } : {}
    }),
    operations: () => [
      { type: "set_clip_text", clipId: resolve(clipId), text: input.text, ...input.language !== void 0 ? { language: input.language } : {} }
    ],
    inverseOperations: () => [
      {
        type: "set_clip_text",
        clipId: resolve(clipId),
        text: originalText,
        ...originalLanguage !== void 0 ? { language: originalLanguage } : {}
      }
    ]
  };
}
function toggleClipDisabledCommand(input) {
  const context = "set_clip_disabled";
  const clip = requireClip(input.timeline, input.clipId, context);
  const original = clip.disabled;
  const target = !original;
  const clipId = input.clipId;
  const resolve = input.resolveClipId ?? identityClipId;
  return {
    label: target ? `Disable ${clip.label}` : `Enable ${clip.label}`,
    execute: (state) => patchClip(state, resolve(clipId), context, { disabled: target }),
    undo: (state) => patchClip(state, resolve(clipId), context, { disabled: original }),
    operations: () => [{ type: "set_clip_disabled", clipId: resolve(clipId), disabled: target }],
    inverseOperations: () => [{ type: "set_clip_disabled", clipId: resolve(clipId), disabled: original }]
  };
}

// src/sequences-react/engine/playback.ts
function resolveRaf() {
  const g = globalThis;
  if (typeof g.requestAnimationFrame !== "function" || typeof g.cancelAnimationFrame !== "function") {
    throw new Error(
      "PlaybackClock requires requestAnimationFrame/cancelAnimationFrame \u2014 playback runs only in a browser (or a test that stubs both globals)"
    );
  }
  return { request: g.requestAnimationFrame.bind(globalThis), cancel: g.cancelAnimationFrame.bind(globalThis) };
}
function now() {
  const perf = globalThis.performance;
  if (!perf || typeof perf.now !== "function") {
    throw new Error("PlaybackClock requires performance.now() \u2014 playback runs only in a browser (or a test that stubs it)");
  }
  return perf.now();
}
function createPlaybackClock(config) {
  if (!Number.isInteger(config.fps) || config.fps <= 0) {
    throw new Error(`fps must be a positive integer, got ${config.fps}`);
  }
  if (!Number.isInteger(config.durationFrames) || config.durationFrames < 1) {
    throw new Error(`durationFrames must be a positive integer, got ${config.durationFrames}`);
  }
  const lastFrame = config.durationFrames - 1;
  let frame = 0;
  let playing = false;
  let disposed = false;
  let rafId = null;
  let cancelRaf = null;
  let anchorTime = 0;
  let anchorFrame = 0;
  const listeners = /* @__PURE__ */ new Set();
  const notify = () => {
    for (const listener of [...listeners]) listener(frame);
  };
  const stopLoop = () => {
    if (rafId !== null && cancelRaf) cancelRaf(rafId);
    rafId = null;
  };
  const tick = () => {
    rafId = null;
    if (!playing) return;
    const elapsedMs = now() - anchorTime;
    const advanced = anchorFrame + Math.floor(elapsedMs / 1e3 * config.fps);
    if (advanced >= lastFrame) {
      frame = lastFrame;
      playing = false;
      notify();
      return;
    }
    frame = advanced;
    notify();
    rafId = resolveRaf().request(tick);
  };
  return {
    /** Idempotent while playing. Playing from the final frame restarts at 0 —
     *  a play button at the end means "watch again", not a dead control. */
    play() {
      if (disposed) throw new Error("PlaybackClock is disposed");
      if (playing) return;
      const raf = resolveRaf();
      cancelRaf = raf.cancel;
      if (frame >= lastFrame) frame = 0;
      anchorTime = now();
      anchorFrame = frame;
      playing = true;
      rafId = raf.request(tick);
    },
    pause() {
      if (!playing) return;
      playing = false;
      stopLoop();
    },
    /** Clamps into [0, durationFrames - 1]; fractional input rounds to the
     *  nearest frame. Re-anchors mid-play so playback continues from the
     *  seek target, and notifies so scrubbing drives the playhead. */
    seek(target) {
      if (disposed) throw new Error("PlaybackClock is disposed");
      if (!Number.isFinite(target)) throw new Error(`seek target must be a finite number, got ${target}`);
      frame = Math.max(0, Math.min(lastFrame, Math.round(target)));
      if (playing) {
        anchorTime = now();
        anchorFrame = frame;
      }
      notify();
    },
    isPlaying() {
      return playing;
    },
    getFrame() {
      return frame;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      playing = false;
      stopLoop();
      listeners.clear();
      disposed = true;
    }
  };
}

// src/sequences-react/engine/snap.ts
function collectSnapPoints(timeline, playheadFrame) {
  if (!Number.isInteger(playheadFrame) || playheadFrame < 0) {
    throw new Error(`playheadFrame must be a non-negative integer, got ${playheadFrame}`);
  }
  const points = [];
  for (const clip of timeline.clips) {
    points.push({ frame: clip.startFrame, kind: "clip-start", clipId: clip.id });
    points.push({ frame: clip.startFrame + clip.durationFrames, kind: "clip-end", clipId: clip.id });
  }
  points.push({ frame: playheadFrame, kind: "playhead" });
  points.push({ frame: timeline.sequence.durationFrames, kind: "sequence-end" });
  return points.sort((a, b) => a.frame - b.frame || a.kind.localeCompare(b.kind));
}
function applySnap(frame, points, opts) {
  if (!Number.isFinite(frame)) throw new Error(`frame must be a finite number, got ${frame}`);
  if (!Number.isFinite(opts.zoom) || opts.zoom <= 0) {
    throw new Error(`zoom must be a positive finite number (pixels per frame), got ${opts.zoom}`);
  }
  const thresholdPx = opts.thresholdPx ?? 10;
  if (!Number.isFinite(thresholdPx) || thresholdPx < 0) {
    throw new Error(`thresholdPx must be a non-negative finite number, got ${thresholdPx}`);
  }
  const thresholdFrames = thresholdPx / opts.zoom;
  let best = null;
  let bestDistance = Infinity;
  for (const point of points) {
    if (opts.exclude && opts.exclude(point)) continue;
    const distance = Math.abs(point.frame - frame);
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  if (best !== null && bestDistance <= thresholdFrames) {
    return { frame: best.frame, snapped: true, point: best };
  }
  return { frame, snapped: false, point: null };
}

// src/sequences-react/engine/zoom.ts
function createZoomMath(config) {
  const { minZoom, maxZoom } = config;
  if (!Number.isFinite(minZoom) || minZoom <= 0) {
    throw new Error(`minZoom must be a positive finite number, got ${minZoom}`);
  }
  if (!Number.isFinite(maxZoom) || maxZoom <= minZoom) {
    throw new Error(`maxZoom must be finite and greater than minZoom ${minZoom}, got ${maxZoom}`);
  }
  const ratio = maxZoom / minZoom;
  return {
    minZoom,
    maxZoom,
    /** Slider clamps into [0, 1]: range inputs can overshoot during fast
     *  drags and the boundary value is always the right answer. */
    sliderToZoom(slider) {
      if (!Number.isFinite(slider)) throw new Error(`slider must be a finite number, got ${slider}`);
      const t = Math.min(1, Math.max(0, slider));
      return minZoom * Math.pow(ratio, t);
    },
    zoomToSlider(zoom) {
      if (!Number.isFinite(zoom) || zoom <= 0) throw new Error(`zoom must be a positive finite number, got ${zoom}`);
      const clamped = Math.min(maxZoom, Math.max(minZoom, zoom));
      return Math.log(clamped / minZoom) / Math.log(ratio);
    }
  };
}
function assertViewport(view) {
  if (!Number.isFinite(view.zoom) || view.zoom <= 0) {
    throw new Error(`viewport zoom must be a positive finite number, got ${view.zoom}`);
  }
  if (!Number.isFinite(view.scrollLeft)) {
    throw new Error(`viewport scrollLeft must be a finite number, got ${view.scrollLeft}`);
  }
}
function frameToPixel(frame, view) {
  assertViewport(view);
  if (!Number.isFinite(frame)) throw new Error(`frame must be a finite number, got ${frame}`);
  return frame * view.zoom - view.scrollLeft;
}
function pixelToFrame(pixel, view) {
  assertViewport(view);
  if (!Number.isFinite(pixel)) throw new Error(`pixel must be a finite number, got ${pixel}`);
  return Math.max(0, Math.round((pixel + view.scrollLeft) / view.zoom));
}
function snapPixel(value, devicePixelRatio) {
  if (!Number.isFinite(value)) throw new Error(`value must be a finite number, got ${value}`);
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) {
    throw new Error(`devicePixelRatio must be a positive finite number, got ${devicePixelRatio}`);
  }
  return Math.round(value * devicePixelRatio) / devicePixelRatio;
}

// src/sequences-react/media/frame-provider.ts
var DEFAULT_MAX_MEDIA_ELEMENTS = 4;
var SEEK_TOLERANCE_SECONDS = 1 / 60;
var SEEK_TIMEOUT_MS = 5e3;
function containFitRect(source, dest) {
  if (!(source.width > 0) || !(source.height > 0)) {
    throw new Error(`containFitRect requires positive source dimensions, got ${source.width}x${source.height}`);
  }
  if (!(dest.width > 0) || !(dest.height > 0)) {
    throw new Error(`containFitRect requires positive destination dimensions, got ${dest.width}x${dest.height}`);
  }
  const scale = Math.min(dest.width / source.width, dest.height / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  return {
    x: dest.x + (dest.width - width) / 2,
    y: dest.y + (dest.height - height) / 2,
    width,
    height
  };
}
function needsSeek(currentTimeSeconds, targetSeconds) {
  return Math.abs(currentTimeSeconds - targetSeconds) >= SEEK_TOLERANCE_SECONDS;
}
function createMediaElementPool(opts) {
  if (!Number.isInteger(opts.maxElements) || opts.maxElements < 1) {
    throw new Error(`maxElements must be a positive integer, got ${opts.maxElements}`);
  }
  const entries = /* @__PURE__ */ new Map();
  let disposed = false;
  const evictOverBudget = () => {
    if (entries.size <= opts.maxElements) return;
    for (const [url, entry] of entries) {
      if (entries.size <= opts.maxElements) return;
      if (entry.pinned > 0) continue;
      entries.delete(url);
      opts.destroy(entry.element, url);
    }
  };
  return {
    acquire(url) {
      if (disposed) throw new Error(`media element pool is disposed \u2014 cannot acquire ${url}`);
      let entry = entries.get(url);
      if (entry) {
        entries.delete(url);
      } else {
        entry = { element: opts.create(url), pinned: 0 };
      }
      entries.set(url, entry);
      entry.pinned += 1;
      evictOverBudget();
      let released = false;
      return {
        element: entry.element,
        release: () => {
          if (released) return;
          released = true;
          entry.pinned -= 1;
          evictOverBudget();
        }
      };
    },
    has: (url) => entries.has(url),
    size: () => entries.size,
    dispose() {
      disposed = true;
      for (const [url, entry] of entries) opts.destroy(entry.element, url);
      entries.clear();
    }
  };
}
var IMAGE_EXTENSIONS = /* @__PURE__ */ new Set(["apng", "avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);
var VIDEO_EXTENSIONS = /* @__PURE__ */ new Set(["m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ogv", "webm"]);
function classifyMediaUrl(url) {
  const match = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(url);
  const extension = match?.[1]?.toLowerCase();
  if (extension === void 0) return "unknown";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  return "unknown";
}
async function probeMediaKind(url) {
  const known = classifyMediaUrl(url);
  if (known !== "unknown") return known;
  let contentType = null;
  try {
    const response = await fetch(url, { method: "HEAD" });
    contentType = response.headers.get("content-type");
  } catch {
    return "image";
  }
  if (contentType !== null) {
    if (contentType.startsWith("video/")) return "video";
    if (contentType.startsWith("audio/")) {
      throw new Error(`cannot draw frames from audio media ${url} (content-type ${contentType})`);
    }
  }
  return "image";
}
function requireDocument(caller) {
  if (typeof document === "undefined") {
    throw new Error(`${caller} requires a browser document \u2014 frame providers are client-side only`);
  }
  return document;
}
function assertSourceSeconds(sourceSeconds) {
  if (!Number.isFinite(sourceSeconds) || sourceSeconds < 0) {
    throw new Error(`sourceSeconds must be a non-negative finite number, got ${sourceSeconds}`);
  }
}
function createPooledVideo(url) {
  const video = requireDocument("createVideoElementFrameProvider").createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  video.src = url;
  return video;
}
function destroyPooledVideo(video) {
  video.pause();
  video.removeAttribute("src");
  video.load();
}
function awaitMediaEvent(video, eventName, url) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener(eventName, onSuccess);
      video.removeEventListener("error", onError);
    };
    const onSuccess = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      const detail = video.error ? `code ${video.error.code}: ${video.error.message}` : "no MediaError attached";
      reject(new Error(`media error while waiting for '${eventName}' on ${url} (${detail})`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${SEEK_TIMEOUT_MS}ms waiting for '${eventName}' on ${url}`));
    }, SEEK_TIMEOUT_MS);
    video.addEventListener(eventName, onSuccess);
    video.addEventListener("error", onError);
  });
}
async function seekVideo(video, targetSeconds, url) {
  const seeked = awaitMediaEvent(video, "seeked", url);
  video.currentTime = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(targetSeconds, video.duration) : targetSeconds;
  await seeked;
}
async function drawVideoFrame(video, url, sourceSeconds, ctx, rect) {
  if (video.readyState < 1) await awaitMediaEvent(video, "loadedmetadata", url);
  if (needsSeek(video.currentTime, sourceSeconds)) await seekVideo(video, sourceSeconds, url);
  if (video.videoWidth === 0 || video.videoHeight === 0) {
    throw new Error(`media at ${url} decoded with no video frames (audio-only or corrupt) \u2014 cannot draw`);
  }
  const fit = containFitRect({ width: video.videoWidth, height: video.videoHeight }, rect);
  ctx.drawImage(video, fit.x, fit.y, fit.width, fit.height);
}
function createPooledImage(url) {
  const element = requireDocument("createImageFrameProvider").createElement("img");
  element.crossOrigin = "anonymous";
  element.src = url;
  const ready = element.decode().then(
    () => void 0,
    (error) => {
      throw new Error(`failed to decode image ${url}`, { cause: error });
    }
  );
  void ready.catch(() => void 0);
  return { element, ready };
}
function createImageFrameProvider(opts) {
  const pool = createMediaElementPool({
    maxElements: opts?.maxElements ?? DEFAULT_MAX_MEDIA_ELEMENTS,
    create: createPooledImage,
    destroy: (pooled) => {
      pooled.element.src = "";
    }
  });
  return {
    async drawFrame(mediaUrl, sourceSeconds, ctx, rect) {
      assertSourceSeconds(sourceSeconds);
      const lease = pool.acquire(mediaUrl);
      try {
        await lease.element.ready;
        const image = lease.element.element;
        const fit = containFitRect({ width: image.naturalWidth, height: image.naturalHeight }, rect);
        ctx.drawImage(image, fit.x, fit.y, fit.width, fit.height);
      } finally {
        lease.release();
      }
    },
    prefetch(mediaUrl) {
      pool.acquire(mediaUrl).release();
    },
    dispose() {
      pool.dispose();
    }
  };
}
function createVideoElementFrameProvider(opts) {
  const maxElements = opts?.maxElements ?? DEFAULT_MAX_MEDIA_ELEMENTS;
  const videoPool = createMediaElementPool({
    maxElements,
    create: createPooledVideo,
    destroy: destroyPooledVideo
  });
  const imageProvider = createImageFrameProvider({ maxElements });
  const kindByUrl = /* @__PURE__ */ new Map();
  const drawQueue = /* @__PURE__ */ new Map();
  const resolveKind = (url) => {
    let pending = kindByUrl.get(url);
    if (pending === void 0) {
      pending = probeMediaKind(url);
      pending.catch(() => kindByUrl.delete(url));
      kindByUrl.set(url, pending);
    }
    return pending;
  };
  const enqueueVideoDraw = (url, work) => {
    const previous = drawQueue.get(url) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.then(
      () => void 0,
      () => void 0
    ).then(() => {
      if (drawQueue.get(url) === tail) drawQueue.delete(url);
    });
    drawQueue.set(url, tail);
    return run;
  };
  return {
    async drawFrame(mediaUrl, sourceSeconds, ctx, rect) {
      assertSourceSeconds(sourceSeconds);
      const kind = await resolveKind(mediaUrl);
      if (kind === "image") {
        await imageProvider.drawFrame(mediaUrl, sourceSeconds, ctx, rect);
        return;
      }
      await enqueueVideoDraw(mediaUrl, async () => {
        const lease = videoPool.acquire(mediaUrl);
        try {
          await drawVideoFrame(lease.element, mediaUrl, sourceSeconds, ctx, rect);
        } finally {
          lease.release();
        }
      });
    },
    prefetch(mediaUrl) {
      void resolveKind(mediaUrl).then((kind) => {
        if (kind === "image") {
          imageProvider.prefetch(mediaUrl);
          return;
        }
        videoPool.acquire(mediaUrl).release();
      }).catch(() => void 0);
    },
    dispose() {
      videoPool.dispose();
      imageProvider.dispose();
      kindByUrl.clear();
      drawQueue.clear();
    }
  };
}

// src/sequences-react/components/composite-command.ts
function compositeCommand(label, commands) {
  if (commands.length === 0) throw new Error("compositeCommand requires at least one command");
  return {
    label,
    execute: (state) => commands.reduce((acc, command) => command.execute(acc), state),
    undo: (state) => [...commands].reverse().reduce((acc, command) => command.undo(acc), state),
    operations: () => commands.flatMap((command) => command.operations()),
    inverseOperations: () => [...commands].reverse().flatMap((command) => command.inverseOperations())
  };
}

// src/sequences-react/components/interaction-math.ts
function framesFromPixelDelta(deltaX, zoom) {
  if (!Number.isFinite(deltaX)) throw new Error("deltaX must be a finite pixel delta");
  if (!Number.isFinite(zoom) || zoom <= 0) throw new Error("zoom (pixels per frame) must be a positive finite number");
  return Math.round(deltaX / zoom);
}
function moveDragStartFrame(input) {
  return clampClipStart({
    startFrame: input.originStartFrame + input.deltaFrames,
    durationFrames: input.durationFrames,
    sequenceDurationFrames: input.sequenceDurationFrames
  });
}
function trimStartDrag(input) {
  const endFrame = input.originStartFrame + input.originDurationFrames;
  const minStart = Math.max(0, input.originStartFrame - input.originSourceInFrame);
  const maxStart = endFrame - MIN_SEQUENCE_CLIP_FRAMES;
  const startFrame = Math.max(minStart, Math.min(maxStart, input.originStartFrame + input.deltaFrames));
  return {
    startFrame,
    durationFrames: endFrame - startFrame,
    sourceInFrame: input.originSourceInFrame + (startFrame - input.originStartFrame)
  };
}
function trimEndDrag(input) {
  const bySequence = input.sequenceDurationFrames - input.originStartFrame;
  const bySource = input.sourceDurationFrames === void 0 ? Number.POSITIVE_INFINITY : input.sourceDurationFrames - input.sourceInFrame;
  const maxDuration = Math.min(bySequence, bySource);
  const durationFrames = Math.max(
    MIN_SEQUENCE_CLIP_FRAMES,
    Math.min(maxDuration, input.originDurationFrames + input.deltaFrames)
  );
  return { durationFrames };
}
var TICK_STEPS_SECONDS = [1, 5, 10, 30, 60, 300];
function selectTickStepSeconds(input) {
  if (!Number.isFinite(input.zoom) || input.zoom <= 0) throw new Error("zoom must be a positive finite number");
  if (!Number.isInteger(input.fps) || input.fps <= 0) throw new Error("fps must be a positive integer");
  const minSpacing = input.minSpacingPx ?? 80;
  for (const step of TICK_STEPS_SECONDS) {
    if (step * input.fps * input.zoom >= minSpacing) return step;
  }
  const pxPerMinute = 60 * input.fps * input.zoom;
  return Math.ceil(minSpacing / pxPerMinute) * 60;
}
function letterboxRect(input) {
  const { containerWidth, containerHeight, mediaWidth, mediaHeight } = input;
  if (containerWidth <= 0 || containerHeight <= 0) throw new Error("container dimensions must be positive");
  if (mediaWidth <= 0 || mediaHeight <= 0) throw new Error("media dimensions must be positive");
  const scale = Math.min(containerWidth / mediaWidth, containerHeight / mediaHeight);
  const width = mediaWidth * scale;
  const height = mediaHeight * scale;
  return {
    x: (containerWidth - width) / 2,
    y: (containerHeight - height) / 2,
    width,
    height
  };
}
function captionFontPx(canvasCssHeight) {
  if (!Number.isFinite(canvasCssHeight) || canvasCssHeight <= 0) throw new Error("canvas height must be positive");
  return Math.max(12, Math.round(canvasCssHeight / 18));
}
function clipChipGeometry(input) {
  return {
    left: input.startFrame * input.zoom,
    width: Math.max(2, input.durationFrames * input.zoom)
  };
}
function chooseMoveSnap(input) {
  const startDelta = input.startSnap.snapped ? Math.abs(input.startSnap.frame - input.candidateStartFrame) : Number.POSITIVE_INFINITY;
  const endStartFrame = input.endSnap.frame - input.durationFrames;
  const endDelta = input.endSnap.snapped ? Math.abs(endStartFrame - input.candidateStartFrame) : Number.POSITIVE_INFINITY;
  if (startDelta === Number.POSITIVE_INFINITY && endDelta === Number.POSITIVE_INFINITY) {
    return { startFrame: input.candidateStartFrame, point: null };
  }
  if (startDelta <= endDelta) return { startFrame: input.startSnap.frame, point: input.startSnap.point };
  return { startFrame: endStartFrame, point: input.endSnap.point };
}

// src/sequences-react/components/PreviewCanvas.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
function PreviewCanvas({ timeline, clock, frameProvider, className }) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const [size, setSize] = useState(null);
  const [drawError, setDrawError] = useState(null);
  const [emptyFrame, setEmptyFrame] = useState(false);
  const paintQueueRef = useRef({ running: false, queuedFrame: null });
  const paintInputsRef = useRef({ timeline, frameProvider, size });
  paintInputsRef.current = { timeline, frameProvider, size };
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    function measure() {
      const node = containerRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const fit = letterboxRect({
        containerWidth: rect.width,
        containerHeight: rect.height,
        mediaWidth: timeline.sequence.width,
        mediaHeight: timeline.sequence.height
      });
      setSize((current) => {
        const next = { width: Math.round(fit.width), height: Math.round(fit.height) };
        return current && current.width === next.width && current.height === next.height ? current : next;
      });
    }
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [timeline.sequence.width, timeline.sequence.height]);
  const requestPaint = useMemo(() => {
    async function paint(frame) {
      const { timeline: current, frameProvider: provider, size: cssSize } = paintInputsRef.current;
      const canvas = canvasRef.current;
      if (!canvas || !cssSize) return;
      const paintFrame = Math.max(0, Math.min(frame, current.sequence.durationFrames - 1));
      const snapshot = snapshotFrame(current, paintFrame);
      const mediaEntries = snapshot.active.filter(({ track, clip }) => track.kind === "video" && !track.muted && clip.media !== void 0 && (clip.media.kind === "video" || clip.media.kind === "image"));
      const top = mediaEntries[mediaEntries.length - 1];
      setEmptyFrame(!(top && top.clip.media));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = typeof window !== "undefined" && window.devicePixelRatio || 1;
      const backingWidth = Math.round(cssSize.width * dpr);
      const backingHeight = Math.round(cssSize.height * dpr);
      if (canvas.width !== backingWidth) canvas.width = backingWidth;
      if (canvas.height !== backingHeight) canvas.height = backingHeight;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, cssSize.width, cssSize.height);
      if (top && top.clip.media) {
        const sourceSeconds = framesToSeconds(top.clip.sourceInFrame + (paintFrame - top.clip.startFrame), current.sequence.fps);
        await provider.drawFrame(top.clip.media.url, sourceSeconds, ctx, {
          x: 0,
          y: 0,
          width: cssSize.width,
          height: cssSize.height
        });
      }
      if (snapshot.captions.length > 0) {
        const fontPx = captionFontPx(cssSize.height);
        ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const barHeight = fontPx * 1.6;
        let centerY = cssSize.height - barHeight;
        for (const caption of [...snapshot.captions].reverse()) {
          const textWidth = Math.min(ctx.measureText(caption.text).width, cssSize.width * 0.86);
          const barWidth = textWidth + fontPx * 1.2;
          ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
          ctx.fillRect((cssSize.width - barWidth) / 2, centerY - barHeight / 2, barWidth, barHeight);
          ctx.fillStyle = "#fff";
          ctx.fillText(caption.text, cssSize.width / 2, centerY, cssSize.width * 0.86);
          centerY -= barHeight + fontPx * 0.25;
        }
      }
    }
    return function requestPaint2(frame) {
      const queue = paintQueueRef.current;
      if (queue.running) {
        queue.queuedFrame = frame;
        return;
      }
      queue.running = true;
      void (async () => {
        let next = frame;
        while (next !== null) {
          const target = next;
          queue.queuedFrame = null;
          try {
            await paint(target);
            setDrawError(null);
          } catch (error) {
            setDrawError(error instanceof Error ? error.message : String(error));
          }
          next = queue.queuedFrame;
        }
        queue.running = false;
      })();
    };
  }, []);
  useEffect(() => {
    requestPaint(clock.getFrame());
    return clock.subscribe(requestPaint);
  }, [clock, requestPaint]);
  useEffect(() => {
    requestPaint(clock.getFrame());
  }, [timeline, size, clock, requestPaint]);
  return /* @__PURE__ */ jsxs("div", { ref: containerRef, className: `relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black ${className ?? ""}`, children: [
    /* @__PURE__ */ jsx(
      "canvas",
      {
        ref: canvasRef,
        "data-preview-canvas": true,
        className: "block",
        style: size ? { width: `${size.width}px`, height: `${size.height}px` } : { width: "100%", height: "100%" }
      }
    ),
    emptyFrame && !drawError ? /* @__PURE__ */ jsx("p", { className: "pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-[var(--text-muted)]", children: "No media at the playhead" }) : null,
    drawError ? /* @__PURE__ */ jsx("p", { className: "absolute inset-x-3 bottom-2 truncate rounded bg-[hsl(var(--destructive))] px-2 py-1 text-center text-xs text-[hsl(var(--destructive-foreground))]", role: "alert", children: drawError }) : null
  ] });
}

// src/sequences-react/components/SnapIndicatorLine.tsx
import { jsx as jsx2 } from "react/jsx-runtime";
function SnapIndicatorLine({ point, zoom }) {
  if (!point) return null;
  return /* @__PURE__ */ jsx2(
    "div",
    {
      "data-snap-kind": point.kind,
      className: "pointer-events-none absolute bottom-0 top-0 z-30 w-px bg-[var(--brand-primary)] shadow-[0_0_8px_var(--brand-primary)]",
      style: { left: `${point.frame * zoom}px` }
    }
  );
}

// src/sequences-react/components/TimelinePlayhead.tsx
import { jsx as jsx3, jsxs as jsxs2 } from "react/jsx-runtime";
function TimelinePlayhead({ frame, zoom }) {
  return /* @__PURE__ */ jsxs2(
    "div",
    {
      "data-timeline-playhead": true,
      className: "pointer-events-none absolute bottom-0 top-0 z-20",
      style: { left: `${frame * zoom}px` },
      children: [
        /* @__PURE__ */ jsx3("div", { className: "absolute bottom-0 top-0 w-px bg-[var(--brand-primary)] shadow-[0_0_10px_var(--brand-primary)]" }),
        /* @__PURE__ */ jsx3(
          "div",
          {
            className: "absolute -left-[5px] top-0 h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent",
            style: { borderTopColor: "var(--brand-primary)" }
          }
        )
      ]
    }
  );
}

// src/sequences-react/components/TimelineRuler.tsx
import { useMemo as useMemo2 } from "react";
import { jsx as jsx4 } from "react/jsx-runtime";
function TimelineRuler({ fps, durationFrames, zoom, onScrub }) {
  const ticks = useMemo2(() => {
    const stepSeconds = selectTickStepSeconds({ zoom, fps });
    const majorStepFrames = stepSeconds * fps;
    const minorStepFrames = Math.round(majorStepFrames / 5);
    const drawMinor = minorStepFrames * zoom >= 8 && minorStepFrames >= 1;
    const result = [];
    for (let frame = 0; frame <= durationFrames; frame += majorStepFrames) {
      result.push({ frame, label: formatTimecode(frame, fps) });
      if (!drawMinor) continue;
      for (let minor = 1; minor < 5; minor += 1) {
        const minorFrame = frame + minor * minorStepFrames;
        if (minorFrame >= durationFrames) break;
        result.push({ frame: minorFrame, label: null });
      }
    }
    return result;
  }, [durationFrames, fps, zoom]);
  function frameFromPointer(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const frame = Math.round((event.clientX - rect.left) / zoom);
    return Math.max(0, Math.min(durationFrames, frame));
  }
  function handlePointerDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    onScrub(frameFromPointer(event));
  }
  function handlePointerMove(event) {
    if (typeof event.currentTarget.hasPointerCapture !== "function") return;
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    onScrub(frameFromPointer(event));
  }
  return /* @__PURE__ */ jsx4(
    "div",
    {
      "data-timeline-ruler": true,
      className: "relative h-7 cursor-ew-resize select-none border-b border-[var(--border-default)] bg-[var(--bg-input)]",
      style: { width: `${durationFrames * zoom}px`, touchAction: "none" },
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      children: ticks.map((tick) => /* @__PURE__ */ jsx4(
        "div",
        {
          className: `absolute bottom-0 w-px bg-[var(--border-default)] ${tick.label !== null ? "top-2.5" : "top-[18px]"}`,
          style: { left: `${tick.frame * zoom}px` },
          children: tick.label !== null ? /* @__PURE__ */ jsx4("span", { className: "absolute -top-2 left-1 whitespace-nowrap font-mono text-[10px] leading-none text-[var(--text-muted)]", children: tick.label }) : null
        },
        tick.frame
      ))
    }
  );
}

// src/sequences-react/components/TimelineClipChip.tsx
import { useEffect as useEffect2, useRef as useRef2, useState as useState2 } from "react";

// src/sequences-react/media/waveform.ts
function computeWaveform(buffer, bucketCount) {
  if (!Number.isInteger(bucketCount) || bucketCount < 1) {
    throw new Error(`bucketCount must be a positive integer, got ${bucketCount}`);
  }
  if (!Number.isInteger(buffer.length) || buffer.length < 1) {
    throw new Error(`audio buffer is empty (length ${buffer.length}) \u2014 cannot compute a waveform`);
  }
  if (!Number.isInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1) {
    throw new Error(`audio buffer must have at least one channel, got ${buffer.numberOfChannels}`);
  }
  if (!Number.isFinite(buffer.duration) || buffer.duration <= 0) {
    throw new Error(`audio buffer duration must be positive, got ${buffer.duration}`);
  }
  const samplesPerBucket = Math.ceil(buffer.length / bucketCount);
  const peaks = new Float32Array(bucketCount);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    if (data.length !== buffer.length) {
      throw new Error(`channel ${channel} has ${data.length} samples, expected ${buffer.length}`);
    }
    for (let bucket = 0; bucket < bucketCount; bucket++) {
      const start = bucket * samplesPerBucket;
      if (start >= data.length) break;
      let peak = peaks[bucket];
      for (const sample of data.subarray(start, Math.min(data.length, start + samplesPerBucket))) {
        const magnitude = Math.abs(sample);
        if (magnitude > peak) peak = magnitude;
      }
      peaks[bucket] = peak;
    }
  }
  return { peaks, samplesPerBucket, durationSeconds: buffer.duration };
}
async function loadWaveform(mediaUrl, bucketCount, ctx) {
  const response = await fetch(mediaUrl);
  if (!response.ok) {
    throw new Error(`failed to fetch audio for waveform: ${response.status} ${response.statusText} from ${mediaUrl}`);
  }
  const bytes = await response.arrayBuffer();
  const ownsContext = ctx === void 0;
  if (ctx === void 0) {
    if (typeof AudioContext === "undefined") {
      throw new Error("loadWaveform requires Web Audio (AudioContext) \u2014 pass a ctx or call from a browser");
    }
    ctx = new AudioContext();
  }
  try {
    const decoded = await ctx.decodeAudioData(bytes);
    return computeWaveform(decoded, bucketCount);
  } finally {
    if (ownsContext) await ctx.close();
  }
}
function drawWaveform(ctx, data, rect, color) {
  if (data.peaks.length === 0) {
    throw new Error("waveform has no peaks \u2014 compute it with a positive bucketCount");
  }
  if (!(rect.width > 0) || !(rect.height > 0)) {
    throw new Error(`drawWaveform requires positive rect dimensions, got ${rect.width}x${rect.height}`);
  }
  ctx.fillStyle = color;
  const midline = rect.y + rect.height / 2;
  const step = rect.width / data.peaks.length;
  const barWidth = Math.max(1, step - 1);
  for (const [index, peak] of data.peaks.entries()) {
    const half = Math.min(1, Math.max(0, peak)) * (rect.height / 2);
    const barHeight = Math.max(1, half * 2);
    ctx.fillRect(rect.x + index * step, midline - barHeight / 2, barWidth, barHeight);
  }
}

// src/sequences-react/components/TimelineClipChip.tsx
import { Fragment, jsx as jsx5, jsxs as jsxs3 } from "react/jsx-runtime";
var KIND_TONES = {
  video: "border-[hsl(var(--primary)/0.4)] bg-[color-mix(in_srgb,hsl(var(--primary))_15%,var(--bg-input))]",
  audio: "border-[hsl(var(--success)/0.4)] bg-[color-mix(in_srgb,hsl(var(--success))_15%,var(--bg-input))]",
  caption: "border-[hsl(var(--warning)/0.4)] bg-[color-mix(in_srgb,hsl(var(--warning))_15%,var(--bg-input))]",
  reference: "border-[hsl(var(--muted-foreground)/0.4)] bg-[color-mix(in_srgb,hsl(var(--muted-foreground))_15%,var(--bg-input))]",
  agent: "border-[hsl(var(--primary)/0.4)] bg-[color-mix(in_srgb,hsl(var(--primary))_15%,var(--bg-input))]"
};
var waveformCache = /* @__PURE__ */ new Map();
var WAVEFORM_BUCKETS = 256;
function sourceDurationFrames(clip, fps) {
  if (clip.sourceOutFrame !== null && clip.sourceOutFrame !== void 0) return clip.sourceOutFrame;
  if (clip.media?.durationSeconds !== void 0) return Math.round(clip.media.durationSeconds * fps);
  return void 0;
}
function TimelineClipChip(props) {
  const { clip, track, fps, zoom, selected, canWrite, tabbable, frameProvider } = props;
  const rootRef = useRef2(null);
  const gestureRef = useRef2(null);
  const [preview, setPreview] = useState2(null);
  const previewRef = useRef2(null);
  const [editingText, setEditingText] = useState2(null);
  const posterRef = useRef2(null);
  const waveformRef = useRef2(null);
  const shown = preview ?? {
    startFrame: clip.startFrame,
    durationFrames: clip.durationFrames,
    sourceInFrame: clip.sourceInFrame,
    trackId: clip.trackId,
    translateY: 0,
    moved: false
  };
  const geometry = clipChipGeometry({ startFrame: shown.startFrame, durationFrames: shown.durationFrames, zoom });
  const interactive = canWrite && !track.locked;
  function collectLaneTargets() {
    const root = rootRef.current?.closest("[data-timeline-tracks]");
    const originLane = rootRef.current?.closest("[data-lane-track]");
    if (!root || !originLane) return [];
    const originTop = originLane.getBoundingClientRect().top;
    const targets = [];
    for (const lane of Array.from(root.querySelectorAll("[data-lane-track]"))) {
      if (lane.dataset.laneKind !== track.kind || lane.dataset.laneLocked === "true") continue;
      const rect = lane.getBoundingClientRect();
      const trackId = lane.dataset.laneTrack;
      if (!trackId) continue;
      targets.push({ trackId, top: rect.top, bottom: rect.bottom, offsetY: rect.top - originTop });
    }
    return targets;
  }
  function beginGesture(event, kind) {
    if (!interactive || event.button !== 0 || editingText !== null) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    gestureRef.current = {
      kind,
      pointerId: event.pointerId,
      originClientX: event.clientX,
      origin: { startFrame: clip.startFrame, durationFrames: clip.durationFrames, sourceInFrame: clip.sourceInFrame },
      laneTargets: kind === "move" ? collectLaneTargets() : [],
      originTrackId: clip.trackId
    };
    document.body.style.cursor = kind === "move" ? "grabbing" : "ew-resize";
    document.body.style.userSelect = "none";
  }
  function applyPreview(next) {
    previewRef.current = next;
    setPreview(next);
  }
  function updateGesture(event) {
    const gesture = gestureRef.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const deltaFrames = framesFromPixelDelta(event.clientX - gesture.originClientX, zoom);
    const moved = previewRef.current?.moved || Math.abs(event.clientX - gesture.originClientX) > 3;
    if (gesture.kind === "move") {
      const candidate = moveDragStartFrame({
        originStartFrame: gesture.origin.startFrame,
        durationFrames: gesture.origin.durationFrames,
        deltaFrames,
        sequenceDurationFrames: props.sequenceDurationFrames
      });
      const snapped2 = props.snapMove({ startFrame: candidate, durationFrames: gesture.origin.durationFrames, clipId: clip.id });
      const startFrame = moveDragStartFrame({
        originStartFrame: snapped2.startFrame,
        durationFrames: gesture.origin.durationFrames,
        deltaFrames: 0,
        sequenceDurationFrames: props.sequenceDurationFrames
      });
      props.onSnapPointChange(startFrame === snapped2.startFrame ? snapped2.point : null);
      const lane = gesture.laneTargets.find((target) => event.clientY >= target.top && event.clientY < target.bottom);
      applyPreview({
        startFrame,
        durationFrames: gesture.origin.durationFrames,
        sourceInFrame: gesture.origin.sourceInFrame,
        trackId: lane?.trackId ?? gesture.originTrackId,
        translateY: lane?.offsetY ?? 0,
        moved
      });
      return;
    }
    if (gesture.kind === "trim-start") {
      const raw = trimStartDrag({
        originStartFrame: gesture.origin.startFrame,
        originDurationFrames: gesture.origin.durationFrames,
        originSourceInFrame: gesture.origin.sourceInFrame,
        deltaFrames
      });
      const snapped2 = props.snapEdge({ frame: raw.startFrame, clipId: clip.id });
      const clamped2 = trimStartDrag({
        originStartFrame: gesture.origin.startFrame,
        originDurationFrames: gesture.origin.durationFrames,
        originSourceInFrame: gesture.origin.sourceInFrame,
        deltaFrames: snapped2.frame - gesture.origin.startFrame
      });
      props.onSnapPointChange(clamped2.startFrame === snapped2.frame ? snapped2.point : null);
      applyPreview({ ...clamped2, trackId: gesture.originTrackId, translateY: 0, moved });
      return;
    }
    const rawEnd = gesture.origin.startFrame + trimEndDrag({
      originStartFrame: gesture.origin.startFrame,
      originDurationFrames: gesture.origin.durationFrames,
      sourceInFrame: gesture.origin.sourceInFrame,
      deltaFrames,
      sequenceDurationFrames: props.sequenceDurationFrames,
      sourceDurationFrames: sourceDurationFrames(clip, fps)
    }).durationFrames;
    const snapped = props.snapEdge({ frame: rawEnd, clipId: clip.id });
    const clamped = trimEndDrag({
      originStartFrame: gesture.origin.startFrame,
      originDurationFrames: gesture.origin.durationFrames,
      sourceInFrame: gesture.origin.sourceInFrame,
      deltaFrames: snapped.frame - (gesture.origin.startFrame + gesture.origin.durationFrames),
      sequenceDurationFrames: props.sequenceDurationFrames,
      sourceDurationFrames: sourceDurationFrames(clip, fps)
    });
    props.onSnapPointChange(gesture.origin.startFrame + clamped.durationFrames === snapped.frame ? snapped.point : null);
    applyPreview({
      startFrame: gesture.origin.startFrame,
      durationFrames: clamped.durationFrames,
      sourceInFrame: gesture.origin.sourceInFrame,
      trackId: gesture.originTrackId,
      translateY: 0,
      moved
    });
  }
  function endGestureCleanup() {
    gestureRef.current = null;
    previewRef.current = null;
    setPreview(null);
    props.onSnapPointChange(null);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }
  function finishGesture(event) {
    const gesture = gestureRef.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const finalPreview = previewRef.current;
    const kind = gesture.kind;
    const origin = gesture.origin;
    const originTrackId = gesture.originTrackId;
    endGestureCleanup();
    if (!finalPreview || !finalPreview.moved) {
      props.onSelect(clip.id, event.shiftKey);
      return;
    }
    if (kind === "move") {
      if (finalPreview.startFrame === origin.startFrame && finalPreview.trackId === originTrackId) return;
      props.onCommitMove({ clipId: clip.id, startFrame: finalPreview.startFrame, trackId: finalPreview.trackId });
      return;
    }
    if (finalPreview.startFrame === origin.startFrame && finalPreview.durationFrames === origin.durationFrames) return;
    props.onCommitTrim({
      clipId: clip.id,
      startFrame: finalPreview.startFrame,
      durationFrames: finalPreview.durationFrames,
      sourceInFrame: finalPreview.sourceInFrame
    });
  }
  useEffect2(() => {
    if (!preview) return;
    function onKeyDown(event) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      endGestureCleanup();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [preview !== null]);
  const mediaUrl = clip.media?.url;
  const mediaKind = clip.media?.kind;
  const isVisualMedia = mediaKind === "video" || mediaKind === "image";
  const isAudioMedia = mediaKind === "audio";
  useEffect2(() => {
    const canvas = posterRef.current;
    if (!canvas || !mediaUrl || !isVisualMedia) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || 40;
    const cssHeight = canvas.clientHeight || 40;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    ctx.scale(dpr, dpr);
    let cancelled = false;
    frameProvider.drawFrame(mediaUrl, clip.sourceInFrame / fps, ctx, { x: 0, y: 0, width: cssWidth, height: cssHeight }).catch(() => {
      if (!cancelled) canvas.dataset.posterError = "true";
    });
    return () => {
      cancelled = true;
    };
  }, [mediaUrl, isVisualMedia, clip.sourceInFrame, fps, frameProvider]);
  useEffect2(() => {
    const canvas = waveformRef.current;
    if (!canvas || !mediaUrl || !isAudioMedia) return;
    let pending = waveformCache.get(clip.id);
    if (!pending) {
      pending = loadWaveform(mediaUrl, WAVEFORM_BUCKETS);
      pending.catch(() => waveformCache.delete(clip.id));
      waveformCache.set(clip.id, pending);
    }
    let cancelled = false;
    pending.then((data) => {
      if (cancelled) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const cssWidth = canvas.clientWidth || 1;
      const cssHeight = canvas.clientHeight || 1;
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      ctx.scale(dpr, dpr);
      const bucketsPerSecond = data.peaks.length / data.durationSeconds;
      const fromBucket = Math.floor(shown.sourceInFrame / fps * bucketsPerSecond);
      const toBucket = Math.ceil((shown.sourceInFrame + shown.durationFrames) / fps * bucketsPerSecond);
      const peaks = data.peaks.subarray(Math.max(0, fromBucket), Math.min(data.peaks.length, Math.max(fromBucket + 1, toBucket)));
      if (peaks.length === 0) return;
      drawWaveform(
        ctx,
        { peaks, samplesPerBucket: data.samplesPerBucket, durationSeconds: data.durationSeconds },
        { x: 0, y: 0, width: cssWidth, height: cssHeight },
        "rgba(52, 211, 153, 0.75)"
      );
    }).catch(() => {
      if (!cancelled) canvas.dataset.waveformError = "true";
    });
    return () => {
      cancelled = true;
    };
  }, [mediaUrl, isAudioMedia, clip.id, fps, shown.sourceInFrame, shown.durationFrames, geometry.width]);
  function commitText() {
    if (editingText === null) return;
    const next = editingText.trim();
    setEditingText(null);
    if (next.length === 0 || next === clip.text) return;
    props.onCommitText({ clipId: clip.id, text: next });
  }
  const isCaption = track.kind === "caption";
  const dragging = preview !== null;
  function handleKeyDown(event) {
    if (editingText !== null) return;
    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      event.stopPropagation();
      props.onSelect(clip.id, event.shiftKey);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      if (!interactive) return;
      event.preventDefault();
      event.stopPropagation();
      props.onRequestDelete(clip.id);
      return;
    }
    if (event.altKey) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      props.onFocusStep(clip.id, -1);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      props.onFocusStep(clip.id, 1);
    }
  }
  return /* @__PURE__ */ jsxs3(
    "div",
    {
      ref: rootRef,
      "data-clip-id": clip.id,
      role: "button",
      "aria-pressed": selected,
      "aria-label": clip.label,
      tabIndex: tabbable ? 0 : -1,
      onKeyDown: handleKeyDown,
      title: clip.label,
      className: `group absolute bottom-1 top-1 overflow-hidden rounded border text-left select-none ${KIND_TONES[track.kind]} ${selected ? "ring-2 ring-[var(--brand-primary)]" : "hover:ring-1 hover:ring-[var(--text-muted)]"} ${clip.disabled ? "opacity-40" : ""} ${dragging ? "z-30 shadow-lg shadow-black/30" : ""} ${interactive ? "cursor-grab active:cursor-grabbing" : "cursor-default"}`,
      style: {
        left: `${geometry.left}px`,
        width: `${geometry.width}px`,
        transform: shown.translateY !== 0 ? `translateY(${shown.translateY}px)` : void 0,
        // own the touch gesture so move/trim drags don't trigger lane scroll
        touchAction: "none"
      },
      onPointerDown: (event) => beginGesture(event, "move"),
      onPointerMove: updateGesture,
      onPointerUp: finishGesture,
      onPointerCancel: endGestureCleanup,
      onClick: (event) => event.stopPropagation(),
      onDoubleClick: (event) => {
        event.stopPropagation();
        if (isCaption && interactive && typeof clip.text === "string") setEditingText(clip.text);
      },
      children: [
        isAudioMedia ? /* @__PURE__ */ jsx5("canvas", { ref: waveformRef, className: "absolute inset-0 h-full w-full" }) : null,
        /* @__PURE__ */ jsxs3("div", { className: "relative flex h-full min-w-0 items-stretch gap-1.5 px-1.5 py-1", children: [
          isVisualMedia ? /* @__PURE__ */ jsx5("canvas", { ref: posterRef, className: "h-full w-10 shrink-0 rounded-sm bg-black object-cover" }) : null,
          /* @__PURE__ */ jsxs3("div", { className: "min-w-0 flex-1", children: [
            /* @__PURE__ */ jsx5("div", { className: "truncate text-xs font-medium leading-4 text-[var(--text-primary)]", children: isCaption && typeof clip.text === "string" ? clip.text : clip.label }),
            /* @__PURE__ */ jsx5("span", { className: "mt-0.5 inline-block rounded bg-[hsl(var(--background))] px-1 font-mono text-[9px] leading-3 text-[var(--text-secondary)]", children: formatTimecode(shown.durationFrames, fps) })
          ] })
        ] }),
        editingText !== null ? /* @__PURE__ */ jsx5(
          "input",
          {
            autoFocus: true,
            value: editingText,
            onChange: (event) => setEditingText(event.target.value),
            onPointerDown: (event) => event.stopPropagation(),
            onKeyDown: (event) => {
              if (event.key === "Enter") commitText();
              if (event.key === "Escape") setEditingText(null);
              event.stopPropagation();
            },
            onBlur: commitText,
            className: "agent-app-edit-selection absolute inset-0 z-10 w-full bg-[hsl(var(--popover))] px-1.5 text-xs text-[var(--text-primary)] ring-1 ring-[var(--brand-primary)]",
            "aria-label": "Caption text"
          }
        ) : null,
        interactive ? /* @__PURE__ */ jsxs3(Fragment, { children: [
          /* @__PURE__ */ jsx5(
            "span",
            {
              "data-trim-handle": "start",
              className: "absolute bottom-0 left-0 top-0 z-10 w-1.5 cursor-ew-resize bg-transparent opacity-0 transition group-hover:opacity-100 group-hover:bg-[var(--brand-primary)]",
              onPointerDown: (event) => beginGesture(event, "trim-start"),
              onPointerMove: updateGesture,
              onPointerUp: finishGesture,
              onPointerCancel: endGestureCleanup,
              "aria-hidden": true
            }
          ),
          /* @__PURE__ */ jsx5(
            "span",
            {
              "data-trim-handle": "end",
              className: "absolute bottom-0 right-0 top-0 z-10 w-1.5 cursor-ew-resize bg-transparent opacity-0 transition group-hover:opacity-100 group-hover:bg-[var(--brand-primary)]",
              onPointerDown: (event) => beginGesture(event, "trim-end"),
              onPointerMove: updateGesture,
              onPointerUp: finishGesture,
              onPointerCancel: endGestureCleanup,
              "aria-hidden": true
            }
          )
        ] }) : null
      ]
    }
  );
}

// src/sequences-react/components/glyphs.tsx
import { Fragment as Fragment2, jsx as jsx6, jsxs as jsxs4 } from "react/jsx-runtime";
function glyph(paths) {
  return function Glyph({ className }) {
    return /* @__PURE__ */ jsx6("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: paths });
  };
}
var FilmGlyph = glyph(
  /* @__PURE__ */ jsxs4(Fragment2, { children: [
    /* @__PURE__ */ jsx6("rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }),
    /* @__PURE__ */ jsx6("path", { d: "M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4" })
  ] })
);
var AudioGlyph = glyph(
  /* @__PURE__ */ jsx6("path", { d: "M2 12h2l2-7 3 14 3-9 2 5 2-3h6" })
);
var CaptionGlyph = glyph(
  /* @__PURE__ */ jsxs4(Fragment2, { children: [
    /* @__PURE__ */ jsx6("rect", { x: "2", y: "5", width: "20", height: "14", rx: "2" }),
    /* @__PURE__ */ jsx6("path", { d: "M6 13h4M6 16h8M14 13h4" })
  ] })
);
var ReferenceGlyph = glyph(
  /* @__PURE__ */ jsxs4(Fragment2, { children: [
    /* @__PURE__ */ jsx6("rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }),
    /* @__PURE__ */ jsx6("circle", { cx: "9", cy: "9", r: "2" }),
    /* @__PURE__ */ jsx6("path", { d: "m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" })
  ] })
);
var AgentGlyph = glyph(
  /* @__PURE__ */ jsxs4(Fragment2, { children: [
    /* @__PURE__ */ jsx6("rect", { x: "4", y: "8", width: "16", height: "12", rx: "2" }),
    /* @__PURE__ */ jsx6("path", { d: "M12 8V4M8 4h8M9 13v2M15 13v2" })
  ] })
);
var LockGlyph = glyph(
  /* @__PURE__ */ jsxs4(Fragment2, { children: [
    /* @__PURE__ */ jsx6("rect", { x: "5", y: "11", width: "14", height: "10", rx: "2" }),
    /* @__PURE__ */ jsx6("path", { d: "M8 11V7a4 4 0 0 1 8 0v4" })
  ] })
);
var MutedGlyph = glyph(
  /* @__PURE__ */ jsxs4(Fragment2, { children: [
    /* @__PURE__ */ jsx6("path", { d: "M11 5 6 9H2v6h4l5 4z" }),
    /* @__PURE__ */ jsx6("path", { d: "m23 9-6 6M17 9l6 6" })
  ] })
);
var PlayGlyph = glyph(
  /* @__PURE__ */ jsx6("path", { d: "m6 4 14 8-14 8z", fill: "currentColor", stroke: "none" })
);
var PauseGlyph = glyph(
  /* @__PURE__ */ jsx6("path", { d: "M7 4h3v16H7zM14 4h3v16h-3z", fill: "currentColor", stroke: "none" })
);
var UndoGlyph = glyph(
  /* @__PURE__ */ jsx6("path", { d: "M3 7v6h6M3 13a9 9 0 1 0 3-7.7" })
);
var RedoGlyph = glyph(
  /* @__PURE__ */ jsx6("path", { d: "M21 7v6h-6M21 13a9 9 0 1 1-3-7.7" })
);
var MagnetGlyph = glyph(
  /* @__PURE__ */ jsxs4(Fragment2, { children: [
    /* @__PURE__ */ jsx6("path", { d: "m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3z" }),
    /* @__PURE__ */ jsx6("path", { d: "m5 8 4 4M12 15l4 4" })
  ] })
);
var ScissorsGlyph = glyph(
  /* @__PURE__ */ jsxs4(Fragment2, { children: [
    /* @__PURE__ */ jsx6("circle", { cx: "6", cy: "6", r: "3" }),
    /* @__PURE__ */ jsx6("circle", { cx: "6", cy: "18", r: "3" }),
    /* @__PURE__ */ jsx6("path", { d: "M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12" })
  ] })
);
var CaptionPlusGlyph = glyph(
  /* @__PURE__ */ jsxs4(Fragment2, { children: [
    /* @__PURE__ */ jsx6("rect", { x: "2", y: "5", width: "20", height: "14", rx: "2" }),
    /* @__PURE__ */ jsx6("path", { d: "M12 9v6M9 12h6" })
  ] })
);
var ExportGlyph = glyph(
  /* @__PURE__ */ jsxs4(Fragment2, { children: [
    /* @__PURE__ */ jsx6("path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }),
    /* @__PURE__ */ jsx6("path", { d: "M12 3v12M8 7l4-4 4 4" })
  ] })
);
var PlusGlyph = glyph(/* @__PURE__ */ jsx6("path", { d: "M12 5v14M5 12h14" }));
var MinusGlyph = glyph(/* @__PURE__ */ jsx6("path", { d: "M5 12h14" }));

// src/sequences-react/components/TimelineTrackRow.tsx
import { jsx as jsx7, jsxs as jsxs5 } from "react/jsx-runtime";
var LANE_HEIGHTS = {
  video: "h-16",
  reference: "h-16",
  audio: "h-14",
  caption: "h-9",
  agent: "h-9"
};
var KIND_GLYPHS = {
  video: FilmGlyph,
  audio: AudioGlyph,
  caption: CaptionGlyph,
  reference: ReferenceGlyph,
  agent: AgentGlyph
};
function TimelineTrackRow(props) {
  const { track, clips, fps, zoom, sequenceDurationFrames } = props;
  const Glyph = KIND_GLYPHS[track.kind];
  const laneHeight = LANE_HEIGHTS[track.kind];
  function handleLanePointerDown(event) {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const frame = Math.max(0, Math.min(sequenceDurationFrames, Math.round((event.clientX - rect.left) / zoom)));
    props.onLaneSeek(frame);
  }
  return /* @__PURE__ */ jsxs5("div", { className: "flex border-b border-[var(--border-default)] last:border-b-0", children: [
    /* @__PURE__ */ jsxs5("div", { className: `sticky left-0 z-10 flex w-36 shrink-0 items-center gap-2 border-r border-[var(--border-default)] bg-[var(--bg-input)] px-2.5 ${laneHeight}`, children: [
      /* @__PURE__ */ jsx7(Glyph, { className: "h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" }),
      /* @__PURE__ */ jsx7("span", { className: "min-w-0 flex-1 truncate text-xs font-medium text-[var(--text-secondary)]", children: track.name }),
      track.locked ? /* @__PURE__ */ jsx7(LockGlyph, { className: "h-3 w-3 shrink-0 text-[var(--text-warning)]" }) : null,
      track.muted ? /* @__PURE__ */ jsx7(MutedGlyph, { className: "h-3 w-3 shrink-0 text-[var(--text-muted)]" }) : null
    ] }),
    /* @__PURE__ */ jsx7(
      "div",
      {
        "data-lane-track": track.id,
        "data-lane-kind": track.kind,
        "data-lane-locked": track.locked ? "true" : "false",
        className: `relative ${laneHeight} ${track.muted ? "opacity-60" : ""}`,
        style: { width: `${sequenceDurationFrames * zoom}px`, touchAction: "none" },
        onPointerDown: handleLanePointerDown,
        children: clips.map((clip) => /* @__PURE__ */ jsx7(
          TimelineClipChip,
          {
            clip,
            track,
            fps,
            zoom,
            sequenceDurationFrames,
            selected: props.selectedClipIds.has(clip.id),
            canWrite: props.canWrite,
            tabbable: props.tabbableClipId === clip.id,
            frameProvider: props.frameProvider,
            snapMove: props.snapMove,
            snapEdge: props.snapEdge,
            onSnapPointChange: props.onSnapPointChange,
            onSelect: props.onSelectClip,
            onRequestDelete: props.onRequestDeleteClip,
            onFocusStep: props.onFocusStepClip,
            onCommitMove: props.onCommitMove,
            onCommitTrim: props.onCommitTrim,
            onCommitText: props.onCommitText
          },
          clip.id
        ))
      }
    )
  ] });
}

// src/sequences-react/components/BrandMark.tsx
import { lazy, Suspense } from "react";
import { jsx as jsx8 } from "react/jsx-runtime";
function MarkSpacer({ size }) {
  return /* @__PURE__ */ jsx8("span", { "aria-hidden": true, style: { display: "inline-block", width: size, height: size } });
}
var LazyKnot = lazy(async () => {
  try {
    const mod = await import("./brand/index.js");
    return { default: mod.TangleKnot };
  } catch {
    return { default: MarkSpacer };
  }
});
function BrandMark({ size, className }) {
  return /* @__PURE__ */ jsx8(Suspense, { fallback: /* @__PURE__ */ jsx8(MarkSpacer, { size }), children: /* @__PURE__ */ jsx8(LazyKnot, { size, className }) });
}

// src/sequences-react/components/TimelineEmptyState.tsx
import { jsx as jsx9, jsxs as jsxs6 } from "react/jsx-runtime";
var DOOR_BUTTON = "flex min-h-[44px] items-center gap-2 rounded-md border border-[var(--border-default)] bg-[var(--bg-input)] px-3.5 py-2 text-xs font-medium text-[var(--text-secondary)] transition hover:border-[var(--brand-primary)] hover:text-[var(--text-primary)]";
function TimelineEmptyState(props) {
  const labels = { ...DEFAULT_TIMELINE_LABELS, ...props.labels };
  const doors = [];
  if (props.onStartFromTemplate) {
    doors.push({ key: "template", label: labels.emptyTemplateDoor, primary: true, icon: FilmGlyph, onClick: props.onStartFromTemplate });
  }
  if (props.onAddClip) {
    doors.push({ key: "clip", label: labels.emptyClipDoor, primary: false, icon: CaptionPlusGlyph, onClick: props.onAddClip });
  }
  if (props.onAskAgent) {
    doors.push({ key: "agent", label: labels.emptyAgentDoor, primary: false, icon: AgentGlyph, onClick: props.onAskAgent });
  }
  return /* @__PURE__ */ jsxs6(
    "div",
    {
      "data-timeline-empty": true,
      className: "sticky left-0 flex min-h-[6rem] flex-col items-center justify-center gap-3 px-6 py-9 text-center",
      style: { width: "100%" },
      children: [
        /* @__PURE__ */ jsx9(BrandMark, { size: 28, className: "shrink-0 opacity-90" }),
        /* @__PURE__ */ jsxs6("div", { className: "flex flex-col gap-1", children: [
          /* @__PURE__ */ jsx9("p", { className: "text-sm font-semibold text-[var(--text-primary)]", children: labels.emptyTitle }),
          /* @__PURE__ */ jsx9("p", { className: "max-w-sm text-xs text-[var(--text-muted)]", children: labels.emptyBody })
        ] }),
        doors.length > 0 ? /* @__PURE__ */ jsx9("div", { className: "flex flex-wrap items-center justify-center gap-2 pt-1", children: doors.map(({ key, label, primary, icon: Icon, onClick }) => /* @__PURE__ */ jsxs6(
          "button",
          {
            type: "button",
            onClick,
            className: primary ? "flex min-h-[44px] items-center gap-2 rounded-md bg-[var(--brand-primary)] px-3.5 py-2 text-xs font-semibold text-[hsl(var(--primary-foreground))] transition hover:opacity-90" : DOOR_BUTTON,
            children: [
              /* @__PURE__ */ jsx9(Icon, { className: "h-4 w-4 shrink-0" }),
              label
            ]
          },
          key
        )) }) : null
      ]
    }
  );
}

// src/sequences-react/components/TimelineGhostLanes.tsx
import { jsx as jsx10, jsxs as jsxs7 } from "react/jsx-runtime";
function GhostLane({
  label,
  icon: Icon,
  height,
  laneWidth
}) {
  return /* @__PURE__ */ jsxs7("div", { className: "flex border-b border-[var(--border-soft)] last:border-b-0", children: [
    /* @__PURE__ */ jsxs7(
      "div",
      {
        className: `sticky left-0 z-10 flex w-36 shrink-0 items-center gap-2 border-r border-[var(--border-soft)] bg-[var(--bg-input)] px-2.5 ${height}`,
        children: [
          /* @__PURE__ */ jsx10(Icon, { className: "h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" }),
          /* @__PURE__ */ jsx10("span", { className: "min-w-0 flex-1 truncate text-xs font-medium text-[var(--text-muted)]", children: label })
        ]
      }
    ),
    /* @__PURE__ */ jsx10("div", { className: `${height}`, style: { width: `${laneWidth}px` } })
  ] });
}
function TimelineGhostLanes({ laneWidth, videoLabel, captionLabel }) {
  return /* @__PURE__ */ jsxs7("div", { "data-timeline-ghost-lanes": true, "aria-hidden": true, className: "pointer-events-none absolute inset-0", children: [
    /* @__PURE__ */ jsx10(GhostLane, { label: videoLabel, icon: FilmGlyph, height: "h-16", laneWidth }),
    /* @__PURE__ */ jsx10(GhostLane, { label: captionLabel, icon: CaptionGlyph, height: "h-9", laneWidth })
  ] });
}

// src/sequences-react/components/TimelineSmallScreenGate.tsx
import { jsx as jsx11, jsxs as jsxs8 } from "react/jsx-runtime";
function TimelineSmallScreenGate({ labels }) {
  const copy = { ...DEFAULT_TIMELINE_LABELS, ...labels };
  return /* @__PURE__ */ jsxs8(
    "div",
    {
      "data-timeline-small-screen": true,
      className: "flex h-full min-h-0 flex-col items-center justify-center gap-3 bg-[var(--bg-input)] px-8 py-12 text-center text-[var(--text-primary)] sm:hidden",
      children: [
        /* @__PURE__ */ jsx11(BrandMark, { size: 32, className: "shrink-0 opacity-90" }),
        /* @__PURE__ */ jsx11("p", { className: "text-sm font-semibold", children: copy.smallScreenTitle }),
        /* @__PURE__ */ jsx11("p", { className: "max-w-xs text-sm text-[var(--text-muted)]", children: copy.smallScreenBody })
      ]
    }
  );
}

// src/sequences-react/components/ZoomControl.tsx
import { jsx as jsx12, jsxs as jsxs9 } from "react/jsx-runtime";
function zoomPercent(zoom, fitZoom) {
  const base = fitZoom && fitZoom > 0 ? fitZoom : 1;
  return Math.round(zoom / base * 100);
}
var ZOOM_STEP_BUTTON = "flex h-7 w-7 items-center justify-center rounded border border-[var(--border-default)] text-sm leading-none text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]";
function ZoomControl({ zoomMath, zoom, onZoomChange, fitZoom }) {
  const sliderMin = zoomMath.zoomToSlider(zoomMath.minZoom);
  const sliderMax = zoomMath.zoomToSlider(zoomMath.maxZoom);
  const sliderStep = (sliderMax - sliderMin) / 100;
  const slider = zoomMath.zoomToSlider(zoom);
  const percent = zoomPercent(zoom, fitZoom);
  function setSlider(next) {
    const clamped = Math.max(sliderMin, Math.min(sliderMax, next));
    onZoomChange(zoomMath.sliderToZoom(clamped));
  }
  return /* @__PURE__ */ jsxs9("div", { className: "flex items-center gap-1.5", children: [
    /* @__PURE__ */ jsx12(
      "button",
      {
        type: "button",
        "aria-label": "Zoom out",
        onClick: () => setSlider(slider - sliderStep * 10),
        className: ZOOM_STEP_BUTTON,
        children: /* @__PURE__ */ jsx12(MinusGlyph, { className: "h-3.5 w-3.5" })
      }
    ),
    /* @__PURE__ */ jsx12(
      "input",
      {
        type: "range",
        "aria-label": "Timeline zoom",
        "aria-valuetext": `${percent}%`,
        min: sliderMin,
        max: sliderMax,
        step: sliderStep,
        value: slider,
        onChange: (event) => setSlider(Number(event.target.value)),
        className: "hidden h-1 w-24 cursor-pointer accent-[var(--brand-primary)] sm:block"
      }
    ),
    /* @__PURE__ */ jsx12(
      "button",
      {
        type: "button",
        "aria-label": "Zoom in",
        onClick: () => setSlider(slider + sliderStep * 10),
        className: ZOOM_STEP_BUTTON,
        children: /* @__PURE__ */ jsx12(PlusGlyph, { className: "h-3.5 w-3.5" })
      }
    ),
    /* @__PURE__ */ jsxs9(
      "output",
      {
        "aria-hidden": true,
        title: fitZoom ? "Zoom (100% = fits the whole sequence)" : "Zoom",
        onClick: fitZoom ? () => onZoomChange(fitZoom) : void 0,
        className: `w-11 select-none text-right font-mono text-xs tabular-nums text-[var(--text-muted)] ${fitZoom ? "cursor-pointer hover:text-[var(--text-primary)]" : ""}`,
        children: [
          percent,
          "%"
        ]
      }
    )
  ] });
}

// src/sequences-react/components/TimelineEditor.tsx
import { Fragment as Fragment3, jsx as jsx13, jsxs as jsxs10 } from "react/jsx-runtime";
var SEQUENCE_MEDIA_DRAG_TYPE = "application/x-sequence-media";
var HISTORY_MIRROR_LIMIT = 200;
var MIN_ZOOM = 5e-3;
var MAX_ZOOM = 24;
var TRACK_HEADER_PX = 144;
var TRANSPORT_BUTTON = "flex h-7 w-7 items-center justify-center rounded border border-[var(--border-default)] text-[var(--text-secondary)] transition hover:text-[var(--text-primary)] disabled:cursor-default disabled:opacity-40 disabled:hover:text-[var(--text-secondary)]";
var EDIT_TOOL_BUTTON = "flex h-7 items-center gap-1.5 rounded border border-[var(--border-default)] px-2 text-xs font-medium text-[var(--text-secondary)] transition hover:text-[var(--text-primary)] disabled:cursor-default disabled:opacity-40 disabled:hover:text-[var(--text-secondary)]";
var CLUSTER_DIVIDER = "mx-1 h-5 w-px shrink-0 bg-[var(--border-default)]";
function mintClipId() {
  const uuid = globalThis.crypto && "randomUUID" in globalThis.crypto ? globalThis.crypto.randomUUID() : null;
  return `local-${uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}
function isTypingTarget(target) {
  return target instanceof Element && target.closest('input, textarea, select, button, [contenteditable="true"]') !== null;
}
function parseMediaDragPayload(raw) {
  const parsed = JSON.parse(raw);
  if (typeof parsed.url !== "string" || parsed.url.length === 0) {
    throw new Error(`${SEQUENCE_MEDIA_DRAG_TYPE} payload requires a non-empty url`);
  }
  if (parsed.kind !== "video" && parsed.kind !== "image" && parsed.kind !== "audio") {
    throw new Error(`${SEQUENCE_MEDIA_DRAG_TYPE} payload kind must be video | image | audio, got ${String(parsed.kind)}`);
  }
  return parsed;
}
function TimelineEditor(props) {
  const { canWrite, onApplyOperations } = props;
  const fps = props.timeline.sequence.fps;
  const durationFrames = props.timeline.sequence.durationFrames;
  const labels = useMemo3(() => ({ ...DEFAULT_TIMELINE_LABELS, ...props.labels }), [props.labels]);
  const stack = useMemo3(() => createCommandStack(props.timeline), []);
  const editorState = useSyncExternalStore(stack.subscribe, stack.getState, stack.getState);
  const timeline = editorState.timeline;
  const appliedTimelineRef = useRef3(props.timeline);
  useEffect3(() => {
    if (appliedTimelineRef.current === props.timeline) return;
    appliedTimelineRef.current = props.timeline;
    stack.reset(props.timeline);
  }, [props.timeline, stack]);
  const [clock, setClock] = useState3(
    () => createPlaybackClock({ fps, durationFrames: timeline.sequence.durationFrames })
  );
  const clockRef = useRef3(clock);
  const [playheadFrame, setPlayheadFrame] = useState3(0);
  const playheadFrameRef = useRef3(0);
  const [isPlaying, setIsPlaying] = useState3(false);
  const onPlayheadChangeRef = useRef3(props.onPlayheadChange);
  onPlayheadChangeRef.current = props.onPlayheadChange;
  useEffect3(() => {
    const next = createPlaybackClock({ fps, durationFrames: timeline.sequence.durationFrames });
    clockRef.current.dispose();
    clockRef.current = next;
    setClock(next);
    next.seek(Math.min(playheadFrameRef.current, timeline.sequence.durationFrames - 1));
    const unsubscribe = next.subscribe((frame) => {
      playheadFrameRef.current = frame;
      setPlayheadFrame(frame);
      setIsPlaying(next.isPlaying());
      onPlayheadChangeRef.current?.(frame);
    });
    return () => {
      unsubscribe();
      next.dispose();
    };
  }, [fps, timeline.sequence.durationFrames]);
  const [frameProvider, setFrameProvider] = useState3(
    () => props.frameProvider ?? createVideoElementFrameProvider()
  );
  const frameProviderRef = useRef3(frameProvider);
  const ownsFrameProviderRef = useRef3(!props.frameProvider);
  useEffect3(() => {
    const next = props.frameProvider ?? createVideoElementFrameProvider();
    if (ownsFrameProviderRef.current) frameProviderRef.current.dispose();
    ownsFrameProviderRef.current = !props.frameProvider;
    frameProviderRef.current = next;
    setFrameProvider(next);
    return () => {
      if (!props.frameProvider) next.dispose();
    };
  }, [props.frameProvider]);
  const zoomMath = useMemo3(() => createZoomMath({ minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM }), []);
  const [zoom, setZoom] = useState3(1);
  const [fitZoom, setFitZoom] = useState3(void 0);
  const trackViewportRef = useRef3(null);
  useEffect3(() => {
    const viewport = trackViewportRef.current;
    if (!viewport) return;
    const laneWidth = viewport.clientWidth - TRACK_HEADER_PX;
    if (laneWidth <= 0) return;
    const fit = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, laneWidth / durationFrames));
    setFitZoom(fit);
    setZoom(fit);
  }, []);
  const [snapEnabled, setSnapEnabled] = useState3(true);
  const [activeSnapPoint, setActiveSnapPoint] = useState3(null);
  const [selectedClipIds, setSelectedClipIds] = useState3([]);
  const [commitError, setCommitError] = useState3(null);
  const selectedClips = useMemo3(
    () => timeline.clips.filter((clip) => selectedClipIds.includes(clip.id)),
    [timeline, selectedClipIds]
  );
  const onSelectionChangeRef = useRef3(props.onSelectionChange);
  onSelectionChangeRef.current = props.onSelectionChange;
  useEffect3(() => {
    onSelectionChangeRef.current?.(selectedClips);
  }, [selectedClips]);
  const sortedTracks = useMemo3(() => [...timeline.tracks].sort((a, b) => a.sortOrder - b.sortOrder), [timeline.tracks]);
  const orderedClipIds = useMemo3(() => {
    const ids = [];
    for (const track of sortedTracks) {
      for (const clip of timeline.clips) {
        if (clip.trackId === track.id) ids.push(clip.id);
      }
    }
    return ids;
  }, [sortedTracks, timeline.clips]);
  const tabbableClipId = useMemo3(() => {
    const selected = orderedClipIds.find((id) => selectedClipIds.includes(id));
    return selected ?? orderedClipIds[0] ?? null;
  }, [orderedClipIds, selectedClipIds]);
  const clipsByTrack = useMemo3(() => {
    const byTrack = /* @__PURE__ */ new Map();
    for (const clip of timeline.clips) {
      const bucket = byTrack.get(clip.trackId);
      if (bucket) bucket.push(clip);
      else byTrack.set(clip.trackId, [clip]);
    }
    return byTrack;
  }, [timeline.clips]);
  const historyRef = useRef3({ done: [], undone: [] });
  const clipIdAliasesRef = useRef3(/* @__PURE__ */ new Map());
  function resolveClipId(clipId) {
    return clipIdAliasesRef.current.get(clipId) ?? clipId;
  }
  function reconcileCreatedClipIds(operations, createdLocalIds, results) {
    if (createdLocalIds.length === 0 || !Array.isArray(results)) return;
    if (results.length !== operations.length) {
      setCommitError(
        `onApplyOperations returned ${results.length} results for ${operations.length} operations \u2014 clip-id reconciliation skipped`
      );
      return;
    }
    let cursor = 0;
    operations.forEach((operation, index) => {
      if (operation.type !== "place_clip" && operation.type !== "add_caption" && operation.type !== "split_clip") return;
      const localId = createdLocalIds[cursor];
      cursor += 1;
      const result = results[index];
      if (localId !== void 0 && result !== void 0 && result.kind === "clip") {
        clipIdAliasesRef.current.set(localId, result.clip.id);
      }
    });
  }
  function commitCommand(command, createdLocalIds = []) {
    if (!canWrite) return;
    try {
      stack.execute(command);
    } catch (error) {
      setCommitError(error instanceof Error ? error.message : String(error));
      return;
    }
    const history = historyRef.current;
    const entry = { command, createdLocalIds };
    history.done.push(entry);
    if (history.done.length > HISTORY_MIRROR_LIMIT) history.done.splice(0, history.done.length - HISTORY_MIRROR_LIMIT);
    history.undone = [];
    setCommitError(null);
    const operations = command.operations();
    void onApplyOperations(operations).then((results) => reconcileCreatedClipIds(operations, createdLocalIds, results)).catch((error) => {
      const mirror = historyRef.current;
      if (mirror.done[mirror.done.length - 1] === entry && stack.canUndo()) {
        stack.undo();
        mirror.done.pop();
      }
      setCommitError(error instanceof Error ? error.message : String(error));
    });
  }
  function undoLast() {
    const history = historyRef.current;
    const entry = history.done[history.done.length - 1];
    if (!entry || !stack.canUndo()) return;
    try {
      stack.undo();
    } catch (error) {
      setCommitError(`Undo failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    history.done.pop();
    history.undone.push(entry);
    void onApplyOperations(entry.command.inverseOperations()).catch((error) => {
      const mirror = historyRef.current;
      if (mirror.undone[mirror.undone.length - 1] === entry && stack.canRedo()) {
        stack.redo();
        mirror.undone.pop();
        mirror.done.push(entry);
      }
      setCommitError(error instanceof Error ? error.message : String(error));
    });
  }
  function redoLast() {
    const history = historyRef.current;
    const entry = history.undone[history.undone.length - 1];
    if (!entry || !stack.canRedo()) return;
    try {
      stack.redo();
    } catch (error) {
      setCommitError(`Redo failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    history.undone.pop();
    history.done.push(entry);
    const operations = entry.command.operations();
    void onApplyOperations(operations).then((results) => reconcileCreatedClipIds(operations, entry.createdLocalIds, results)).catch((error) => {
      const mirror = historyRef.current;
      if (mirror.done[mirror.done.length - 1] === entry && stack.canUndo()) {
        stack.undo();
        mirror.done.pop();
        mirror.undone.push(entry);
      }
      setCommitError(error instanceof Error ? error.message : String(error));
    });
  }
  function handleCommitMove(input) {
    const current = stack.getState().timeline;
    const clip = current.clips.find((candidate) => candidate.id === input.clipId);
    if (!clip) return;
    commitCommand(
      moveClipCommand({
        timeline: current,
        clipId: input.clipId,
        startFrame: input.startFrame,
        ...input.trackId !== clip.trackId ? { trackId: input.trackId } : {},
        resolveClipId
      })
    );
  }
  function handleCommitTrim(input) {
    commitCommand(
      trimClipCommand({
        timeline: stack.getState().timeline,
        clipId: input.clipId,
        startFrame: input.startFrame,
        durationFrames: input.durationFrames,
        sourceInFrame: input.sourceInFrame,
        resolveClipId
      })
    );
  }
  function handleCommitText(input) {
    commitCommand(
      setClipTextCommand({ timeline: stack.getState().timeline, clipId: input.clipId, text: input.text, resolveClipId })
    );
  }
  function deleteSelection() {
    const current = stack.getState().timeline;
    const lockedTrackIds = new Set(current.tracks.filter((track) => track.locked).map((track) => track.id));
    const targets = selectedClips.filter((clip) => !lockedTrackIds.has(clip.trackId));
    if (targets.length === 0) return;
    const commands = targets.map((clip) => deleteClipCommand({ timeline: current, clipId: clip.id, resolveClipId }));
    commitCommand(commands.length === 1 ? commands[0] : compositeCommand(`Delete ${commands.length} clips`, commands));
    setSelectedClipIds([]);
  }
  function deleteClip(clipId) {
    const current = stack.getState().timeline;
    const clip = current.clips.find((candidate) => candidate.id === clipId);
    if (!clip) return;
    const track = current.tracks.find((candidate) => candidate.id === clip.trackId);
    if (track?.locked) return;
    commitCommand(deleteClipCommand({ timeline: current, clipId, resolveClipId }));
    setSelectedClipIds((ids) => ids.filter((id) => id !== clipId));
  }
  function focusStepClip(clipId, direction) {
    const index = orderedClipIds.indexOf(clipId);
    if (index === -1) return;
    const nextId = orderedClipIds[index + direction];
    if (nextId === void 0) return;
    const root = trackViewportRef.current;
    const next = root?.querySelector(`[data-clip-id="${CSS.escape(nextId)}"]`);
    next?.focus();
  }
  function stepPlayhead(deltaFrames) {
    const max = stack.getState().timeline.sequence.durationFrames - 1;
    const next = Math.max(0, Math.min(max, playheadFrameRef.current + deltaFrames));
    clock.seek(next);
  }
  function nudgeSelectedClip(deltaFrames) {
    if (!canWrite) return;
    const selectedId = selectedClipIds.length === 1 ? selectedClipIds[0] : void 0;
    if (selectedId === void 0) return;
    const current = stack.getState().timeline;
    const clip = current.clips.find((candidate) => candidate.id === selectedId);
    if (!clip) return;
    const track = current.tracks.find((candidate) => candidate.id === clip.trackId);
    if (track?.locked) return;
    const startFrame = clampClipStart({
      startFrame: clip.startFrame + deltaFrames,
      durationFrames: clip.durationFrames,
      sequenceDurationFrames: current.sequence.durationFrames
    });
    if (startFrame === clip.startFrame) return;
    commitCommand(moveClipCommand({ timeline: current, clipId: selectedId, startFrame, resolveClipId }));
  }
  const splittableClip = selectedClips.length === 1 && selectedClips[0] && playheadFrame > selectedClips[0].startFrame && playheadFrame < selectedClips[0].startFrame + selectedClips[0].durationFrames ? selectedClips[0] : null;
  function splitAtPlayhead() {
    if (!splittableClip) return;
    const newClipId = mintClipId();
    commitCommand(
      splitClipCommand({
        timeline: stack.getState().timeline,
        clipId: splittableClip.id,
        atFrame: playheadFrame,
        newClipId,
        resolveClipId
      }),
      [newClipId]
    );
  }
  function addCaptionAtPlayhead() {
    const current = stack.getState().timeline;
    const captionTrack = [...current.tracks].sort((a, b) => a.sortOrder - b.sortOrder).find((track) => track.kind === "caption" && !track.locked);
    if (!captionTrack) {
      setCommitError("No unlocked caption track in this sequence \u2014 add one before inserting captions.");
      return;
    }
    let placement;
    try {
      placement = chooseCaptionPlacement({
        playheadFrame,
        fps,
        sequenceDurationFrames: current.sequence.durationFrames,
        occupiedIntervals: trackIntervals(current, captionTrack.id)
      });
    } catch (error) {
      setCommitError(error instanceof Error ? error.message : String(error));
      return;
    }
    const clipId = mintClipId();
    commitCommand(
      addCaptionCommand({
        timeline: current,
        clipId,
        trackId: captionTrack.id,
        text: "New caption",
        startFrame: placement.startFrame,
        durationFrames: placement.durationFrames,
        resolveClipId
      }),
      [clipId]
    );
  }
  function selectClip(clipId, additive) {
    setSelectedClipIds((current) => {
      if (!additive) return [clipId];
      return current.includes(clipId) ? current.filter((id) => id !== clipId) : [...current, clipId];
    });
  }
  function snapMove(candidate) {
    if (!snapEnabled) return { startFrame: candidate.startFrame, point: null };
    const points = collectSnapPoints(timeline, playheadFrame);
    const exclude = (point) => point.clipId === candidate.clipId;
    return chooseMoveSnap({
      candidateStartFrame: candidate.startFrame,
      durationFrames: candidate.durationFrames,
      startSnap: applySnap(candidate.startFrame, points, { zoom, exclude }),
      endSnap: applySnap(candidate.startFrame + candidate.durationFrames, points, { zoom, exclude })
    });
  }
  function snapEdge(candidate) {
    if (!snapEnabled) return { frame: candidate.frame, point: null };
    const points = collectSnapPoints(timeline, playheadFrame);
    const result = applySnap(candidate.frame, points, {
      zoom,
      exclude: (point) => point.clipId === candidate.clipId
    });
    return { frame: result.frame, point: result.point };
  }
  function togglePlayback() {
    if (clock.isPlaying()) clock.pause();
    else clock.play();
    setIsPlaying(clock.isPlaying());
  }
  useEffect3(() => {
    function onKeyDown(event) {
      if (event.code === "Space" && !isTypingTarget(event.target)) {
        event.preventDefault();
        togglePlayback();
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && !isTypingTarget(event.target)) {
        if (!canWrite) return;
        event.preventDefault();
        deleteSelection();
        return;
      }
      if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !isTypingTarget(event.target)) {
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        if (event.altKey) {
          event.preventDefault();
          nudgeSelectedClip(direction);
          return;
        }
        if (event.target instanceof Element && event.target.closest("[data-clip-id]")) return;
        event.preventDefault();
        stepPlayhead(direction * (event.shiftKey ? 10 : 1));
        return;
      }
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || isTypingTarget(event.target)) return;
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redoLast();
        else undoLast();
      } else if (event.key.toLowerCase() === "y") {
        event.preventDefault();
        redoLast();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
  function handleTrackAreaDragOver(event) {
    if (!canWrite || !event.dataTransfer.types.includes(SEQUENCE_MEDIA_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }
  function handleTrackAreaDrop(event) {
    if (!canWrite || !event.dataTransfer.types.includes(SEQUENCE_MEDIA_DRAG_TYPE)) return;
    event.preventDefault();
    const lane = event.target instanceof Element ? event.target.closest("[data-lane-track]") : null;
    if (!lane || !lane.dataset.laneTrack) {
      setCommitError("Drop media on a track lane to place it.");
      return;
    }
    let payload;
    try {
      payload = parseMediaDragPayload(event.dataTransfer.getData(SEQUENCE_MEDIA_DRAG_TYPE));
    } catch (error) {
      setCommitError(error instanceof Error ? error.message : String(error));
      return;
    }
    const laneKind = lane.dataset.laneKind;
    const accepts = laneKind === "video" ? payload.kind === "video" || payload.kind === "image" : laneKind === "audio" ? payload.kind === "audio" : false;
    if (!accepts || lane.dataset.laneLocked === "true") {
      setCommitError(`A ${laneKind ?? "unknown"} track cannot take ${payload.kind} media${lane.dataset.laneLocked === "true" ? " (track is locked)" : ""}.`);
      return;
    }
    const current = stack.getState().timeline;
    const rect = lane.getBoundingClientRect();
    const dropFrame = Math.max(0, Math.round((event.clientX - rect.left) / zoom));
    const naturalDuration = payload.durationSeconds !== void 0 ? secondsToFrames(payload.durationSeconds, fps) : payload.kind === "image" ? fps * 3 : fps * 5;
    const startFrame = Math.min(dropFrame, current.sequence.durationFrames - 1);
    const placedDuration = Math.max(1, Math.min(naturalDuration, current.sequence.durationFrames - startFrame));
    const clipId = mintClipId();
    commitCommand(
      placeClipCommand({
        timeline: current,
        clipId,
        trackId: lane.dataset.laneTrack,
        label: payload.label ?? payload.url.split("/").pop() ?? payload.url,
        startFrame,
        durationFrames: placedDuration,
        media: { url: payload.url, kind: payload.kind },
        ...payload.generationId !== void 0 ? { generationId: payload.generationId } : {},
        ...payload.assetId !== void 0 ? { assetId: payload.assetId } : {},
        resolveClipId
      }),
      [clipId]
    );
  }
  const timelineWidth = timeline.sequence.durationFrames * zoom;
  return /* @__PURE__ */ jsxs10("div", { className: `flex h-full min-h-0 flex-col bg-[var(--bg-input)] text-[var(--text-primary)] ${props.className ?? ""}`, children: [
    /* @__PURE__ */ jsx13(TimelineSmallScreenGate, { labels: props.labels }),
    /* @__PURE__ */ jsxs10("div", { className: "hidden min-h-0 flex-1 flex-col sm:flex lg:flex-row", children: [
      /* @__PURE__ */ jsxs10("div", { className: "flex min-h-0 min-w-0 flex-1 flex-col", children: [
        /* @__PURE__ */ jsx13(PreviewCanvas, { timeline, clock, frameProvider }),
        /* @__PURE__ */ jsxs10("div", { "aria-label": "Timeline controls", className: "flex h-11 shrink-0 items-center gap-1.5 overflow-x-auto border-y border-[var(--border-default)] px-2", children: [
          /* @__PURE__ */ jsx13(
            "button",
            {
              type: "button",
              "aria-label": isPlaying ? "Pause" : "Play",
              onClick: togglePlayback,
              className: "flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--brand-primary)] text-[hsl(var(--primary-foreground))] transition hover:opacity-90",
              children: isPlaying ? /* @__PURE__ */ jsx13(PauseGlyph, { className: "h-4 w-4" }) : /* @__PURE__ */ jsx13(PlayGlyph, { className: "h-4 w-4" })
            }
          ),
          /* @__PURE__ */ jsxs10("span", { className: "shrink-0 font-mono text-xs tabular-nums text-[var(--text-secondary)]", children: [
            formatTimecode(playheadFrame, fps),
            /* @__PURE__ */ jsxs10("span", { className: "text-[var(--text-muted)]", children: [
              " / ",
              formatTimecode(timeline.sequence.durationFrames, fps)
            ] })
          ] }),
          /* @__PURE__ */ jsx13("div", { className: CLUSTER_DIVIDER }),
          /* @__PURE__ */ jsx13("button", { type: "button", "aria-label": "Undo", disabled: !stack.canUndo() || !canWrite, onClick: undoLast, className: TRANSPORT_BUTTON, children: /* @__PURE__ */ jsx13(UndoGlyph, { className: "h-3.5 w-3.5" }) }),
          /* @__PURE__ */ jsx13("button", { type: "button", "aria-label": "Redo", disabled: !stack.canRedo() || !canWrite, onClick: redoLast, className: TRANSPORT_BUTTON, children: /* @__PURE__ */ jsx13(RedoGlyph, { className: "h-3.5 w-3.5" }) }),
          /* @__PURE__ */ jsx13(
            "button",
            {
              type: "button",
              "aria-label": "Toggle snapping",
              "aria-pressed": snapEnabled,
              onClick: () => setSnapEnabled((current) => !current),
              className: `${TRANSPORT_BUTTON} ${snapEnabled ? "border-[var(--brand-primary)] text-[var(--brand-primary)] hover:text-[var(--brand-primary)]" : ""}`,
              children: /* @__PURE__ */ jsx13(MagnetGlyph, { className: "h-3.5 w-3.5" })
            }
          ),
          canWrite ? /* @__PURE__ */ jsxs10(Fragment3, { children: [
            /* @__PURE__ */ jsx13("div", { className: CLUSTER_DIVIDER }),
            /* @__PURE__ */ jsxs10("button", { type: "button", "aria-label": labels.splitClipAriaLabel, disabled: !splittableClip, onClick: splitAtPlayhead, className: EDIT_TOOL_BUTTON, children: [
              /* @__PURE__ */ jsx13(ScissorsGlyph, { className: "h-3.5 w-3.5 shrink-0" }),
              /* @__PURE__ */ jsx13("span", { className: "hidden md:inline", children: labels.splitClip })
            ] }),
            /* @__PURE__ */ jsxs10("button", { type: "button", "aria-label": labels.addCaptionAriaLabel, onClick: addCaptionAtPlayhead, className: EDIT_TOOL_BUTTON, children: [
              /* @__PURE__ */ jsx13(CaptionPlusGlyph, { className: "h-3.5 w-3.5 shrink-0" }),
              /* @__PURE__ */ jsx13("span", { className: "hidden md:inline", children: labels.addCaption })
            ] })
          ] }) : null,
          /* @__PURE__ */ jsx13("div", { className: "min-w-2 flex-1" }),
          /* @__PURE__ */ jsx13(ZoomControl, { zoomMath, zoom, onZoomChange: setZoom, fitZoom }),
          props.onCreateExport ? /* @__PURE__ */ jsxs10(Fragment3, { children: [
            /* @__PURE__ */ jsx13("div", { className: CLUSTER_DIVIDER }),
            /* @__PURE__ */ jsxs10(
              "button",
              {
                type: "button",
                "aria-label": labels.createExport,
                onClick: props.onCreateExport,
                className: "flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-[var(--brand-primary)] px-2.5 text-xs font-semibold text-[var(--brand-primary)] transition hover:bg-[hsl(var(--primary)/0.1)]",
                children: [
                  /* @__PURE__ */ jsx13(ExportGlyph, { className: "h-3.5 w-3.5 shrink-0" }),
                  /* @__PURE__ */ jsx13("span", { className: "hidden md:inline", children: labels.createExport })
                ]
              }
            )
          ] }) : null
        ] }),
        commitError ? /* @__PURE__ */ jsxs10("div", { className: "flex shrink-0 items-center justify-between gap-3 border-b border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.1)] px-3 py-1.5 text-xs text-[var(--text-danger)]", role: "alert", children: [
          /* @__PURE__ */ jsx13("span", { className: "min-w-0 truncate", children: commitError }),
          /* @__PURE__ */ jsx13("button", { type: "button", onClick: () => setCommitError(null), className: "shrink-0 underline-offset-2 hover:underline", children: "Dismiss" })
        ] }) : null,
        props.renderAssetShelf ? /* @__PURE__ */ jsx13("div", { className: "shrink-0 border-b border-[var(--border-default)]", children: props.renderAssetShelf() }) : null,
        /* @__PURE__ */ jsx13(
          "div",
          {
            ref: trackViewportRef,
            "data-timeline-tracks": true,
            className: "relative max-h-60 min-h-[6rem] shrink-0 overflow-auto overscroll-x-contain",
            onDragOver: handleTrackAreaDragOver,
            onDrop: handleTrackAreaDrop,
            children: /* @__PURE__ */ jsxs10("div", { className: "relative", style: { width: `${TRACK_HEADER_PX + timelineWidth}px`, minWidth: "100%" }, children: [
              /* @__PURE__ */ jsxs10("div", { className: "sticky top-0 z-20 flex", children: [
                /* @__PURE__ */ jsx13("div", { className: "sticky left-0 z-30 w-36 shrink-0 border-b border-r border-[var(--border-default)] bg-[var(--bg-input)]" }),
                /* @__PURE__ */ jsx13(TimelineRuler, { fps, durationFrames: timeline.sequence.durationFrames, zoom, onScrub: (frame) => clock.seek(frame) })
              ] }),
              /* @__PURE__ */ jsxs10("div", { className: "relative", children: [
                sortedTracks.length === 0 ? /* @__PURE__ */ jsxs10(Fragment3, { children: [
                  /* @__PURE__ */ jsx13(
                    TimelineGhostLanes,
                    {
                      laneWidth: timelineWidth,
                      videoLabel: labels.ghostVideoLane,
                      captionLabel: labels.ghostCaptionLane
                    }
                  ),
                  /* @__PURE__ */ jsx13(
                    TimelineEmptyState,
                    {
                      labels: props.labels,
                      brandedExport: props.brandedExport,
                      ...props.onStartFromTemplate ? { onStartFromTemplate: props.onStartFromTemplate } : {},
                      ...props.onAddClip ? { onAddClip: props.onAddClip } : {},
                      ...props.onAskAgent ? { onAskAgent: props.onAskAgent } : {}
                    }
                  )
                ] }) : null,
                sortedTracks.map((track) => /* @__PURE__ */ jsx13(
                  TimelineTrackRow,
                  {
                    track,
                    clips: clipsByTrack.get(track.id) ?? [],
                    fps,
                    zoom,
                    sequenceDurationFrames: timeline.sequence.durationFrames,
                    selectedClipIds: new Set(selectedClipIds),
                    tabbableClipId,
                    canWrite,
                    frameProvider,
                    snapMove,
                    snapEdge,
                    onSnapPointChange: setActiveSnapPoint,
                    onSelectClip: selectClip,
                    onRequestDeleteClip: deleteClip,
                    onFocusStepClip: focusStepClip,
                    onCommitMove: handleCommitMove,
                    onCommitTrim: handleCommitTrim,
                    onCommitText: handleCommitText,
                    onLaneSeek: (frame) => clock.seek(frame)
                  },
                  track.id
                )),
                /* @__PURE__ */ jsxs10("div", { className: "pointer-events-none absolute inset-y-0", style: { left: `${TRACK_HEADER_PX}px`, width: `${timelineWidth}px` }, children: [
                  /* @__PURE__ */ jsx13(TimelinePlayhead, { frame: playheadFrame, zoom }),
                  /* @__PURE__ */ jsx13(SnapIndicatorLine, { point: activeSnapPoint, zoom })
                ] })
              ] })
            ] })
          }
        )
      ] }),
      props.renderSidePanel ? /* @__PURE__ */ jsx13("aside", { className: "flex max-h-72 shrink-0 flex-col overflow-hidden border-t border-[var(--border-default)] lg:max-h-none lg:w-80 lg:border-l lg:border-t-0", children: props.renderSidePanel({ selectedClips, playheadFrame }) }) : null
    ] })
  ] });
}
var TimelineEditor_default = TimelineEditor;

export {
  DEFAULT_TIMELINE_LABELS,
  COMMAND_HISTORY_LIMIT,
  createCommandStack,
  moveClipCommand,
  trimClipCommand,
  placeClipCommand,
  deleteClipCommand,
  splitClipCommand,
  addCaptionCommand,
  setClipTextCommand,
  toggleClipDisabledCommand,
  createZoomMath,
  frameToPixel,
  pixelToFrame,
  snapPixel,
  collectSnapPoints,
  applySnap,
  createPlaybackClock,
  DEFAULT_MAX_MEDIA_ELEMENTS,
  SEEK_TOLERANCE_SECONDS,
  SEEK_TIMEOUT_MS,
  containFitRect,
  needsSeek,
  createMediaElementPool,
  classifyMediaUrl,
  createImageFrameProvider,
  createVideoElementFrameProvider,
  computeWaveform,
  loadWaveform,
  drawWaveform,
  compositeCommand,
  framesFromPixelDelta,
  moveDragStartFrame,
  trimStartDrag,
  trimEndDrag,
  selectTickStepSeconds,
  letterboxRect,
  captionFontPx,
  clipChipGeometry,
  chooseMoveSnap,
  PreviewCanvas,
  SnapIndicatorLine,
  TimelinePlayhead,
  TimelineRuler,
  TimelineClipChip,
  TimelineTrackRow,
  BrandMark,
  TimelineEmptyState,
  TimelineGhostLanes,
  TimelineSmallScreenGate,
  ZoomControl,
  SEQUENCE_MEDIA_DRAG_TYPE,
  TimelineEditor,
  TimelineEditor_default
};
//# sourceMappingURL=chunk-ZGY6QB4F.js.map