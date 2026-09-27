import {
  MIN_SEQUENCE_CLIP_FRAMES,
  assertClipFitsSequence,
  chooseCaptionPlacement,
  clampClipDuration,
  clampClipStart,
  formatSeconds,
  formatTimecode,
  framesToSeconds,
  secondsToFrames,
  snapshotFrame,
  trackIntervals
} from "../chunk-BVKQKGRK.js";
import {
  MCP_PROTOCOL_VERSIONS,
  buildScopedMcpServerEntry,
  createMcpToolHandler
} from "../chunk-6A7MYOUI.js";
import {
  assertMediaUrl
} from "../chunk-EA4UVS4T.js";
import "../chunk-TXD5HXLE.js";

// src/sequences/operations.ts
var SEQUENCE_OPERATION_TYPES = [
  "place_clip",
  "add_caption",
  "move_clip",
  "trim_clip",
  "split_clip",
  "set_clip_text",
  "set_clip_disabled",
  "delete_clip",
  "create_track",
  "extend_sequence",
  "queue_export"
];

// src/sequences/validate.ts
var TRACK_KINDS = {
  video: true,
  audio: true,
  caption: true,
  reference: true,
  agent: true
};
var EXPORT_FORMATS = {
  mp4: true,
  otio: true,
  xml: true,
  edl: true,
  vtt: true,
  srt: true,
  contact_sheet: true
};
var MEDIA_KINDS = {
  video: true,
  image: true,
  audio: true
};
var LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;
function validateSequenceOperations(timeline, operations, ctx) {
  assertPlayheadFrame(ctx.playheadFrame);
  operations.forEach((operation, index) => {
    try {
      validateSequenceOperation(timeline, operation, ctx);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`operation ${index + 1} (${operation.type}): ${reason}`);
    }
  });
}
function validateSequenceOperation(timeline, operation, ctx) {
  switch (operation.type) {
    case "place_clip":
      return validatePlaceClip(timeline, operation);
    case "add_caption":
      return validateAddCaption(timeline, operation, ctx);
    case "move_clip":
      return validateMoveClip(timeline, operation);
    case "trim_clip":
      return validateTrimClip(timeline, operation);
    case "split_clip":
      return validateSplitClip(timeline, operation);
    case "set_clip_text":
      return validateSetClipText(timeline, operation);
    case "set_clip_disabled":
      return validateSetClipDisabled(timeline, operation);
    case "delete_clip":
      return validateDeleteClip(timeline, operation);
    case "create_track":
      return validateCreateTrack(operation);
    case "extend_sequence":
      return validateExtendSequence(timeline, operation);
    case "queue_export":
      return validateQueueExport(operation);
    default: {
      const unknown = operation;
      throw new Error(`unsupported operation type ${JSON.stringify(unknown.type)}`);
    }
  }
}
function validatePlaceClip(timeline, operation) {
  if (operation.label.trim().length === 0) throw new Error("label must be non-empty");
  if (operation.media) {
    if (!(operation.media.kind in MEDIA_KINDS)) {
      throw new Error(`unsupported media kind ${JSON.stringify(operation.media.kind)}`);
    }
    assertSequenceMediaUrl(operation.media.url);
  }
  if (operation.sourceInFrame !== void 0) assertSourceInFrame(operation.sourceInFrame);
  if (operation.sourceOutFrame !== void 0) {
    assertSourceWindow(operation.sourceInFrame ?? 0, operation.sourceOutFrame, operation.durationFrames);
  }
  assertOperationBounds(timeline, { startFrame: operation.startFrame, durationFrames: operation.durationFrames });
  resolvePlaceClipTrack(timeline, operation);
}
function validateAddCaption(timeline, operation, ctx) {
  if (operation.text.trim().length === 0) throw new Error("text must be non-empty");
  if (operation.language !== void 0) assertLanguageTag(operation.language);
  const target = resolveCaptionTarget(timeline, operation);
  const placement = resolveCaptionPlacement(
    timeline,
    operation,
    ctx,
    target.kind === "existing" ? target.track.id : null
  );
  if (operation.startFrame !== void 0 || operation.durationFrames !== void 0) {
    assertOperationBounds(timeline, placement);
  }
}
function validateMoveClip(timeline, operation) {
  const { clip, track } = requireMutableClip(timeline, operation.clipId);
  assertOperationBounds(timeline, { startFrame: operation.startFrame, durationFrames: clip.durationFrames });
  if (operation.trackId !== void 0) {
    const destination = requireTrack(timeline, operation.trackId);
    assertUnlocked(destination);
    if (destination.kind !== track.kind) {
      throw new Error(`moves a ${track.kind} clip to a ${destination.kind} track (${destination.id})`);
    }
  }
}
function validateTrimClip(timeline, operation) {
  const { clip } = requireMutableClip(timeline, operation.clipId);
  if (operation.sourceInFrame !== void 0) assertSourceInFrame(operation.sourceInFrame);
  assertOperationBounds(timeline, { startFrame: operation.startFrame, durationFrames: operation.durationFrames });
  const sourceInFrame = operation.sourceInFrame ?? clip.sourceInFrame;
  const sourceOutFrame = operation.sourceOutFrame === void 0 ? clip.sourceOutFrame : operation.sourceOutFrame;
  assertSourceWindow(sourceInFrame, sourceOutFrame, operation.durationFrames);
}
function validateSplitClip(timeline, operation) {
  const { clip } = requireMutableClip(timeline, operation.clipId);
  if (!Number.isInteger(operation.atFrame)) throw new Error("atFrame must be an integer");
  if (clip.durationFrames < 2) {
    throw new Error(`clip ${clip.id} is ${clip.durationFrames} frame(s) long; splitting needs at least 2 frames`);
  }
  const endFrame = clip.startFrame + clip.durationFrames;
  if (operation.atFrame <= clip.startFrame || operation.atFrame >= endFrame) {
    throw new Error(
      `atFrame ${operation.atFrame} must fall strictly inside clip ${clip.id} (valid range ${clip.startFrame + 1}..${endFrame - 1})`
    );
  }
}
function validateSetClipText(timeline, operation) {
  const { track } = requireMutableClip(timeline, operation.clipId);
  if (track.kind !== "caption") {
    throw new Error(`targets a clip on a ${track.kind} track; text edits apply only to caption clips`);
  }
  if (operation.text.trim().length === 0) {
    throw new Error("text must be non-empty; use delete_clip to remove a caption");
  }
  if (operation.language !== void 0) assertLanguageTag(operation.language);
}
function validateSetClipDisabled(timeline, operation) {
  requireMutableClip(timeline, operation.clipId);
}
function validateDeleteClip(timeline, operation) {
  requireMutableClip(timeline, operation.clipId);
}
function validateCreateTrack(operation) {
  if (!(operation.kind in TRACK_KINDS)) throw new Error(`unsupported track kind ${JSON.stringify(operation.kind)}`);
  if (operation.name.trim().length === 0) throw new Error("name must be non-empty");
}
function validateExtendSequence(timeline, operation) {
  if (!Number.isInteger(operation.durationFrames) || operation.durationFrames <= 0) {
    throw new Error("durationFrames must be a positive integer");
  }
  const lastEnd = lastClipEndFrame(timeline);
  if (operation.durationFrames < lastEnd) {
    throw new Error(`durationFrames ${operation.durationFrames} is below the last clip end (frame ${lastEnd})`);
  }
}
function validateQueueExport(operation) {
  if (!(operation.format in EXPORT_FORMATS)) {
    throw new Error(`unsupported export format ${JSON.stringify(operation.format)}`);
  }
}
function parseSequenceOperations(input) {
  if (!Array.isArray(input)) throw new Error("operations must be an array of sequence operations");
  if (input.length === 0) throw new Error("operations must contain at least one operation");
  return input.map((raw, index) => {
    try {
      return parseSequenceOperation(raw);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`operations[${index}]: ${reason}`);
    }
  });
}
function parseSequenceOperation(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("each operation must be an object with a type field");
  }
  const record = raw;
  const type = record.type;
  if (typeof type !== "string" || !SEQUENCE_OPERATION_TYPES.includes(type)) {
    throw new Error(`type must be one of: ${SEQUENCE_OPERATION_TYPES.join(", ")} (got ${JSON.stringify(type)})`);
  }
  switch (type) {
    case "place_clip":
      return {
        type: "place_clip",
        label: readString(record, "label"),
        startFrame: readInt(record, "startFrame"),
        durationFrames: readInt(record, "durationFrames"),
        ...readOptional(record, "trackId", readString),
        ...readOptional(record, "sourceInFrame", readInt),
        ...readOptionalNullable(record, "sourceOutFrame", readInt),
        ...readOptional(record, "disabled", readBool),
        ...readOptional(record, "media", readMedia),
        ...readOptional(record, "generationId", readString),
        ...readOptional(record, "assetId", readString),
        ...readOptional(record, "metadata", readRecord)
      };
    case "add_caption":
      return {
        type: "add_caption",
        text: readString(record, "text"),
        ...readOptional(record, "language", readString),
        ...readOptional(record, "startFrame", readInt),
        ...readOptional(record, "durationFrames", readInt),
        ...readOptional(record, "trackId", readString)
      };
    case "move_clip":
      return {
        type: "move_clip",
        clipId: readString(record, "clipId"),
        startFrame: readInt(record, "startFrame"),
        ...readOptional(record, "trackId", readString)
      };
    case "trim_clip":
      return {
        type: "trim_clip",
        clipId: readString(record, "clipId"),
        startFrame: readInt(record, "startFrame"),
        durationFrames: readInt(record, "durationFrames"),
        ...readOptional(record, "sourceInFrame", readInt),
        ...readOptionalNullable(record, "sourceOutFrame", readInt)
      };
    case "split_clip":
      return {
        type: "split_clip",
        clipId: readString(record, "clipId"),
        atFrame: readInt(record, "atFrame")
      };
    case "set_clip_text":
      return {
        type: "set_clip_text",
        clipId: readString(record, "clipId"),
        text: readString(record, "text"),
        ...readOptional(record, "language", readString)
      };
    case "set_clip_disabled":
      return {
        type: "set_clip_disabled",
        clipId: readString(record, "clipId"),
        disabled: readBool(record, "disabled")
      };
    case "delete_clip":
      return { type: "delete_clip", clipId: readString(record, "clipId") };
    case "create_track": {
      const kind = readString(record, "kind");
      if (!(kind in TRACK_KINDS)) throw new Error(`kind must be one of: ${Object.keys(TRACK_KINDS).join(", ")}`);
      return { type: "create_track", kind, name: readString(record, "name") };
    }
    case "extend_sequence":
      return { type: "extend_sequence", durationFrames: readInt(record, "durationFrames") };
    case "queue_export": {
      const format = readString(record, "format");
      if (!(format in EXPORT_FORMATS)) throw new Error(`format must be one of: ${Object.keys(EXPORT_FORMATS).join(", ")}`);
      return { type: "queue_export", format, ...readOptional(record, "metadata", readRecord) };
    }
  }
}
function readString(record, name) {
  const value = record[name];
  if (typeof value !== "string") throw new Error(`${name} must be a string (got ${describeJsonValue(value)})`);
  return value;
}
function readInt(record, name) {
  const value = record[name];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer frame count (got ${describeJsonValue(value)})`);
  }
  return value;
}
function readBool(record, name) {
  const value = record[name];
  if (typeof value !== "boolean") throw new Error(`${name} must be true or false (got ${describeJsonValue(value)})`);
  return value;
}
function readRecord(record, name) {
  const value = record[name];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object (got ${describeJsonValue(value)})`);
  }
  return value;
}
function readMedia(record, name) {
  const media = readRecord(record, name);
  const url = readString(media, "url");
  const kind = readString(media, "kind");
  if (!(kind in MEDIA_KINDS)) throw new Error(`${name}.kind must be one of: ${Object.keys(MEDIA_KINDS).join(", ")}`);
  return { url, kind };
}
function readOptional(record, name, reader) {
  if (record[name] === void 0) return {};
  return { [name]: reader(record, name) };
}
function readOptionalNullable(record, name, reader) {
  if (record[name] === void 0) return {};
  if (record[name] === null) return { [name]: null };
  return { [name]: reader(record, name) };
}
function describeJsonValue(value) {
  if (value === void 0) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `${typeof value} ${JSON.stringify(value)}`;
}
function captionTrackNameForLanguage(language) {
  return `Captions (${language})`;
}
function resolvePlaceClipTrack(timeline, operation) {
  const media = operation.media;
  if (operation.trackId !== void 0) {
    const track2 = requireTrack(timeline, operation.trackId);
    assertUnlocked(track2);
    if (track2.kind === "caption") {
      throw new Error(`cannot target caption track ${track2.id}; use add_caption for caption content`);
    }
    if (media) {
      const primary = media.kind === "audio" ? "audio" : "video";
      if (track2.kind !== primary && track2.kind !== "reference") {
        throw new Error(`media kind ${media.kind} requires a ${primary} or reference track; track ${track2.id} is ${track2.kind}`);
      }
    }
    return track2;
  }
  if (!media) throw new Error("requires trackId when media is omitted \u2014 the target track kind cannot be inferred");
  const wanted = media.kind === "audio" ? "audio" : "video";
  const track = tracksBySortOrder(timeline).find((candidate) => candidate.kind === wanted && !candidate.locked);
  if (!track) throw new Error(`requires an unlocked ${wanted} track and the sequence has none`);
  return track;
}
function resolveCaptionTarget(timeline, operation) {
  if (operation.trackId !== void 0) {
    const track2 = requireTrack(timeline, operation.trackId);
    if (track2.kind !== "caption") {
      throw new Error(`targets ${track2.kind} track ${track2.id}; captions require a caption track`);
    }
    assertUnlocked(track2);
    return { kind: "existing", track: track2 };
  }
  const captionTracks = tracksBySortOrder(timeline).filter((track2) => track2.kind === "caption");
  if (operation.language !== void 0) {
    const language = operation.language;
    const matching = captionTracks.filter(
      (track2) => track2.metadata.language === language || track2.name === captionTrackNameForLanguage(language)
    );
    const unlocked = matching.find((track2) => !track2.locked);
    if (unlocked) return { kind: "existing", track: unlocked };
    if (matching.length > 0) throw new Error(`caption track for language "${language}" is locked`);
    return { kind: "create", language, name: captionTrackNameForLanguage(language) };
  }
  const track = captionTracks.find((candidate) => !candidate.locked);
  if (!track) {
    throw new Error("requires an unlocked caption track and the sequence has none; pass language to auto-create one or create_track first");
  }
  return { kind: "existing", track };
}
function resolveCaptionPlacement(timeline, operation, ctx, targetTrackId) {
  assertPlayheadFrame(ctx.playheadFrame);
  const fps = timeline.sequence.fps;
  if (operation.startFrame === void 0 && operation.durationFrames === void 0) {
    return chooseCaptionPlacement({
      playheadFrame: ctx.playheadFrame,
      fps,
      sequenceDurationFrames: timeline.sequence.durationFrames,
      occupiedIntervals: targetTrackId === null ? [] : trackIntervals(timeline, targetTrackId)
    });
  }
  return {
    startFrame: operation.startFrame ?? ctx.playheadFrame,
    durationFrames: operation.durationFrames ?? fps * 3
  };
}
function lastClipEndFrame(timeline) {
  return timeline.clips.reduce((max, clip) => Math.max(max, clip.startFrame + clip.durationFrames), 0);
}
function assertSequenceMediaUrl(url) {
  assertMediaUrl(url, "media url");
}
function requireClip(timeline, clipId) {
  const clip = timeline.clips.find((candidate) => candidate.id === clipId);
  if (!clip) throw new Error(`references unknown clip ${clipId}`);
  return clip;
}
function requireTrack(timeline, trackId) {
  const track = timeline.tracks.find((candidate) => candidate.id === trackId);
  if (!track) throw new Error(`references unknown track ${trackId}`);
  return track;
}
function requireMutableClip(timeline, clipId) {
  const clip = requireClip(timeline, clipId);
  const track = requireTrack(timeline, clip.trackId);
  if (track.locked) throw new Error(`clip ${clip.id} sits on locked track "${track.name}" (${track.id})`);
  return { clip, track };
}
function assertUnlocked(track) {
  if (track.locked) throw new Error(`targets locked track "${track.name}" (${track.id})`);
}
function assertOperationBounds(timeline, bounds) {
  assertClipFitsSequence({
    startFrame: bounds.startFrame,
    durationFrames: bounds.durationFrames,
    sequenceDurationFrames: timeline.sequence.durationFrames,
    // The label carries the numbers so the thrown message is actionable
    // without access to the original arguments.
    label: `clip [start=${bounds.startFrame} duration=${bounds.durationFrames}] in a ${timeline.sequence.durationFrames}-frame sequence:`
  });
}
function assertSourceInFrame(sourceInFrame) {
  if (!Number.isInteger(sourceInFrame) || sourceInFrame < 0) {
    throw new Error("sourceInFrame must be a non-negative integer");
  }
}
function assertSourceWindow(sourceInFrame, sourceOutFrame, durationFrames) {
  if (sourceOutFrame === null) return;
  if (!Number.isInteger(sourceOutFrame) || sourceOutFrame < 1) {
    throw new Error("sourceOutFrame must be a positive integer or null");
  }
  if (sourceOutFrame <= sourceInFrame) {
    throw new Error(`sourceOutFrame ${sourceOutFrame} must be greater than sourceInFrame ${sourceInFrame}`);
  }
  if (sourceInFrame + durationFrames > sourceOutFrame) {
    throw new Error(
      `needs ${durationFrames} source frames but the source window [${sourceInFrame}, ${sourceOutFrame}) holds ${sourceOutFrame - sourceInFrame} \u2014 shorten durationFrames, lower sourceInFrame, or pass sourceOutFrame (null releases it to the source's natural end)`
    );
  }
}
function assertLanguageTag(language) {
  if (!LANGUAGE_TAG.test(language)) {
    throw new Error(`language must be a BCP-47-style tag (got ${JSON.stringify(language)})`);
  }
}
function assertPlayheadFrame(playheadFrame) {
  if (!Number.isInteger(playheadFrame) || playheadFrame < 0) {
    throw new Error("playheadFrame must be a non-negative integer");
  }
}
function tracksBySortOrder(timeline) {
  return [...timeline.tracks].sort((a, b) => a.sortOrder - b.sortOrder);
}

