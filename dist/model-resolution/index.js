import {
  ModelFailoverExhaustedError,
  UPSTREAM_UNAVAILABLE_CODES,
  UPSTREAM_UNAVAILABLE_STATUSES,
  buildModelChain,
  isUpstreamUnavailable,
  readHttpStatusHint,
  runWithModelFailover
} from "../chunk-DEXBRUZR.js";

// src/model-resolution/index.ts
function canonicalModelId(model) {
  if (model.id.includes("/")) return model.id;
  const provider = model._provider ?? model.provider;
  return provider ? `${provider}/${model.id}` : model.id;
}
function resolveChatModel(input) {
  const request = cleanModelId(input.requestModel);
  if (request) return { model: request, source: "request" };
  const workspace = cleanModelId(input.workspaceModel);
  if (workspace) return { model: workspace, source: "workspace" };
  const env = cleanModelId(input.envModel);
  if (env) return { model: env, source: "env" };
  return { model: input.defaultModel, source: "default" };
}
async function validateChatModelId(modelId, input) {
  const cleaned = cleanModelId(modelId);
  if (!cleaned) return { succeeded: false, error: "Model id must be a non-empty string." };
  if (!isWellFormedModelId(cleaned)) return { succeeded: false, error: `Model id is malformed: ${cleaned}` };
  const allowed = new Set(input.allowlist ?? []);
  if (allowed.has(cleaned)) return { succeeded: true, value: cleaned };
  if (cleanModelId(input.envModel) === cleaned) return { succeeded: true, value: cleaned };
  if (!input.loadModels || typeof input.routerBaseUrl !== "string" || input.routerBaseUrl.length === 0) {
    return { succeeded: false, error: `Model is not available: ${cleaned}` };
  }
  let catalog;
  try {
    catalog = await input.loadModels(input.routerBaseUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { succeeded: false, error: `Could not validate model catalog: ${message}` };
  }
  const ids = new Set(catalog.flatMap(catalogIdsForModel));
  if (ids.has(cleaned)) return { succeeded: true, value: cleaned };
  if (!cleaned.includes("/")) {
    const canonicalBySuffix = /* @__PURE__ */ new Map();
    for (const model of catalog) {
      if (typeof model.id !== "string" || !model.id.trim()) continue;
      const canonical = canonicalModelId(model);
      if (!canonical.includes("/")) continue;
      const suffix = canonical.split("/").slice(1).join("/");
      const entries = canonicalBySuffix.get(suffix);
      if (entries) entries.push(canonical);
      else canonicalBySuffix.set(suffix, [canonical]);
    }
    const matches = canonicalBySuffix.get(cleaned);
    if (matches && matches.length === 1) return { succeeded: true, value: matches[0] };
  }
  return { succeeded: false, error: `Model is not available: ${cleaned}` };
}
function cleanModelId(value) {
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : void 0;
}
function isWellFormedModelId(modelId) {
  if (modelId.length > 200) return false;
  return /^[A-Za-z0-9._/@:-]+$/.test(modelId);
}
function catalogIdsForModel(model) {
  const ids = /* @__PURE__ */ new Set();
  if (typeof model.id === "string" && model.id.trim()) ids.add(model.id.trim());
  if (typeof model.id === "string" && model.id.trim() && !model.id.includes("/")) {
    const canonical = canonicalModelId(model);
    if (canonical.includes("/")) ids.add(canonical);
  }
  return [...ids];
}
export {
  ModelFailoverExhaustedError,
  UPSTREAM_UNAVAILABLE_CODES,
  UPSTREAM_UNAVAILABLE_STATUSES,
  buildModelChain,
  catalogIdsForModel,
  cleanModelId,
  isUpstreamUnavailable,
  isWellFormedModelId,
  readHttpStatusHint,
  resolveChatModel,
  runWithModelFailover,
  validateChatModelId
};
//# sourceMappingURL=index.js.map