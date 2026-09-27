// src/studio/generation.ts
var GENERATION_TYPES = ["image", "video", "avatar", "speech", "transcription"];
function isGenerationType(value) {
  return GENERATION_TYPES.includes(value);
}
var MIN_IMAGE_COUNT = 1;
var MAX_IMAGE_COUNT = 8;
function relativeTime(date) {
  if (!date) return "";
  const now = Date.now();
  const diff = now - new Date(date).getTime();
  const minutes = Math.floor(diff / 6e4);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function outputPathFor(type) {
  if (type === "image") return "generated/images";
  if (type === "video") return "generated/videos";
  if (type === "avatar") return "generated/avatars";
  if (type === "speech") return "generated/audio";
  return "generated/transcripts";
}
function generationVaultPath(generation) {
  const value = generation.metadata?.vaultPath;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function generationSavedToVault(generation) {
  const metadata = generation.metadata;
  if (metadata && Object.hasOwn(metadata, "savedToVaultAt")) {
    const value = metadata.savedToVaultAt;
    return value !== null && value !== void 0 && value !== false && value !== "";
  }
  return generationVaultPath(generation) !== null;
}
function selectedModelsWithDefaults(current, catalog) {
  const next = { ...current };
  for (const key of GENERATION_TYPES) {
    const models = catalog.models[key] ?? [];
    const currentOption = models.find((model) => model.id === next[key]);
    if (!next[key] || !currentOption || currentOption.status === "unavailable") {
      next[key] = preferredModelId(key, catalog) ?? "";
    }
  }
  return next;
}
function preferredModelId(type, catalog) {
  if (!catalog) return void 0;
  const models = catalog.models[type] ?? [];
  const preferred = catalog.defaults[type];
  return models.find((model) => model.id === preferred && model.status !== "unavailable")?.id ?? models.find((model) => model.status !== "unavailable")?.id ?? models[0]?.id;
}
function laneUnavailable(models) {
  return models.length === 0 || models.every((model) => model.status === "unavailable");
}
function modelMessage(model, loading, count) {
  if (loading) return "Loading media models...";
  if (count === 0) return "No models are available for this media type.";
  if (!model) return "Select a model.";
  if (model.status === "unavailable") return model.reason ?? "This model is not configured.";
  if (model.status === "limited") return model.reason ? `Limited: ${model.reason}` : "Limited availability.";
  return null;
}
function buildGenerationRequestBody(fields) {
  const body = {
    workspaceId: fields.workspaceId,
    clientRequestId: fields.clientRequestId,
    type: fields.type,
    model: fields.model,
    prompt: fields.prompt.trim()
  };
  if (fields.type === "image") {
    if (fields.image.size) body.size = fields.image.size;
    if (fields.image.quality) body.quality = fields.image.quality;
    body.n = fields.image.count;
  }
  if (fields.type === "video") {
    if (fields.video.duration !== void 0) body.duration = fields.video.duration;
    if (fields.video.resolution) body.resolution = fields.video.resolution;
    if (fields.video.aspectRatio) body.aspectRatio = fields.video.aspectRatio;
    if (fields.video.referenceImageUrl) body.referenceImageUrl = fields.video.referenceImageUrl;
    if (fields.video.audio !== void 0) body.audio = fields.video.audio;
    if (fields.video.mode) body.mode = fields.video.mode;
  }
  if (fields.type === "speech") {
    if (fields.speech.voice) body.voice = fields.speech.voice;
    if (fields.speech.speed !== void 0) body.speed = fields.speech.speed;
  }
  if (fields.type === "avatar" && fields.avatar) Object.assign(body, {
    audioUrl: fields.avatar.audioUrl.trim(),
    imageUrl: fields.avatar.imageUrl.trim() || void 0,
    avatarId: fields.avatar.avatarId.trim() || void 0
  });
  if (fields.type === "transcription" && fields.transcription) {
    const temperature = Number(fields.transcription.temperature);
    Object.assign(body, {
      audioUrl: fields.transcription.audioUrl.trim(),
      language: fields.transcription.language.trim() || void 0,
      responseFormat: fields.transcription.responseFormat,
      // omit (let the API default) rather than serialize NaN → null on bad input
      temperature: Number.isFinite(temperature) ? temperature : void 0
    });
  }
  return body;
}
function generationStatus(generation) {
  const metadata = generation.metadata ?? {};
  const status = typeof metadata.generationStatus === "string" ? metadata.generationStatus : "";
  if (status === "pending" || status === "running" || status === "failed" || status === "succeeded") return status;
  return generation.result ? "succeeded" : "pending";
}
function generationError(generation) {
  const metadata = generation.metadata ?? {};
  if (typeof metadata.providerError === "string" && metadata.providerError.trim()) {
    return userSafeGenerationMessage(metadata.providerError);
  }
  if (typeof metadata.storageError === "string" && metadata.storageError.trim()) {
    return metadata.storageError;
  }
  return null;
}
function generationClientRequestId(generation) {
  const metadata = generation.metadata ?? {};
  return typeof metadata.clientRequestId === "string" && metadata.clientRequestId.trim() ? metadata.clientRequestId : null;
}
function generationBatchSlotKey(generation) {
  const metadata = generation.metadata ?? {};
  const batchId = typeof metadata.batchId === "string" && metadata.batchId.trim() ? metadata.batchId : null;
  return batchId && typeof metadata.outputIndex === "number" ? `${batchId}:${metadata.outputIndex}` : null;
}
function generationMergeKey(generation) {
  return generationBatchSlotKey(generation) ?? generationClientRequestId(generation);
}
function mergeLiveGeneration(current, generation) {
  const mergeKey = generationMergeKey(generation);
  const existingIndex = current.findIndex((item) => item.id === generation.id || mergeKey && generationMergeKey(item) === mergeKey);
  if (existingIndex === -1) return [generation, ...current];
  const next = [...current];
  next[existingIndex] = generation;
  return next;
}
function mergeLoaderAndLive(loader, live) {
  if (live.length === 0) return loader;
  const leading = live.map((generation) => {
    const mergeKey = generationMergeKey(generation);
    return mergeKey ? loader.find((gen) => generationMergeKey(gen) === mergeKey) ?? generation : loader.find((gen) => gen.id === generation.id) ?? generation;
  });
  const leadingIds = new Set(leading.map((gen) => gen.id));
  const leadingMergeKeys = new Set(leading.map((gen) => generationMergeKey(gen)).filter((id) => Boolean(id)));
  return [
    ...leading,
    ...loader.filter((gen) => !leadingIds.has(gen.id) && !leadingMergeKeys.has(generationMergeKey(gen) ?? ""))
  ];
}
function isLocalGeneration(generation) {
  return generation.id.startsWith("local-");
}
function generationOutputIndex(generation) {
  const value = generation.metadata?.outputIndex;
  return typeof value === "number" ? value : 0;
}
function latestBatchOf(generations) {
  const first = generations[0];
  if (!first) return [];
  const key = generationClientRequestId(first);
  const batch = key ? generations.filter((generation) => generationClientRequestId(generation) === key) : [first];
  return [...batch].sort((a, b) => generationOutputIndex(a) - generationOutputIndex(b));
}
function userSafeGenerationMessage(message) {
  if (!message) return "Generation failed";
  if (/Tangle API key is invalid or expired/i.test(message)) return message;
  if (/(api[_ -]?key|secret|token|credential|env|configured|configuration)/i.test(message)) {
    return "Generation failed";
  }
  return message;
}
function optimisticGeneration({
  type,
  prompt,
  model,
  clientRequestId,
  outputIndex,
  outputCount
}, aspectRatio) {
  const batchId = outputIndex == null ? void 0 : clientRequestId;
  const aspectRatioMetadata = Number.isFinite(aspectRatio) && (aspectRatio ?? 0) > 0 ? { aspectRatio } : {};
  return {
    id: outputIndex == null ? `local-${clientRequestId}` : `local-${clientRequestId}-${outputIndex}`,
    type,
    prompt,
    result: null,
    model: model ?? null,
    cost: null,
    createdAt: /* @__PURE__ */ new Date(),
    metadata: {
      generationStatus: "pending",
      provider: type,
      clientRequestId,
      batchId,
      outputIndex,
      outputCount,
      ...aspectRatioMetadata
    }
  };
}
function failedOptimisticGeneration(generation) {
  return {
    ...generation,
    metadata: {
      ...generation.metadata ?? {},
      generationStatus: "failed",
      providerError: "Generation failed"
    }
  };
}
function normalizeImageCount(value) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return MIN_IMAGE_COUNT;
  return Math.min(Math.max(Math.trunc(numeric), MIN_IMAGE_COUNT), MAX_IMAGE_COUNT);
}
function generationBatchKey(generation) {
  const metadata = generation.metadata ?? {};
  if (typeof metadata.batchId === "string" && metadata.batchId.trim()) return metadata.batchId;
  if (typeof metadata.clientRequestId === "string" && metadata.clientRequestId.trim()) return metadata.clientRequestId;
  return generation.id;
}
function generationAssetId(generation) {
  const value = generation.metadata?.assetId;
  return typeof value === "string" && value.trim() ? value : null;
}
function generationsInBatch(generations, batchKey) {
  return generations.map((generation, inputIndex) => ({ generation, inputIndex })).filter(({ generation }) => generationBatchKey(generation) === batchKey).sort((left, right) => {
    const leftIndex = left.generation.metadata?.outputIndex;
    const rightIndex = right.generation.metadata?.outputIndex;
    const leftOrder = typeof leftIndex === "number" && Number.isFinite(leftIndex) ? leftIndex : Infinity;
    const rightOrder = typeof rightIndex === "number" && Number.isFinite(rightIndex) ? rightIndex : Infinity;
    return leftOrder - rightOrder || left.inputIndex - right.inputIndex;
  }).map(({ generation }) => generation);
}
function ratioFromDimensions(value, separator) {
  const match = separator === "size" ? /^(\d+)[x×](\d+)$/.exec(value) : /^(\d+):(\d+)$/.exec(value);
  if (!match) return void 0;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : void 0;
}
function roundedRatio(value) {
  return +value.toFixed(4);
}
function generationAspectRatio(generation) {
  const metadata = generation.metadata ?? {};
  if (typeof metadata.aspectRatio === "number" && Number.isFinite(metadata.aspectRatio) && metadata.aspectRatio > 0) {
    return roundedRatio(metadata.aspectRatio);
  }
  if (typeof metadata.size === "string") {
    const ratio = ratioFromDimensions(metadata.size, "size");
    if (ratio !== void 0) return roundedRatio(ratio);
  }
  if (typeof metadata.aspectRatio === "string") {
    const ratio = ratioFromDimensions(metadata.aspectRatio, "aspect");
    if (ratio !== void 0) return roundedRatio(ratio);
  }
  if (generation.type === "video") return roundedRatio(16 / 9);
  if (generation.type === "speech" || generation.type === "audio") return 3.2;
  return 1;
}
function aspectRatioFromOptions(type, options) {
  if (type === "speech") return 3.2;
  const ratio = type === "image" ? options.size ? ratioFromDimensions(options.size, "size") : void 0 : type === "video" ? options.aspectRatio ? ratioFromDimensions(options.aspectRatio, "aspect") : void 0 : void 0;
  return ratio === void 0 ? void 0 : roundedRatio(ratio);
}
function defaultVaultPathFor(generations) {
  const types = new Set(generations.map((generation) => generation.type));
  if (types.size !== 1) return "generated/media";
  const [type] = types;
  return type !== void 0 && isGenerationType(type) ? outputPathFor(type) : "generated/media";
}
function normalizeVaultPath(input) {
  const path = input.trim().replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
  if (!path) return null;
  const segments = path.split("/");
  return segments.some((segment) => segment === "." || segment === ".." || segment.includes("\\")) ? null : path;
}
function mergeGenerationPages(prev, next) {
  const seen = new Set(prev.map((generation) => generation.id));
  const merged = [...prev];
  for (const generation of next) {
    if (seen.has(generation.id)) continue;
    seen.add(generation.id);
    merged.push(generation);
  }
  return merged;
}
function generationSpecSegments(generation) {
  const metadata = generation.metadata ?? {};
  const segments = [];
  if (typeof metadata.size === "string") segments.push(metadata.size.replace(/x/g, "\xD7"));
  if (typeof metadata.resolution === "string") segments.push(metadata.resolution);
  if (typeof metadata.aspectRatio === "string" && /^(\d+):(\d+)$/.test(metadata.aspectRatio)) {
    segments.push(metadata.aspectRatio);
  }
  if (typeof metadata.duration === "string") {
    segments.push(metadata.duration);
  } else if (typeof metadata.durationSeconds === "number" && Number.isFinite(metadata.durationSeconds)) {
    const seconds = Math.max(0, Math.floor(metadata.durationSeconds));
    segments.push(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`);
  }
  if (typeof metadata.voice === "string") segments.push(metadata.voice);
  return segments;
}

// src/studio/model-options.ts
var SEEDANCE_2_0 = {
  duration: {
    values: ["auto", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"],
    default: "auto"
  },
  resolution: { values: ["480p", "720p", "1080p", "4k"], default: "720p" },
  aspect_ratio: { values: ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], default: "auto" },
  audio: { default: true }
};
var FALLBACK_VIDEO_MODEL_OPTIONS = {
  "runway/gen4.5": {
    duration: { min: 2, max: 10, default: 5 },
    aspect_ratio: { values: ["16:9", "9:16"], default: "16:9" },
    resolution: { supported: false },
    audio: { supported: false }
  },
  "runway/gen4_turbo": {
    duration: { min: 2, max: 10, default: 5 },
    aspect_ratio: { values: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9"], default: "16:9" },
    resolution: { supported: false },
    audio: { supported: false }
  },
  "kling/kling-v1-6": {
    duration: { values: [5, 10], default: 5 },
    aspect_ratio: { values: ["16:9", "9:16", "1:1"], default: "16:9" },
    resolution: { supported: false },
    audio: { supported: false },
    mode: { values: ["std", "pro"], default: "std" }
  },
  "kling/kling-v2-master": {
    duration: { values: [5, 10], default: 5 },
    aspect_ratio: { values: ["16:9", "9:16", "1:1"], default: "16:9" },
    resolution: { supported: false },
    audio: { supported: false },
    mode: { supported: false }
  },
  "bytedance/seedance-2.0/text-to-video": SEEDANCE_2_0,
  "bytedance/seedance-2.0/image-to-video": SEEDANCE_2_0,
  "fal-ai/kling-video/v3/pro/text-to-video": {
    duration: { values: ["3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"], default: "5" },
    resolution: { supported: false },
    aspect_ratio: { values: ["16:9", "9:16", "1:1"], default: "16:9" },
    audio: { default: true }
  },
  "fal-ai/veo3.1": {
    duration: { values: ["4s", "6s", "8s"], default: "8s" },
    resolution: { values: ["720p", "1080p", "4k"], default: "720p" },
    aspect_ratio: { values: ["16:9", "9:16"], default: "16:9" },
    audio: { default: true }
  },
  "xai/grok-imagine-video/text-to-video": {
    duration: { min: 1, max: 15, default: 6 },
    resolution: { values: ["480p", "720p"], default: "720p" },
    aspect_ratio: { values: ["16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16"], default: "16:9" },
    audio: { supported: false }
  }
};
var IMAGE_MODEL_OPTIONS = {
  "gpt-image-2": {
    size: { values: ["auto", "1024x1024", "1536x1024", "1024x1536"], default: "auto" },
    quality: { values: ["low", "medium", "high", "auto"], default: "auto" },
    n: { values: [1, 2, 4, 8], default: 1 }
  }
};
var OPENAI_TTS_VOICES = ["alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer"];
var OPENAI_GPT4O_MINI_TTS_VOICES = [...OPENAI_TTS_VOICES, "ballad", "cedar", "marin", "verse"];
var GOOGLE_TTS_VOICE_ALIASES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
var OPENAI_AUDIO_MODEL_OPTIONS = {
  "tts-1": {
    voice: { values: OPENAI_TTS_VOICES, default: "alloy" },
    speed: { min: 0.25, max: 4, default: 1 }
  },
  "tts-1-hd": {
    voice: { values: OPENAI_TTS_VOICES, default: "alloy" },
    speed: { min: 0.25, max: 4, default: 1 }
  },
  "gpt-4o-mini-tts": {
    voice: { values: OPENAI_GPT4O_MINI_TTS_VOICES, default: "alloy" },
    speed: { min: 0.25, max: 4, default: 1 }
  }
};
var GOOGLE_AUDIO_MODEL_OPTIONS = {
  voice: { values: GOOGLE_TTS_VOICE_ALIASES, default: "alloy" },
  speed: { supported: false }
};
var GPT_IMAGE_2_CUSTOM_SIZE = { multipleOf: 16, maxLongEdge: 3840, maxRatio: 3 };
function validateCustomImageSize(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return { ok: false, reason: "Width and height must be positive integers." };
  }
  if (width % GPT_IMAGE_2_CUSTOM_SIZE.multipleOf !== 0 || height % GPT_IMAGE_2_CUSTOM_SIZE.multipleOf !== 0) {
    return { ok: false, reason: "Each side must be a multiple of 16." };
  }
  if (Math.max(width, height) > GPT_IMAGE_2_CUSTOM_SIZE.maxLongEdge) {
    return { ok: false, reason: "The long edge must be 3840 pixels or less." };
  }
  if (Math.max(width / height, height / width) > GPT_IMAGE_2_CUSTOM_SIZE.maxRatio) {
    return { ok: false, reason: "The aspect ratio must be between 1:3 and 3:1." };
  }
  return { ok: true };
}
var KNOWN_PROVIDER_ALIASES = /* @__PURE__ */ new Set([
  "openai",
  "google",
  "gemini",
  "fal",
  "fal-ai",
  "runway",
  "kling",
  "bytedance",
  "xai"
]);
function bareSingleSlashId(modelId) {
  const segments = modelId.split("/");
  if (segments.length !== 2 || !KNOWN_PROVIDER_ALIASES.has(segments[0] ?? "")) return void 0;
  return segments[1];
}
function audioOptions(modelId, provider) {
  const bareId = bareSingleSlashId(modelId) ?? modelId;
  const exact = OPENAI_AUDIO_MODEL_OPTIONS[modelId] ?? OPENAI_AUDIO_MODEL_OPTIONS[bareId];
  if (exact) return exact;
  const normalizedProvider = provider?.toLowerCase();
  if (bareId.toLowerCase().startsWith("gemini") && bareId.toLowerCase().includes("tts") || normalizedProvider === "google" || normalizedProvider === "gemini") return GOOGLE_AUDIO_MODEL_OPTIONS;
  return void 0;
}
function resolveComposerOptions(input) {
  if (input.catalogOptions) return input.catalogOptions;
  if (input.type === "speech") return audioOptions(input.modelId, input.provider);
  const table = input.type === "image" ? IMAGE_MODEL_OPTIONS : FALLBACK_VIDEO_MODEL_OPTIONS;
  const exact = table[input.modelId];
  if (exact) return exact;
  const bareId = bareSingleSlashId(input.modelId);
  return bareId ? table[bareId] : void 0;
}
function supportsCustomImageSize(modelId) {
  return modelId === "gpt-image-2" || bareSingleSlashId(modelId) === "gpt-image-2";
}
var IMAGE_TO_VIDEO_SIBLINGS = {
  "bytedance/seedance-2.0/text-to-video": "bytedance/seedance-2.0/image-to-video"
};
function imageToVideoSibling(modelId) {
  return IMAGE_TO_VIDEO_SIBLINGS[modelId];
}
function textToVideoSibling(modelId) {
  return Object.entries(IMAGE_TO_VIDEO_SIBLINGS).find(([, sibling]) => sibling === modelId)?.[0];
}
function curateComposerModels(type, models) {
  if (type === "image") return models.filter((model) => supportsCustomImageSize(model.id));
  if (type === "video") {
    const imageToVideoIds = new Set(Object.values(IMAGE_TO_VIDEO_SIBLINGS));
    return models.filter((model) => !model.id.toLowerCase().includes("sora") && !imageToVideoIds.has(model.id));
  }
  return models;
}
function optionDefault(meta) {
  return meta.default ?? meta.values?.[0] ?? meta.min;
}
function optionChoices(meta) {
  if (meta.values) return meta.values;
  if (meta.min == null || meta.max == null) return [];
  const values = [];
  for (let value = Math.ceil(meta.min); value <= Math.floor(meta.max); value += 1) values.push(value);
  return values;
}
function isCustomSize(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) return false;
  return validateCustomImageSize(Number(match[1]), Number(match[2])).ok;
}
function isLegalOptionValue(meta, value) {
  if (meta.values) return meta.values.includes(value);
  if (typeof value === "number" && meta.min != null && meta.max != null) {
    return value >= meta.min && value <= meta.max;
  }
  return meta.min == null && meta.max == null;
}
function reconcileOptionValues(options, current, opts) {
  if (!options) return {};
  const reconciled = {};
  for (const [key, meta] of Object.entries(options)) {
    if (meta.supported === false) continue;
    const selected = current[key];
    const customSizeIsLegal = key === "size" && selected !== void 0 && opts?.allowCustomSize === true && isCustomSize(selected);
    const selectionIsLegal = selected !== void 0 && (isLegalOptionValue(meta, selected) || customSizeIsLegal);
    const next = selectionIsLegal ? selected : optionDefault(meta);
    if (next !== void 0) reconciled[key] = next;
  }
  return reconciled;
}

// src/studio/ports.ts
var MEDIA_TYPE_FILTERS = [
  { value: "all", label: "All media" },
  { value: "image", label: "Images" },
  { value: "video", label: "Videos" },
  { value: "speech", label: "Audio" }
];

// src/studio/audio-preview.ts
var GRID_WAVEFORM_BARS = 26;
var WIDE_WAVEFORM_BARS = 72;
function hashSeed(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function previewWaveformBars(seed, count) {
  const rnd = mulberry32(hashSeed(seed));
  return Array.from({ length: count }, (_, index) => {
    const t = count > 1 ? index / (count - 1) : 0;
    const env = Math.sin(Math.PI * t) * 0.55 + 0.45;
    const heightPct = +Math.max(7, (0.22 + rnd() * 0.78) * env * 92).toFixed(1);
    const opacity = +(0.5 + rnd() * 0.5).toFixed(2);
    return { heightPct, opacity };
  });
}

export {
  GENERATION_TYPES,
  isGenerationType,
  MIN_IMAGE_COUNT,
  MAX_IMAGE_COUNT,
  relativeTime,
  outputPathFor,
  generationVaultPath,
  generationSavedToVault,
  selectedModelsWithDefaults,
  preferredModelId,
  laneUnavailable,
  modelMessage,
  buildGenerationRequestBody,
  generationStatus,
  generationError,
  generationMergeKey,
  mergeLiveGeneration,
  mergeLoaderAndLive,
  isLocalGeneration,
  latestBatchOf,
  userSafeGenerationMessage,
  optimisticGeneration,
  failedOptimisticGeneration,
  normalizeImageCount,
  generationBatchKey,
  generationAssetId,
  generationsInBatch,
  generationAspectRatio,
  aspectRatioFromOptions,
  defaultVaultPathFor,
  normalizeVaultPath,
  mergeGenerationPages,
  generationSpecSegments,
  FALLBACK_VIDEO_MODEL_OPTIONS,
  GPT_IMAGE_2_CUSTOM_SIZE,
  validateCustomImageSize,
  resolveComposerOptions,
  supportsCustomImageSize,
  IMAGE_TO_VIDEO_SIBLINGS,
  imageToVideoSibling,
  textToVideoSibling,
  curateComposerModels,
  optionDefault,
  optionChoices,
  reconcileOptionValues,
  MEDIA_TYPE_FILTERS,
  GRID_WAVEFORM_BARS,
  WIDE_WAVEFORM_BARS,
  hashSeed,
  previewWaveformBars
};
//# sourceMappingURL=chunk-TY2DALJG.js.map