// src/sequences/apply.ts
async function applySequenceOperations(store, operations, ctx) {
  if (operations.length === 0) throw new Error("operations must contain at least one operation");
  let timeline = await store.getTimeline();
  validateSequenceOperations(timeline, operations, ctx);
  const results = [];
  for (let index = 0; index < operations.length; index += 1) {
    if (index > 0) timeline = await store.getTimeline();
    results.push(await applySequenceOperation(store, timeline, operations[index], ctx));
  }
  return results;
}
async function applySequenceOperation(store, timeline, op, ctx) {
  validateSequenceOperation(timeline, op, ctx);
  switch (op.type) {
    case "place_clip":
      return applyPlaceClip(store, timeline, op);
    case "add_caption":
      return applyAddCaption(store, timeline, op, ctx);
    case "move_clip": {
      const patch = { startFrame: op.startFrame };
      if (op.trackId !== void 0) patch.trackId = op.trackId;
      return { kind: "clip", clip: await store.updateClip(op.clipId, patch) };
    }
    case "trim_clip": {
      const patch = { startFrame: op.startFrame, durationFrames: op.durationFrames };
      if (op.sourceInFrame !== void 0) patch.sourceInFrame = op.sourceInFrame;
      if (op.sourceOutFrame !== void 0) patch.sourceOutFrame = op.sourceOutFrame;
      return { kind: "clip", clip: await store.updateClip(op.clipId, patch) };
    }
    case "split_clip":
      return applySplitClip(store, timeline, op);
    case "set_clip_text": {
      const patch = { text: op.text, label: clipLabelFromText(op.text) };
      if (op.language !== void 0) patch.language = op.language;
      return { kind: "clip", clip: await store.updateClip(op.clipId, patch) };
    }
    case "set_clip_disabled":
      return { kind: "clip", clip: await store.updateClip(op.clipId, { disabled: op.disabled }) };
    case "delete_clip": {
      const snapshot = requireTimelineClip(timeline, op.clipId);
      await store.deleteClip(op.clipId);
      return { kind: "clip", clip: snapshot };
    }
    case "create_track":
      return { kind: "track", track: await store.createTrack({ kind: op.kind, name: op.name }) };
    case "extend_sequence":
      return { kind: "sequence", sequence: await store.updateSequenceDuration(op.durationFrames) };
    case "queue_export":
      return { kind: "export", record: await store.createExport(op.format, op.metadata) };
  }
}
async function applyPlaceClip(store, timeline, op) {
  const track = resolvePlaceClipTrack(timeline, op);
  const metadata = op.media ? { ...op.metadata ?? {}, media: { url: op.media.url, kind: op.media.kind } } : op.metadata;
  const clip = await store.createClip({
    trackId: track.id,
    label: op.label,
    startFrame: op.startFrame,
    durationFrames: op.durationFrames,
    sourceInFrame: op.sourceInFrame ?? 0,
    ...op.sourceOutFrame !== void 0 ? { sourceOutFrame: op.sourceOutFrame } : {},
    ...op.generationId !== void 0 ? { generationId: op.generationId } : {},
    ...op.assetId !== void 0 ? { assetId: op.assetId } : {},
    ...metadata !== void 0 ? { metadata } : {}
  });
  const final = op.disabled === true ? await store.updateClip(clip.id, { disabled: true }) : clip;
  return { kind: "clip", clip: final };
}
async function applyAddCaption(store, timeline, op, ctx) {
  const target = resolveCaptionTarget(timeline, op);
  const placement = resolveCaptionPlacement(timeline, op, ctx, target.kind === "existing" ? target.track.id : null);
  const track = target.kind === "existing" ? target.track : await store.createTrack({ kind: "caption", name: target.name });
  const clip = await store.createClip({
    trackId: track.id,
    label: clipLabelFromText(op.text),
    startFrame: placement.startFrame,
    durationFrames: placement.durationFrames,
    sourceInFrame: 0,
    text: op.text,
    ...op.language !== void 0 ? { language: op.language } : {}
  });
  return { kind: "clip", clip };
}
async function applySplitClip(store, timeline, op) {
  const original = { ...requireTimelineClip(timeline, op.clipId) };
  const offset = op.atFrame - original.startFrame;
  const second = await store.createClip({
    trackId: original.trackId,
    label: original.label,
    startFrame: op.atFrame,
    durationFrames: original.durationFrames - offset,
    sourceInFrame: original.sourceInFrame + offset,
    sourceOutFrame: original.sourceOutFrame,
    ...original.text !== void 0 ? { text: original.text } : {},
    ...original.language !== void 0 ? { language: original.language } : {},
    ...original.generationId !== void 0 ? { generationId: original.generationId } : {},
    ...original.assetId !== void 0 ? { assetId: original.assetId } : {},
    metadata: original.metadata
  });
  await store.updateClip(original.id, {
    durationFrames: offset,
    sourceOutFrame: original.sourceInFrame + offset
  });
  const secondFinal = original.disabled ? await store.updateClip(second.id, { disabled: true }) : second;
  return { kind: "clip", clip: secondFinal };
}
function requireTimelineClip(timeline, clipId) {
  const clip = timeline.clips.find((candidate) => candidate.id === clipId);
  if (!clip) throw new Error(`references unknown clip ${clipId}`);
  return clip;
}
function clipLabelFromText(text) {
  return text.length > 120 ? text.slice(0, 120) : text;
}

