import {
  BrandMark,
  COMMAND_HISTORY_LIMIT,
  DEFAULT_MAX_MEDIA_ELEMENTS,
  DEFAULT_TIMELINE_LABELS,
  PreviewCanvas,
  SEEK_TIMEOUT_MS,
  SEEK_TOLERANCE_SECONDS,
  SEQUENCE_MEDIA_DRAG_TYPE,
  SnapIndicatorLine,
  TimelineClipChip,
  TimelineEditor,
  TimelineEmptyState,
  TimelineGhostLanes,
  TimelinePlayhead,
  TimelineRuler,
  TimelineSmallScreenGate,
  TimelineTrackRow,
  ZoomControl,
  addCaptionCommand,
  applySnap,
  captionFontPx,
  chooseMoveSnap,
  classifyMediaUrl,
  clipChipGeometry,
  collectSnapPoints,
  compositeCommand,
  computeWaveform,
  containFitRect,
  createCommandStack,
  createImageFrameProvider,
  createMediaElementPool,
  createPlaybackClock,
  createVideoElementFrameProvider,
  createZoomMath,
  deleteClipCommand,
  drawWaveform,
  frameToPixel,
  framesFromPixelDelta,
  letterboxRect,
  loadWaveform,
  moveClipCommand,
  moveDragStartFrame,
  needsSeek,
  pixelToFrame,
  placeClipCommand,
  selectTickStepSeconds,
  setClipTextCommand,
  snapPixel,
  splitClipCommand,
  toggleClipDisabledCommand,
  trimClipCommand,
  trimEndDrag,
  trimStartDrag
} from "../chunk-ZGY6QB4F.js";
import "../chunk-BVKQKGRK.js";

// src/sequences-react/media/transcription.ts
var DEFAULT_WHISPER_MODEL = "onnx-community/whisper-large-v3-turbo";
var WHISPER_SAMPLE_RATE = 16e3;
var TRANSCRIPTION_PEER = "@huggingface/transformers";
var PEER_MISSING_MESSAGE = "transcription requires optional peer @huggingface/transformers";
function mixdownToMono(buffer) {
  if (buffer.numberOfChannels < 1) throw new Error("audio buffer has no channels \u2014 cannot mix down");
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    if (data.length !== buffer.length) {
      throw new Error(`channel ${channel} has ${data.length} samples, expected ${buffer.length}`);
    }
    for (let i = 0; i < data.length; i++) {
      mono[i] = mono[i] + data[i];
    }
  }
  const scale = 1 / buffer.numberOfChannels;
  for (let i = 0; i < mono.length; i++) {
    mono[i] = mono[i] * scale;
  }
  return mono;
}
function mapWhisperOutput(output, durationSeconds, mediaUrl) {
  const first = Array.isArray(output) ? output[0] : output;
  if (first === void 0) throw new Error(`whisper produced no output for ${mediaUrl}`);
  const chunks = first.chunks;
  if (chunks === void 0 || chunks.length === 0) {
    const text = first.text.trim();
    return text.length === 0 ? [] : [{ text, startSeconds: 0, endSeconds: durationSeconds }];
  }
  const segments = [];
  for (const chunk of chunks) {
    const text = chunk.text.trim();
    if (text.length === 0) continue;
    const [start, end] = chunk.timestamp;
    if (!Number.isFinite(start)) {
      throw new Error(`whisper returned a non-numeric start timestamp for "${text}" in ${mediaUrl}`);
    }
    segments.push({ text, startSeconds: start, endSeconds: end === null ? durationSeconds : end });
  }
  return segments;
}
async function loadTransformers() {
  try {
    return await import(
      /* @vite-ignore */
      /* webpackIgnore: true */
      TRANSCRIPTION_PEER
    );
  } catch (error) {
    throw new Error(PEER_MISSING_MESSAGE, { cause: error });
  }
}
async function fetchMonoAudio(mediaUrl) {
  const response = await fetch(mediaUrl);
  if (!response.ok) {
    throw new Error(`failed to fetch media for transcription: ${response.status} ${response.statusText} from ${mediaUrl}`);
  }
  const bytes = await response.arrayBuffer();
  if (typeof OfflineAudioContext === "undefined") {
    throw new Error("transcription requires Web Audio (OfflineAudioContext) \u2014 call transcribe() from a browser");
  }
  const context = new OfflineAudioContext(1, 1, WHISPER_SAMPLE_RATE);
  const decoded = await context.decodeAudioData(bytes);
  return { samples: mixdownToMono(decoded), durationSeconds: decoded.duration };
}
function createWhisperTranscriptionProvider(opts) {
  const model = opts?.model ?? DEFAULT_WHISPER_MODEL;
  let availability = null;
  let pipelinePromise = null;
  const probeAvailability = () => {
    if (availability !== null) return availability;
    const resolve = import.meta.resolve;
    if (typeof resolve !== "function") {
      availability = false;
      return availability;
    }
    try {
      resolve.call(import.meta, TRANSCRIPTION_PEER);
      availability = true;
    } catch {
      availability = false;
    }
    return availability;
  };
  const getPipeline = (transformers, onProgress) => {
    if (pipelinePromise === null) {
      const device = typeof navigator !== "undefined" && "gpu" in navigator ? "webgpu" : "wasm";
      pipelinePromise = transformers.pipeline("automatic-speech-recognition", model, {
        dtype: "q4",
        device,
        // Model download progress only — it dwarfs inference time on first
        // use, and only the first transcribe ever sees a download.
        progress_callback: (event) => {
          if (event.status === "progress" && typeof event.progress === "number" && onProgress !== void 0) {
            onProgress(Math.min(1, Math.max(0, event.progress / 100)));
          }
        }
      });
      pipelinePromise.catch(() => {
        pipelinePromise = null;
      });
    }
    return pipelinePromise;
  };
  return {
    get available() {
      return probeAvailability();
    },
    async transcribe(mediaUrl, transcribeOpts) {
      const transformers = await loadTransformers();
      availability = true;
      const audio = await fetchMonoAudio(mediaUrl);
      const transcriber = await getPipeline(transformers, transcribeOpts?.onProgress);
      const options = {
        return_timestamps: true,
        chunk_length_s: 30,
        stride_length_s: 5
      };
      if (transcribeOpts?.language !== void 0) options.language = transcribeOpts.language;
      const output = await transcriber(audio.samples, options);
      const segments = mapWhisperOutput(output, audio.durationSeconds, mediaUrl);
      transcribeOpts?.onProgress?.(1);
      return segments;
    }
  };
}

