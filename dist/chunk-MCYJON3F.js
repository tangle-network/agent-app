// src/harness/index.ts
import {
  harnessProviders,
  harnessSupportsModel,
  harnessTypeSchema,
  modelProvider,
  preferredHarnessForModel,
  snapHarnessToModel as aiSnapHarnessToModel,
  snapModelToHarness as aiSnapModelToHarness
} from "@tangle-network/agent-interface";
var NON_BACKEND_HARNESSES = ["gemini"];
var nonBackendHarnesses = new Set(NON_BACKEND_HARNESSES);
var KNOWN_HARNESSES = [
  ...harnessTypeSchema.options.filter(
    (harness) => !nonBackendHarnesses.has(harness)
  )
];
var DEFAULT_HARNESS = "opencode";
var HARNESS_SET = new Set(KNOWN_HARNESSES);
function isHarness(value) {
  return typeof value === "string" && HARNESS_SET.has(value);
}
function coerceHarness(value, fallback = DEFAULT_HARNESS) {
  return isHarness(value) ? value : fallback;
}
function resolveSessionHarness(input = {}) {
  const fallback = input.fallback ?? DEFAULT_HARNESS;
  if (isHarness(input.sessionHarness)) {
    const locked = input.sessionHarness;
    const swapAttempted = isHarness(input.requested) && input.requested !== locked;
    return { harness: locked, locked: true, swapAttempted };
  }
  const harness = coerceHarness(input.requested, coerceHarness(input.workspaceDefault, fallback));
  return { harness, locked: false, swapAttempted: false };
}
function isModelCompatibleWithHarness(harness, modelId) {
  return harnessSupportsModel(harness, modelId);
}
function snapModelToHarness(harness, modelId, canonicalIds) {
  return aiSnapModelToHarness(harness, modelId, canonicalIds);
}
function snapHarnessToModel(harness, modelId) {
  const snapped = aiSnapHarnessToModel(harness, modelId);
  if (!isHarness(snapped)) {
    throw new Error(
      `Harness "${harness}" snapped to "${snapped}" for model "${modelId}", which this platform has no backend for.`
    );
  }
  return snapped;
}
function assertHarnessModelCompatible(harness, selection) {
  const modelId = typeof selection === "string" ? selection : selection.model;
  const transportProvider = typeof selection === "string" ? void 0 : selection.provider;
  const providers = harnessProviders(harness);
  const provider = modelProvider(modelId) ?? transportProvider ?? null;
  const isDefaultSentinel = modelId.trim() === "" || modelId.trim() === "default";
  const compatible = isDefaultSentinel || providers === null || provider !== null && providers.includes(provider);
  if (!compatible) {
    const native = preferredHarnessForModel(modelId);
    const providerDescription = provider ?? "unqualified";
    throw new Error(
      `Harness "${harness}" cannot run model "${modelId}" (provider "${providerDescription}"). Use ${native ?? "a router-backed harness (opencode)"} or an allowed model.`
    );
  }
}

export {
  modelProvider,
  KNOWN_HARNESSES,
  DEFAULT_HARNESS,
  isHarness,
  coerceHarness,
  resolveSessionHarness,
  isModelCompatibleWithHarness,
  snapModelToHarness,
  snapHarnessToModel,
  assertHarnessModelCompatible
};
//# sourceMappingURL=chunk-MCYJON3F.js.map