// src/sequences/exports.ts
function buildSrt(timeline, opts = {}) {
  const fps = timeline.sequence.fps;
  const cues = collectCaptionCues(timeline, opts.language);
  const blocks = cues.map((cue, index) => [
    String(index + 1),
    `${frameToSubtitleTime(cue.startFrame, fps, ",")} --> ${frameToSubtitleTime(cue.endFrame, fps, ",")}`,
    ...cue.lines
  ].join("\n"));
  return `${blocks.join("\n\n")}
`;
}
function buildVtt(timeline, opts = {}) {
  const fps = timeline.sequence.fps;
  const cues = collectCaptionCues(timeline, opts.language);
  const blocks = cues.map((cue, index) => [
    String(index + 1),
    `${frameToSubtitleTime(cue.startFrame, fps, ".")} --> ${frameToSubtitleTime(cue.endFrame, fps, ".")}`,
    ...cue.lines
  ].join("\n"));
  return `WEBVTT

${blocks.join("\n\n")}
`;
}
function collectCaptionCues(timeline, language) {
  const captionTracks = timeline.tracks.filter((track) => track.kind === "caption");
  const sortOrderByTrackId = new Map(captionTracks.map((track) => [track.id, track.sortOrder]));
  const wanted = language?.toLowerCase();
  const cues = timeline.clips.filter((clip) => sortOrderByTrackId.has(clip.trackId) && !clip.disabled && typeof clip.text === "string" && clip.text.trim().length > 0 && (wanted === void 0 || clip.language?.toLowerCase() === wanted)).map((clip) => ({
    startFrame: clip.startFrame,
    endFrame: clip.startFrame + clip.durationFrames,
    lines: captionLines(clip.text)
  })).sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame);
  if (cues.length === 0) {
    const scope = language === void 0 ? "" : ` in language '${language}'`;
    throw new Error(
      `sequence '${timeline.sequence.title}' has no caption clips with text${scope} \u2014 an empty subtitle file would fail silently; add captions${language === void 0 ? "" : " in that language"} first`
    );
  }
  return cues;
}
function captionLines(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}
function frameToSubtitleTime(frame, fps, separator) {
  const totalMs = Math.round(framesToSeconds(frame, fps) * 1e3);
  const ms = totalMs % 1e3;
  const totalSeconds = Math.floor(totalMs / 1e3);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}${separator}${String(ms).padStart(3, "0")}`;
}
function buildEdl(timeline) {
  const fps = timeline.sequence.fps;
  const events = clipsOnTracks(timeline, ["video", "audio"]);
  if (events.length === 0) {
    throw new Error(
      `sequence '${timeline.sequence.title}' has no enabled video or audio clips \u2014 an empty EDL would fail silently in the NLE`
    );
  }
  const lines = [`TITLE: ${timeline.sequence.title}`, "FCM: NON-DROP FRAME", ""];
  events.forEach(({ track, clip }, index) => {
    const channel = track.kind === "video" ? "V" : "A";
    const sourceIn = frameToEdlTimecode(clip.sourceInFrame, fps);
    const sourceOut = frameToEdlTimecode(clip.sourceInFrame + clip.durationFrames, fps);
    const recordIn = frameToEdlTimecode(clip.startFrame, fps);
    const recordOut = frameToEdlTimecode(clip.startFrame + clip.durationFrames, fps);
    lines.push(`${String(index + 1).padStart(3, "0")}  AX       ${channel}     C        ${sourceIn} ${sourceOut} ${recordIn} ${recordOut}`);
    lines.push(`* FROM CLIP NAME: ${clip.label}`);
    if (clip.media) lines.push(`* SOURCE FILE: ${clip.media.url}`);
    lines.push("");
  });
  return lines.join("\n");
}
function frameToEdlTimecode(frame, fps) {
  if (!Number.isInteger(frame) || frame < 0) throw new Error("frames must be a non-negative integer");
  const frameWidth = Math.max(2, String(fps - 1).length);
  const totalSeconds = Math.floor(frame / fps);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}:${String(frame % fps).padStart(frameWidth, "0")}`;
}
function buildOtio(timeline) {
  const fps = timeline.sequence.fps;
  const tracks = [...timeline.tracks].sort((a, b) => a.sortOrder - b.sortOrder).filter((track) => track.kind !== "agent");
  return {
    OTIO_SCHEMA: "Timeline.1",
    name: timeline.sequence.title,
    global_start_time: rationalTime(0, fps),
    metadata: {
      ...timeline.sequence.metadata,
      sequenceId: timeline.sequence.id,
      fps,
      width: timeline.sequence.width,
      height: timeline.sequence.height,
      aspectRatio: timeline.sequence.aspectRatio,
      durationFrames: timeline.sequence.durationFrames
    },
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "tracks",
      children: tracks.map((track) => otioTrack(timeline, track, fps))
    }
  };
}
function otioTrack(timeline, track, fps) {
  const clips = timeline.clips.filter((clip) => clip.trackId === track.id && !clip.disabled).sort((a, b) => a.startFrame - b.startFrame);
  const children = [];
  let cursorFrame = 0;
  for (const clip of clips) {
    if (clip.startFrame < cursorFrame) {
      throw new Error(
        `clip '${clip.label}' (${clip.id}) overlaps the previous clip on track '${track.name}' \u2014 OTIO tracks are sequential; move or trim the clip before exporting`
      );
    }
    if (clip.startFrame > cursorFrame) {
      children.push({
        OTIO_SCHEMA: "Gap.1",
        name: "",
        source_range: timeRange(0, clip.startFrame - cursorFrame, fps)
      });
    }
    children.push(otioClip(clip, fps));
    cursorFrame = clip.startFrame + clip.durationFrames;
  }
  return {
    OTIO_SCHEMA: "Track.1",
    name: track.name,
    kind: otioTrackKind(track.kind),
    metadata: { ...track.metadata, sequenceTrackKind: track.kind },
    children
  };
}
function otioClip(clip, fps) {
  const metadata = { ...clip.metadata };
  if (clip.text !== void 0) metadata.text = clip.text;
  if (clip.language !== void 0) metadata.language = clip.language;
  if (clip.generationId !== void 0) metadata.generationId = clip.generationId;
  if (clip.assetId !== void 0) metadata.assetId = clip.assetId;
  return {
    OTIO_SCHEMA: "Clip.2",
    name: clip.label,
    source_range: timeRange(clip.sourceInFrame, clip.durationFrames, fps),
    media_reference: clip.media === void 0 ? { OTIO_SCHEMA: "MissingReference.1" } : {
      OTIO_SCHEMA: "ExternalReference.1",
      target_url: clip.media.url,
      available_range: clip.media.durationSeconds === void 0 ? null : timeRange(0, secondsToFrames(clip.media.durationSeconds, fps), fps)
    },
    metadata
  };
}
function otioTrackKind(kind) {
  if (kind === "agent") throw new Error("agent tracks are excluded from OTIO export");
  return kind === "audio" ? "Audio" : "Video";
}
function rationalTime(value, rate) {
  return { OTIO_SCHEMA: "RationalTime.1", rate, value };
}
function timeRange(startValue, durationValue, rate) {
  return {
    OTIO_SCHEMA: "TimeRange.1",
    start_time: rationalTime(startValue, rate),
    duration: rationalTime(durationValue, rate)
  };
}
function buildContactSheetManifest(timeline) {
  const fps = timeline.sequence.fps;
  const entries = clipsOnTracks(timeline, ["video"]).flatMap(({ clip }) => {
    const media = clip.media;
    if (media === void 0) return [];
    if (media.providerStatus !== void 0 && media.providerStatus !== "completed") return [];
    if (media.kind === "audio") return [];
    const midpointOffset = Math.floor(clip.durationFrames / 2);
    const frame = clip.startFrame + midpointOffset;
    const sourceFrame = media.kind === "image" ? 0 : clip.sourceInFrame + midpointOffset;
    return [{
      clipId: clip.id,
      trackId: clip.trackId,
      label: clip.label,
      frame,
      timecode: formatTimecode(frame, fps),
      sourceFrame,
      sourceSeconds: framesToSeconds(sourceFrame, fps),
      url: media.url,
      mediaKind: media.kind
    }];
  });
  if (entries.length === 0) {
    throw new Error(
      `sequence '${timeline.sequence.title}' has no sampleable video clips (enabled, media resolved and completed) \u2014 a contact sheet would be empty`
    );
  }
  return {
    sequenceId: timeline.sequence.id,
    title: timeline.sequence.title,
    fps,
    width: timeline.sequence.width,
    height: timeline.sequence.height,
    entries
  };
}
function clipsOnTracks(timeline, kinds) {
  const trackById = new Map(
    timeline.tracks.filter((track) => kinds.includes(track.kind)).map((track) => [track.id, track])
  );
  return timeline.clips.filter((clip) => !clip.disabled && trackById.has(clip.trackId)).map((clip) => ({ track: trackById.get(clip.trackId), clip })).sort((a, b) => a.clip.startFrame - b.clip.startFrame || a.track.sortOrder - b.track.sortOrder || a.clip.id.localeCompare(b.clip.id));
}
function pad2(value) {
  return String(value).padStart(2, "0");
}