// src/sequences-react/lazy.tsx
import React from "react";
var SequenceTimelineEditorLazy = React.lazy(() => import("../TimelineEditor-52YEPDX5.js"));
export {
  BrandMark,
  COMMAND_HISTORY_LIMIT,
  DEFAULT_MAX_MEDIA_ELEMENTS,
  DEFAULT_TIMELINE_LABELS,
  DEFAULT_WHISPER_MODEL,
  PreviewCanvas,
  SEEK_TIMEOUT_MS,
  SEEK_TOLERANCE_SECONDS,
  SEQUENCE_MEDIA_DRAG_TYPE,
  SequenceTimelineEditorLazy,
  SnapIndicatorLine,
  TimelineClipChip,
  TimelineEditor,
  TimelineEmptyState,
  TimelineGhostLanes,
  TimelinePlayhead,
  TimelineRuler,
  TimelineSmallScreenGate,
  TimelineTrackRow,
  ZoomControl,
  addCaptionCommand,
  applySnap,
  captionFontPx,
  chooseMoveSnap,
  classifyMediaUrl,
  clipChipGeometry,
  collectSnapPoints,
  compositeCommand,
  computeWaveform,
  containFitRect,
  createCommandStack,
  createImageFrameProvider,
  createMediaElementPool,
  createPlaybackClock,
  createVideoElementFrameProvider,
  createWhisperTranscriptionProvider,
  createZoomMath,
  deleteClipCommand,
  drawWaveform,
  frameToPixel,
  framesFromPixelDelta,
  letterboxRect,
  loadWaveform,
  mapWhisperOutput,
  mixdownToMono,
  moveClipCommand,
  moveDragStartFrame,
  needsSeek,
  pixelToFrame,
  placeClipCommand,
  selectTickStepSeconds,
  setClipTextCommand,
  snapPixel,
  splitClipCommand,
  toggleClipDisabledCommand,
  trimClipCommand,
  trimEndDrag,
  trimStartDrag
};
//# sourceMappingURL=index.js.map