// src/sequences/captions.ts
var DEFAULT_MAX_WORDS_PER_CHUNK = 8;
var DEFAULT_MIN_DURATION_SECONDS = 0.8;
function buildCaptionChunks(segments, opts) {
  const maxWordsPerChunk = opts.maxWordsPerChunk ?? DEFAULT_MAX_WORDS_PER_CHUNK;
  const minDurationSeconds = opts.minDurationSeconds ?? DEFAULT_MIN_DURATION_SECONDS;
  if (!Number.isInteger(maxWordsPerChunk) || maxWordsPerChunk < 1) {
    throw new Error("maxWordsPerChunk must be a positive integer");
  }
  if (!Number.isFinite(minDurationSeconds) || minDurationSeconds < 0) {
    throw new Error("minDurationSeconds must be a non-negative finite number");
  }
  segments.forEach((segment, index) => {
    if (!Number.isFinite(segment.startSeconds) || segment.startSeconds < 0) {
      throw new Error(`segment ${index} startSeconds must be a non-negative finite number`);
    }
    if (!Number.isFinite(segment.endSeconds) || segment.endSeconds < segment.startSeconds) {
      throw new Error(`segment ${index} endSeconds must be a finite number >= startSeconds`);
    }
  });
  const minDurationFrames = Math.max(secondsToFrames(minDurationSeconds, opts.fps), MIN_SEQUENCE_CLIP_FRAMES);
  const ordered = [...segments].sort((a, b) => a.startSeconds - b.startSeconds);
  const chunks = [];
  let cursorFrame = 0;
  for (const segment of ordered) {
    const words = segment.text.trim().split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0) continue;
    const segmentDurationSeconds = segment.endSeconds - segment.startSeconds;
    const chunkCount = Math.ceil(words.length / maxWordsPerChunk);
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const wordStart = chunkIndex * maxWordsPerChunk;
      const wordEnd = Math.min(wordStart + maxWordsPerChunk, words.length);
      const naturalStartFrame = secondsToFrames(
        segment.startSeconds + wordStart / words.length * segmentDurationSeconds,
        opts.fps
      );
      const naturalEndFrame = secondsToFrames(
        segment.startSeconds + wordEnd / words.length * segmentDurationSeconds,
        opts.fps
      );
      const startFrame = Math.max(naturalStartFrame, cursorFrame);
      const durationFrames = Math.max(naturalEndFrame - startFrame, minDurationFrames);
      chunks.push({
        text: words.slice(wordStart, wordEnd).join(" "),
        startFrame,
        durationFrames
      });
      cursorFrame = startFrame + durationFrames;
    }
  }
  return chunks;
}
var LANGUAGE_TAG_SHAPE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
function normalizeLanguageTag(tag) {
  const trimmed = tag.trim();
  if (trimmed.length === 0) throw new Error("language tag must be a non-empty string");
  const normalized = trimmed.split("-").map((subtag, index) => {
    const lower = subtag.toLowerCase();
    if (index === 0) return lower;
    if (subtag.length === 4 && /^[a-z]+$/.test(lower)) return lower.charAt(0).toUpperCase() + lower.slice(1);
    if (subtag.length === 2 && /^[a-z]+$/.test(lower)) return lower.toUpperCase();
    return lower;
  }).join("-");
  if (!LANGUAGE_TAG_SHAPE.test(normalized)) {
    throw new Error(`invalid BCP-47 language tag '${tag}' \u2014 expected a shape like 'en', 'pt-BR', or 'zh-Hans'`);
  }
  return normalized;
}
function planLanguageFanout(opts) {
  if (opts.languages.length === 0) {
    throw new Error("languages must contain at least one BCP-47 tag");
  }
  const source = opts.sourceLanguage === void 0 ? null : normalizeLanguageTag(opts.sourceLanguage);
  const seen = /* @__PURE__ */ new Set();
  const planned = [];
  for (const raw of opts.languages) {
    const tag = normalizeLanguageTag(raw);
    if (tag === source || seen.has(tag)) continue;
    seen.add(tag);
    planned.push(tag);
  }
  return planned;
}
function captionCoverage(timeline) {
  const totalFrames = timeline.sequence.durationFrames;
  if (!Number.isInteger(totalFrames) || totalFrames < 1) {
    throw new Error("sequence durationFrames must be a positive integer");
  }
  const captionTrackIds = new Set(
    timeline.tracks.filter((track) => track.kind === "caption").map((track) => track.id)
  );
  const intervalsByLanguage = /* @__PURE__ */ new Map();
  for (const clip of timeline.clips) {
    if (!captionTrackIds.has(clip.trackId) || clip.disabled) continue;
    if (typeof clip.text !== "string" || clip.text.length === 0) continue;
    const startFrame = Math.max(0, clip.startFrame);
    const endFrame = Math.min(totalFrames, clip.startFrame + clip.durationFrames);
    if (endFrame <= startFrame) continue;
    const language = clip.language ?? null;
    const intervals = intervalsByLanguage.get(language);
    if (intervals) intervals.push({ startFrame, endFrame });
    else intervalsByLanguage.set(language, [{ startFrame, endFrame }]);
  }
  const entries = [];
  for (const [language, intervals] of intervalsByLanguage) {
    const merged = mergeIntervals(intervals);
    const coveredFrames = merged.reduce((sum, interval) => sum + (interval.endFrame - interval.startFrame), 0);
    entries.push({ language, coveredFrames, totalFrames, gaps: complementIntervals(merged, totalFrames) });
  }
  entries.sort((a, b) => {
    if (a.language === null) return b.language === null ? 0 : -1;
    if (b.language === null) return 1;
    return a.language < b.language ? -1 : a.language > b.language ? 1 : 0;
  });
  return entries;
}
function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.startFrame - b.startFrame);
  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.startFrame <= last.endFrame) {
      last.endFrame = Math.max(last.endFrame, interval.endFrame);
    } else {
      merged.push({ startFrame: interval.startFrame, endFrame: interval.endFrame });
    }
  }
  return merged;
}
function complementIntervals(merged, totalFrames) {
  const gaps = [];
  let cursor = 0;
  for (const interval of merged) {
    if (interval.startFrame > cursor) gaps.push({ startFrame: cursor, endFrame: interval.startFrame });
    cursor = Math.max(cursor, interval.endFrame);
  }
  if (cursor < totalFrames) gaps.push({ startFrame: cursor, endFrame: totalFrames });
  return gaps;
}

// src/sequences/mcp-tools.ts
var SEQUENCE_EXPORT_FORMATS = ["mp4", "otio", "xml", "edl", "vtt", "srt", "contact_sheet"];
var SEQUENCE_TRACK_KINDS = ["video", "audio", "caption", "reference", "agent"];
var SEQUENCE_MEDIA_KINDS = ["video", "image", "audio"];
var MAX_CAPTION_BATCH = 500;
var MAX_INSTRUCTION_ARG_CHARS = 400;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireString(args, name) {
  const value = args[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required and must be a non-empty string`);
  }
  return value;
}
function optionalString(args, name) {
  const value = args[name];
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string when provided`);
  }
  return value;
}
function requireSeconds(args, name) {
  const value = args[name];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} is required and must be a non-negative number of seconds`);
  }
  return value;
}
function optionalSeconds(args, name) {
  if (args[name] === void 0 || args[name] === null) return void 0;
  return requireSeconds(args, name);
}
function requireBoolean(args, name) {
  const value = args[name];
  if (typeof value !== "boolean") throw new Error(`${name} is required and must be true or false`);
  return value;
}
function optionalPositiveInteger(args, name, max) {
  const value = args[name];
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}
function requireEnum(args, name, values) {
  const value = args[name];
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${name} must be one of: ${values.join(", ")}`);
  }
  return value;
}
function optionalEnum(args, name, values) {
  if (args[name] === void 0 || args[name] === null) return void 0;
  return requireEnum(args, name, values);
}
function durationArgToFrames(seconds, name, fps) {
  const frames = secondsToFrames(seconds, fps);
  if (frames < MIN_SEQUENCE_CLIP_FRAMES) {
    throw new Error(`${name} (${formatSeconds(seconds)}) is shorter than ${MIN_SEQUENCE_CLIP_FRAMES} frame at ${fps} fps \u2014 minimum is ${formatSeconds(MIN_SEQUENCE_CLIP_FRAMES / fps)}`);
  }
  return frames;
}
function boundsArgsToFrames(startSeconds, durationSeconds, durationName, fps) {
  const startFrame = secondsToFrames(startSeconds, fps);
  const durationFrames = secondsToFrames(startSeconds + durationSeconds, fps) - startFrame;
  if (durationFrames < MIN_SEQUENCE_CLIP_FRAMES) {
    throw new Error(`${durationName} (${formatSeconds(durationSeconds)}) spans fewer than ${MIN_SEQUENCE_CLIP_FRAMES} frame at ${fps} fps \u2014 minimum is ${formatSeconds(MIN_SEQUENCE_CLIP_FRAMES / fps)}`);
  }
  return { startFrame, durationFrames };
}
function displayedFrameAt(seconds, fps) {
  return Math.floor(seconds * fps + 1e-6);
}
function clipView(clip, fps) {
  const endFrame = clip.startFrame + clip.durationFrames;
  return {
    id: clip.id,
    track_id: clip.trackId,
    label: clip.label,
    start_seconds: framesToSeconds(clip.startFrame, fps),
    duration_seconds: framesToSeconds(clip.durationFrames, fps),
    end_seconds: framesToSeconds(endFrame, fps),
    start_timecode: formatTimecode(clip.startFrame, fps),
    end_timecode: formatTimecode(endFrame, fps),
    start_frame: clip.startFrame,
    duration_frames: clip.durationFrames,
    source_in_frame: clip.sourceInFrame,
    source_out_frame: clip.sourceOutFrame,
    disabled: clip.disabled,
    ...clip.text !== void 0 ? { text: clip.text } : {},
    ...clip.language !== void 0 ? { language: clip.language } : {},
    ...clip.generationId !== void 0 ? { generation_id: clip.generationId } : {},
    ...clip.assetId !== void 0 ? { asset_id: clip.assetId } : {},
    ...clip.media ? {
      media: {
        url: clip.media.url,
        kind: clip.media.kind,
        ...clip.media.durationSeconds !== void 0 ? { duration_seconds: clip.media.durationSeconds } : {},
        ...clip.media.providerStatus !== void 0 ? { provider_status: clip.media.providerStatus } : {}
      }
    } : {}
  };
}
function trackView(track) {
  return {
    id: track.id,
    kind: track.kind,
    name: track.name,
    sort_order: track.sortOrder,
    locked: track.locked,
    muted: track.muted
  };
}
function sequenceView(sequence) {
  return {
    id: sequence.id,
    title: sequence.title,
    fps: sequence.fps,
    width: sequence.width,
    height: sequence.height,
    aspect_ratio: sequence.aspectRatio,
    status: sequence.status,
    duration_frames: sequence.durationFrames,
    duration_seconds: framesToSeconds(sequence.durationFrames, sequence.fps),
    duration_timecode: formatTimecode(sequence.durationFrames, sequence.fps)
  };
}
function exportView(record) {
  return {
    id: record.id,
    format: record.format,
    status: record.status,
    result_url: record.resultUrl,
    created_at: record.createdAt.toISOString()
  };
}
function decisionView(decision) {
  return {
    id: decision.id,
    clip_id: decision.clipId,
    kind: decision.kind,
    instruction: decision.instruction,
    reasoning_summary: decision.reasoningSummary,
    accepted: decision.accepted,
    created_at: decision.createdAt.toISOString()
  };
}
function timelineView(timeline, playheadFrame) {
  const fps = timeline.sequence.fps;
  return {
    sequence: sequenceView(timeline.sequence),
    playhead: {
      frame: playheadFrame,
      seconds: framesToSeconds(playheadFrame, fps),
      timecode: formatTimecode(playheadFrame, fps)
    },
    tracks: [...timeline.tracks].sort((a, b) => a.sortOrder - b.sortOrder).map(trackView),
    clips: [...timeline.clips].sort((a, b) => a.startFrame - b.startFrame).map((clip) => clipView(clip, fps))
  };
}
function applyResultView(result, fps) {
  switch (result.kind) {
    case "clip":
      return { kind: "clip", clip: clipView(result.clip, fps) };
    case "track":
      return { kind: "track", track: trackView(result.track) };
    case "export":
      return { kind: "export", export: exportView(result.record) };
    case "sequence":
      return { kind: "sequence", sequence: sequenceView(result.sequence) };
  }
}
function instructionSummary(toolName, args) {
  const body = JSON.stringify(args);
  const clipped = body.length > MAX_INSTRUCTION_ARG_CHARS ? `${body.slice(0, MAX_INSTRUCTION_ARG_CHARS - 3)}...` : body;
  return `${toolName} ${clipped}`;
}
async function runMutation(toolName, args, env, build) {
  const timeline = await env.store.getTimeline();
  const fps = timeline.sequence.fps;
  const { operations, clipId } = build(timeline);
  const context = { playheadFrame: env.playheadFrame };
  const results = await applySequenceOperations(env.store, operations, context);
  const decision = await env.store.recordDecision({
    clipId: clipId ?? null,
    kind: "agent_edit",
    instruction: instructionSummary(toolName, args),
    metadata: { tool: toolName, operation_count: operations.length }
  });
  return {
    changed: results.map((result) => applyResultView(result, fps)),
    decision_id: decision.id
  };
}
function secondsSchema(description) {
  return { type: "number", minimum: 0, description };
}
function objectSchema(properties, required) {
  return { type: "object", properties, required, additionalProperties: false };
}
var CLIP_ID_SCHEMA = { type: "string", description: "Clip id from get_timeline_state or get_clip" };
var SEQUENCE_MCP_TOOLS = [
  {
    name: "get_timeline_state",
    description: "Read the full timeline: sequence settings (fps, duration), playhead, all tracks, and all clips with positions in seconds and m:ss.ff timecodes plus media URLs and provider status. Call this before editing to get real clip and track ids.",
    inputSchema: objectSchema({}, []),
    run: async (_args, env) => {
      const timeline = await env.store.getTimeline();
      return timelineView(timeline, env.playheadFrame);
    }
  },
  {
    name: "get_frame_at_time",
    description: "What is on screen and audible at one moment. seconds is sequence time (e.g. 12.5). Returns the active clips, visible caption text, and a one-line human-readable summary.",
    inputSchema: objectSchema({ seconds: secondsSchema("Sequence time in seconds") }, ["seconds"]),
    run: async (args, env) => {
      const timeline = await env.store.getTimeline();
      const fps = timeline.sequence.fps;
      const frame = displayedFrameAt(requireSeconds(args, "seconds"), fps);
      const snapshot = snapshotFrame(timeline, frame);
      const activeParts = snapshot.active.map(({ track, clip }) => {
        const range = `${formatTimecode(clip.startFrame, fps)}-${formatTimecode(clip.startFrame + clip.durationFrames, fps)}`;
        return `${track.kind} "${clip.label}" (${range})`;
      });
      const captionParts = snapshot.captions.map((caption) => `"${caption.text}"`);
      const summary = `At ${formatTimecode(frame, fps)} (${formatSeconds(snapshot.seconds)}): ` + (activeParts.length > 0 ? activeParts.join("; ") : "nothing active") + (captionParts.length > 0 ? `. Captions: ${captionParts.join(", ")}` : "");
      return {
        frame: snapshot.frame,
        seconds: snapshot.seconds,
        timecode: formatTimecode(frame, fps),
        summary,
        active: snapshot.active.map(({ track, clip }) => ({ track: trackView(track), clip: clipView(clip, fps) })),
        captions: snapshot.captions.map((caption) => ({
          text: caption.text,
          ...caption.language !== void 0 ? { language: caption.language } : {},
          clip_id: caption.clipId
        }))
      };
    }
  },
  {
    name: "get_clip",
    description: "Read one clip by id, including its position (seconds + timecode), source in/out points, text, and media/provider status.",
    inputSchema: objectSchema({ clip_id: CLIP_ID_SCHEMA }, ["clip_id"]),
    run: async (args, env) => {
      const clip = await env.store.getClip(requireString(args, "clip_id"));
      const timeline = await env.store.getTimeline();
      return clipView(clip, timeline.sequence.fps);
    }
  },
  {
    name: "place_clip",
    description: "Place a new clip on the timeline. Requires label, start_seconds, duration_seconds. Bind playable media with media_url + media_kind (must come together), or reference product media via generation_id / asset_id. track_id targets a specific track; omit it to use the first unlocked track matching the media kind.",
    inputSchema: objectSchema(
      {
        label: { type: "string", description: "Short human-readable clip name" },
        start_seconds: secondsSchema("Where the clip starts on the timeline, in seconds"),
        duration_seconds: secondsSchema("Clip length in seconds (at least one frame)"),
        media_url: { type: "string", description: "Playable media URL; requires media_kind" },
        media_kind: { type: "string", enum: [...SEQUENCE_MEDIA_KINDS], description: "Kind of the media behind media_url" },
        generation_id: { type: "string", description: "Product generation row backing this clip" },
        asset_id: { type: "string", description: "Product asset row backing this clip" },
        track_id: { type: "string", description: "Target track id; omit for automatic track choice" }
      },
      ["label", "start_seconds", "duration_seconds"]
    ),
    run: (args, env) => runMutation("place_clip", args, env, (timeline) => {
      const fps = timeline.sequence.fps;
      const mediaUrl = optionalString(args, "media_url");
      const mediaKind = optionalEnum(args, "media_kind", SEQUENCE_MEDIA_KINDS);
      if (mediaUrl === void 0 !== (mediaKind === void 0)) {
        throw new Error("media_url and media_kind must be provided together");
      }
      const generationId = optionalString(args, "generation_id");
      const assetId = optionalString(args, "asset_id");
      const trackId = optionalString(args, "track_id");
      const bounds = boundsArgsToFrames(
        requireSeconds(args, "start_seconds"),
        requireSeconds(args, "duration_seconds"),
        "duration_seconds",
        fps
      );
      return {
        operations: [
          {
            type: "place_clip",
            label: requireString(args, "label"),
            startFrame: bounds.startFrame,
            durationFrames: bounds.durationFrames,
            ...trackId !== void 0 ? { trackId } : {},
            ...mediaUrl !== void 0 && mediaKind !== void 0 ? { media: { url: mediaUrl, kind: mediaKind } } : {},
            ...generationId !== void 0 ? { generationId } : {},
            ...assetId !== void 0 ? { assetId } : {}
          }
        ]
      };
    })
  },
  {
    name: "add_caption",
    description: 'Add one caption clip. Omit start_seconds and duration_seconds to auto-place roughly 3 seconds of caption near the playhead without overlapping existing captions. language is a BCP-47 tag like "en" or "es".',
    inputSchema: objectSchema(
      {
        text: { type: "string", description: "Caption text" },
        language: { type: "string", description: "BCP-47 language tag; omit for the sequence default" },
        start_seconds: secondsSchema("Caption start in seconds; omit to auto-place near the playhead"),
        duration_seconds: secondsSchema("Caption length in seconds; omit for the ~3s default")
      },
      ["text"]
    ),
    run: (args, env) => runMutation("add_caption", args, env, (timeline) => {
      const fps = timeline.sequence.fps;
      const language = optionalString(args, "language");
      const startSeconds = optionalSeconds(args, "start_seconds");
      const durationSeconds = optionalSeconds(args, "duration_seconds");
      const bounds = startSeconds !== void 0 && durationSeconds !== void 0 ? boundsArgsToFrames(startSeconds, durationSeconds, "duration_seconds", fps) : {
        ...startSeconds !== void 0 ? { startFrame: secondsToFrames(startSeconds, fps) } : {},
        ...durationSeconds !== void 0 ? { durationFrames: durationArgToFrames(durationSeconds, "duration_seconds", fps) } : {}
      };
      return {
        operations: [
          {
            type: "add_caption",
            text: requireString(args, "text"),
            ...language !== void 0 ? { language } : {},
            ...bounds
          }
        ]
      };
    })
  },
  {
    name: "add_captions",
    description: `Add many caption clips in one call \u2014 use this for transcription output instead of repeated add_caption. Each item needs text, start_seconds, duration_seconds. One shared language applies to every caption. Max ${MAX_CAPTION_BATCH} per call.`,
    inputSchema: objectSchema(
      {
        captions: {
          type: "array",
          minItems: 1,
          maxItems: MAX_CAPTION_BATCH,
          description: "Caption entries in timeline order",
          items: objectSchema(
            {
              text: { type: "string", description: "Caption text" },
              start_seconds: secondsSchema("Caption start in seconds"),
              duration_seconds: secondsSchema("Caption length in seconds")
            },
            ["text", "start_seconds", "duration_seconds"]
          )
        },
        language: { type: "string", description: "BCP-47 language tag applied to every caption in the batch" }
      },
      ["captions"]
    ),
    run: (args, env) => runMutation("add_captions", args, env, (timeline) => {
      const fps = timeline.sequence.fps;
      const language = optionalString(args, "language");
      const raw = args.captions;
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error("captions is required and must be a non-empty array of {text, start_seconds, duration_seconds}");
      }
      if (raw.length > MAX_CAPTION_BATCH) {
        throw new Error(`captions has ${raw.length} entries \u2014 max ${MAX_CAPTION_BATCH} per call; split the batch`);
      }
      const operations = raw.map((entry, index) => {
        if (!isRecord(entry)) throw new Error(`captions[${index}] must be an object with text, start_seconds, duration_seconds`);
        try {
          const bounds = boundsArgsToFrames(
            requireSeconds(entry, "start_seconds"),
            requireSeconds(entry, "duration_seconds"),
            "duration_seconds",
            fps
          );
          return {
            type: "add_caption",
            text: requireString(entry, "text"),
            startFrame: bounds.startFrame,
            durationFrames: bounds.durationFrames,
            ...language !== void 0 ? { language } : {}
          };
        } catch (err) {
          throw new Error(`captions[${index}]: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
      return { operations };
    })
  },
  {
    name: "move_clip",
    description: "Move a clip so it starts at start_seconds, optionally onto another track via track_id. Duration and source in/out points are unchanged.",
    inputSchema: objectSchema(
      {
        clip_id: CLIP_ID_SCHEMA,
        start_seconds: secondsSchema("New clip start on the timeline, in seconds"),
        track_id: { type: "string", description: "Destination track id; omit to stay on the current track" }
      },
      ["clip_id", "start_seconds"]
    ),
    run: (args, env) => {
      const clipId = requireString(args, "clip_id");
      return runMutation("move_clip", args, env, (timeline) => {
        const trackId = optionalString(args, "track_id");
        return {
          clipId,
          operations: [
            {
              type: "move_clip",
              clipId,
              startFrame: secondsToFrames(requireSeconds(args, "start_seconds"), timeline.sequence.fps),
              ...trackId !== void 0 ? { trackId } : {}
            }
          ]
        };
      });
    }
  },
  {
    name: "trim_clip",
    description: "Set a clip to start_seconds + duration_seconds. source_in_seconds re-anchors where playback begins inside the source media (use it when trimming the head so the visible content stays aligned). A clip with an explicit source out-point (e.g. a split half) cannot grow past it \u2014 pass source_out_seconds to move the out-point when extending.",
    inputSchema: objectSchema(
      {
        clip_id: CLIP_ID_SCHEMA,
        start_seconds: secondsSchema("Clip start on the timeline, in seconds"),
        duration_seconds: secondsSchema("New clip length in seconds (at least one frame)"),
        source_in_seconds: secondsSchema("Offset into the source media where playback begins, in seconds"),
        source_out_seconds: secondsSchema("Offset into the source media where playback ends, in seconds; only needed to extend past a stored out-point")
      },
      ["clip_id", "start_seconds", "duration_seconds"]
    ),
    run: (args, env) => {
      const clipId = requireString(args, "clip_id");
      return runMutation("trim_clip", args, env, (timeline) => {
        const fps = timeline.sequence.fps;
        const sourceInSeconds = optionalSeconds(args, "source_in_seconds");
        const sourceOutSeconds = optionalSeconds(args, "source_out_seconds");
        const bounds = boundsArgsToFrames(
          requireSeconds(args, "start_seconds"),
          requireSeconds(args, "duration_seconds"),
          "duration_seconds",
          fps
        );
        return {
          clipId,
          operations: [
            {
              type: "trim_clip",
              clipId,
              startFrame: bounds.startFrame,
              durationFrames: bounds.durationFrames,
              ...sourceInSeconds !== void 0 ? { sourceInFrame: secondsToFrames(sourceInSeconds, fps) } : {},
              ...sourceOutSeconds !== void 0 ? { sourceOutFrame: secondsToFrames(sourceOutSeconds, fps) } : {}
            }
          ]
        };
      });
    }
  },
  {
    name: "split_clip",
    description: "Cut a clip into two at at_seconds (sequence time, strictly inside the clip). The original clip id keeps the left half; the returned clip is the new right half with its source in-point re-anchored at the cut.",
    inputSchema: objectSchema(
      {
        clip_id: CLIP_ID_SCHEMA,
        at_seconds: secondsSchema("Sequence time of the cut, in seconds; must fall strictly inside the clip")
      },
      ["clip_id", "at_seconds"]
    ),
    run: (args, env) => {
      const clipId = requireString(args, "clip_id");
      return runMutation("split_clip", args, env, (timeline) => ({
        clipId,
        operations: [
          {
            type: "split_clip",
            clipId,
            atFrame: secondsToFrames(requireSeconds(args, "at_seconds"), timeline.sequence.fps)
          }
        ]
      }));
    }
  },
  {
    name: "set_clip_text",
    description: "Replace a caption clip's text, optionally changing its BCP-47 language tag.",
    inputSchema: objectSchema(
      {
        clip_id: CLIP_ID_SCHEMA,
        text: { type: "string", description: "New caption text" },
        language: { type: "string", description: "BCP-47 language tag; omit to keep the current one" }
      },
      ["clip_id", "text"]
    ),
    run: (args, env) => {
      const clipId = requireString(args, "clip_id");
      return runMutation("set_clip_text", args, env, () => {
        const language = optionalString(args, "language");
        return {
          clipId,
          operations: [
            {
              type: "set_clip_text",
              clipId,
              text: requireString(args, "text"),
              ...language !== void 0 ? { language } : {}
            }
          ]
        };
      });
    }
  },
  {
    name: "delete_clip",
    description: "Remove a clip from the timeline permanently. Prefer set_clip_disabled to audition a cut without losing the clip.",
    inputSchema: objectSchema({ clip_id: CLIP_ID_SCHEMA }, ["clip_id"]),
    run: (args, env) => {
      const clipId = requireString(args, "clip_id");
      return runMutation("delete_clip", args, env, () => ({
        operations: [{ type: "delete_clip", clipId }]
      }));
    }
  },
  {
    name: "set_clip_disabled",
    description: "Disable (true) or re-enable (false) a clip without deleting it. Disabled clips do not render or sound.",
    inputSchema: objectSchema(
      {
        clip_id: CLIP_ID_SCHEMA,
        disabled: { type: "boolean", description: "true hides the clip; false restores it" }
      },
      ["clip_id", "disabled"]
    ),
    run: (args, env) => {
      const clipId = requireString(args, "clip_id");
      return runMutation("set_clip_disabled", args, env, () => ({
        clipId,
        operations: [{ type: "set_clip_disabled", clipId, disabled: requireBoolean(args, "disabled") }]
      }));
    }
  },
  {
    name: "create_track",
    description: `Add a track to the sequence. kind is one of: ${SEQUENCE_TRACK_KINDS.join(", ")}. New tracks sort below existing ones.`,
    inputSchema: objectSchema(
      {
        kind: { type: "string", enum: [...SEQUENCE_TRACK_KINDS], description: "Track kind" },
        name: { type: "string", description: "Track display name" }
      },
      ["kind", "name"]
    ),
    run: (args, env) => runMutation("create_track", args, env, () => ({
      operations: [
        {
          type: "create_track",
          kind: requireEnum(args, "kind", SEQUENCE_TRACK_KINDS),
          name: requireString(args, "name")
        }
      ]
    }))
  },
  {
    name: "extend_sequence",
    description: "Set the sequence's total duration in seconds. Growing always works; shrinking is rejected if any clip would fall past the new end.",
    inputSchema: objectSchema(
      { duration_seconds: secondsSchema("New total sequence duration in seconds") },
      ["duration_seconds"]
    ),
    run: (args, env) => runMutation("extend_sequence", args, env, (timeline) => ({
      operations: [
        {
          type: "extend_sequence",
          durationFrames: durationArgToFrames(requireSeconds(args, "duration_seconds"), "duration_seconds", timeline.sequence.fps)
        }
      ]
    }))
  },
  {
    name: "queue_export",
    description: `Queue an export of the sequence. format is one of: ${SEQUENCE_EXPORT_FORMATS.join(", ")}. Returns the queued export record; rendering happens asynchronously.`,
    inputSchema: objectSchema(
      { format: { type: "string", enum: [...SEQUENCE_EXPORT_FORMATS], description: "Export format" } },
      ["format"]
    ),
    run: (args, env) => runMutation("queue_export", args, env, () => ({
      operations: [{ type: "queue_export", format: requireEnum(args, "format", SEQUENCE_EXPORT_FORMATS) }]
    }))
  },
  {
    name: "list_decisions",
    description: "Read the sequence's edit-decision log (human edits, agent edits, exports, notes), newest first. limit caps the number of rows.",
    inputSchema: objectSchema(
      { limit: { type: "integer", minimum: 1, maximum: 1e3, description: "Max rows to return" } },
      []
    ),
    run: async (args, env) => {
      const limit = optionalPositiveInteger(args, "limit", 1e3);
      const decisions = await env.store.listDecisions(limit);
      return { decisions: decisions.map(decisionView) };
    }
  }
];
function findSequenceMcpTool(name) {
  return SEQUENCE_MCP_TOOLS.find((tool) => tool.name === name);
}

// src/sequences/mcp-handler.ts
function createSequencesMcpHandler(opts) {
  const playheadFrame = opts.playheadFrame ?? 0;
  if (!Number.isInteger(playheadFrame) || playheadFrame < 0) {
    throw new Error("playheadFrame must be a non-negative integer (frames at the sequence fps)");
  }
  const serverInfo = opts.serverInfo ?? { name: "sequences", version: "1.0.0" };
  return createMcpToolHandler({
    serverInfo,
    tools: SEQUENCE_MCP_TOOLS,
    buildEnv: (_request) => ({ store: opts.store, playheadFrame })
  });
}

// src/sequences/mcp-entry.ts
var DEFAULT_SEQUENCES_MCP_DESCRIPTION = "Live timeline editor for the current video sequence: read timeline state, place/move/trim/split clips, add captions, manage tracks, and queue exports. All times are seconds.";
function buildSequencesMcpServerEntry(opts) {
  return buildScopedMcpServerEntry({
    ...opts,
    label: "buildSequencesMcpServerEntry",
    defaultDescription: DEFAULT_SEQUENCES_MCP_DESCRIPTION
  });
}
export {
  DEFAULT_SEQUENCES_MCP_DESCRIPTION,
  MAX_CAPTION_BATCH,
  MIN_SEQUENCE_CLIP_FRAMES,
  MCP_PROTOCOL_VERSIONS as SEQUENCES_MCP_PROTOCOL_VERSIONS,
  SEQUENCE_EXPORT_FORMATS,
  SEQUENCE_MCP_TOOLS,
  SEQUENCE_MEDIA_KINDS,
  SEQUENCE_OPERATION_TYPES,
  SEQUENCE_TRACK_KINDS,
  applySequenceOperation,
  applySequenceOperations,
  assertClipFitsSequence,
  assertSequenceMediaUrl,
  buildCaptionChunks,
  buildContactSheetManifest,
  buildEdl,
  buildOtio,
  buildSequencesMcpServerEntry,
  buildSrt,
  buildVtt,
  captionCoverage,
  captionTrackNameForLanguage,
  chooseCaptionPlacement,
  clampClipDuration,
  clampClipStart,
  createSequencesMcpHandler,
  findSequenceMcpTool,
  formatSeconds,
  formatTimecode,
  framesToSeconds,
  lastClipEndFrame,
  normalizeLanguageTag,
  parseSequenceOperations,
  planLanguageFanout,
  resolveCaptionPlacement,
  resolveCaptionTarget,
  resolvePlaceClipTrack,
  secondsToFrames,
  snapshotFrame,
  trackIntervals,
  validateAddCaption,
  validateCreateTrack,
  validateDeleteClip,
  validateExtendSequence,
  validateMoveClip,
  validatePlaceClip,
  validateQueueExport,
  validateSequenceOperation,
  validateSequenceOperations,
  validateSetClipDisabled,
  validateSetClipText,
  validateSplitClip,
  validateTrimClip
};
//# sourceMappingURL=index.js.map