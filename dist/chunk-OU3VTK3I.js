// src/runtime/model-catalog.ts
var PROVIDER_TIER = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "deepseek",
  "moonshot",
  "zai",
  "mistral",
  "groq",
  "nvidia",
  "cohere",
  "cerebras"
];
function normalizeProvider(provider) {
  const normalized = provider.toLowerCase();
  if (normalized === "moonshotai") return "moonshot";
  if (normalized === "z-ai") return "zai";
  if (normalized === "x-ai") return "xai";
  if (normalized === "mistralai") return "mistral";
  return normalized;
}
function providerForModel(model) {
  const declared = model._provider ?? model.provider ?? model.routeability?.provider;
  if (declared) return normalizeProvider(declared);
  const id = normalizeModelId(model.id).toLowerCase();
  if (/^claude-/.test(id)) return "anthropic";
  if (/^(?:gpt-|o\d)/.test(id)) return "openai";
  if (/^gemini-/.test(id)) return "google";
  if (/^grok-/.test(id)) return "xai";
  if (/^deepseek-/.test(id)) return "deepseek";
  if (/^kimi-/.test(id)) return "moonshot";
  if (/^glm-/.test(id)) return "zai";
  if (/^mistral/.test(id)) return "mistral";
  return "unknown";
}
var MAX_RECOMMENDED_MODELS = 3;
var EXCLUDED_ID = /(embedding|tts|transcribe|whisper|audio|realtime|image|lyria|sora|dall-e|moderation|content-safety|search-preview|search-api|deep-research|:batch$)/;
var DEFAULT_CANDIDATE_RULES = [
  { providers: ["anthropic"], match: /^claude-sonnet-[\d-]+$/ },
  { providers: ["anthropic"], match: /^claude-opus-[\d-]+$/ },
  { providers: ["anthropic"], match: /^claude-haiku-[\d-]+$/ },
  { providers: ["openai"], match: /^gpt-\d+(\.\d+)?$/ },
  { providers: ["openai"], match: /^gpt-\d+(\.\d+)?-mini$/ },
  { providers: ["google"], match: /^gemini-[\d.]+-pro(-preview)?$/ },
  { providers: ["google"], match: /^gemini-[\d.]+-flash(-preview)?$/ },
  { providers: ["xai"], match: /^grok-[\d.]+$/ },
  { providers: ["deepseek"], match: /^deepseek-(chat|v[\d.]+(-\w+)?)$/ },
  { providers: ["moonshotai", "moonshot"], match: /^kimi-k[\d.]+$/ },
  { providers: ["zai", "z-ai"], match: /^glm-[\d.]+$/ },
  { providers: ["mistral"], match: /^mistral-(large|medium)-?[\d.-]*$/ }
];
var TOOL_CAPABLE_FAMILY = /^(claude|gpt-[45]|gpt-oss|o[134]|gemini|grok|deepseek|glm|kimi|mistral|ministral|magistral|command|nemotron|llama)/;
function normalizeModelId(id) {
  let tail = id.split("/").pop() ?? id;
  tail = tail.replace(/:free$/, "");
  tail = tail.replace(/-\d{8}$/, "");
  tail = tail.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return tail;
}
function versionOf(normId) {
  return (normId.match(/\d+/g) ?? []).map(Number);
}
function compareVersions(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}
function releaseVersion(id) {
  const normalized = normalizeModelId(id).toLowerCase();
  const patterns = [
    /^claude-[a-z0-9]+-(\d+(?:[.-]\d+)*)/,
    /^gpt-(\d+(?:\.\d+)*)/,
    /^o(\d+(?:\.\d+)*)/,
    /^gemini-(\d+(?:\.\d+)*)/,
    /^deepseek-v(\d+(?:\.\d+)*)/,
    /^kimi-k(\d+(?:\.\d+)*)/,
    /^glm-(\d+(?:\.\d+)*)/,
    /^grok-(\d+(?:\.\d+)*)/,
    /^mistral-(?:large|medium)-?(\d+(?:[.-]\d+)*)/,
    /^qwen-?(\d+(?:\.\d+)*)/,
    /^llama-?(\d+(?:\.\d+)*)/
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) return match[1].split(/[.-]/).map(Number);
  }
  return [];
}
function sortModelsByFreshness(models) {
  return [...models].sort((a, b) => {
    const providerA = normalizeProvider(a.provider);
    const providerB = normalizeProvider(b.provider);
    const providerOrder = providerRank(providerA) - providerRank(providerB);
    if (providerOrder !== 0) return providerOrder;
    if (providerA !== providerB) return providerA.localeCompare(providerB);
    const generationOrder = compareVersions(releaseVersion(b.id), releaseVersion(a.id));
    if (generationOrder !== 0) return generationOrder;
    const previewOrder = Number(/preview/i.test(a.id)) - Number(/preview/i.test(b.id));
    if (previewOrder !== 0) return previewOrder;
    return a.id.localeCompare(b.id);
  });
}
function aliasPenalty(id) {
  let p = 0;
  if (id.includes("/")) p += 4;
  if (/-\d{8}$|-\d{4}-\d{2}-\d{2}$/.test(id.replace(/:free$/, ""))) p += 2;
  if (id.endsWith(":free")) p += 1;
  return p;
}
function providerRank(provider) {
  const i = PROVIDER_TIER.indexOf(normalizeProvider(provider));
  return i === -1 ? PROVIDER_TIER.length : i;
}
function isChatCapableModel(m) {
  const arch = m.architecture;
  if (!arch?.input_modalities || !arch?.output_modalities) return true;
  return arch.input_modalities.includes("text") && arch.output_modalities.includes("text");
}
var isChatModel = isChatCapableModel;
function isRouteable(m) {
  const routeability = m.routeability;
  if (!routeability) return true;
  const chatEndpoint = routeability.endpoints?.chat_completions;
  if (chatEndpoint?.routeable === false) return false;
  if (chatEndpoint?.status !== void 0 && chatEndpoint.status !== "routeable") return false;
  if (routeability.routeable === true || routeability.status === "routeable") return true;
  if (routeability.routeable === false) return false;
  return routeability.status === void 0;
}
function catalogModelForId(models, requestedId) {
  const requested = requestedId?.trim();
  if (!requested) return void 0;
  const exact = models.find((model) => model.id === requested);
  if (exact) return exact;
  const slash = requested.indexOf("/");
  const requestedProvider = slash > 0 ? normalizeProvider(requested.slice(0, slash)) : void 0;
  const normalized = normalizeModelId(requested);
  return models.find((model) => {
    if (normalizeModelId(model.id) !== normalized) return false;
    return requestedProvider === void 0 || normalizeProvider(model.provider) === requestedProvider;
  });
}
function resolveCatalogModelId(models, selectedId, fallbackId) {
  if (models.length === 0) return selectedId?.trim() || fallbackId?.trim();
  return catalogModelForId(models, selectedId)?.id ?? catalogModelForId(models, fallbackId)?.id ?? models[0]?.id;
}
function buildCatalog(raw, opts) {
  const candidates = raw.filter(
    (m) => m.id && isRouteable(m) && isChatModel(m) && !EXCLUDED_ID.test(normalizeModelId(m.id))
  );
  const groups = /* @__PURE__ */ new Map();
  for (const m of candidates) {
    const key = `${providerForModel(m)}::${normalizeModelId(m.id)}`;
    const g = groups.get(key);
    if (g) g.push(m);
    else groups.set(key, [m]);
  }
  const reps = [];
  for (const group of groups.values()) {
    group.sort((a, b) => aliasPenalty(a.id) - aliasPenalty(b.id) || a.id.length - b.id.length);
    const rep = group[0];
    const mergedParams = new Set(group.flatMap((m) => m.supported_parameters ?? []));
    reps.push({ model: rep, normId: normalizeModelId(rep.id), mergedParams });
  }
  const defaultCandidateIds = [];
  for (const rule of DEFAULT_CANDIDATE_RULES) {
    const matches = reps.filter(
      (r) => rule.providers.map(normalizeProvider).includes(providerForModel(r.model)) && rule.match.test(r.normId) && !defaultCandidateIds.includes(r.model.id)
    );
    if (!matches.length) continue;
    matches.sort(
      (a, b) => compareVersions(versionOf(b.normId), versionOf(a.normId)) || Number(a.normId.includes("preview")) - Number(b.normId.includes("preview")) || a.model.id.length - b.model.id.length
    );
    defaultCandidateIds.push(matches[0].model.id);
  }
  const toCatalogModel = (r) => {
    const m = r.model;
    const provider = providerForModel(m);
    return {
      id: m.id,
      name: m.name ?? m.id,
      provider,
      description: m.description ? m.description.slice(0, 160) : void 0,
      contextLength: m.context_length,
      pricing: m.pricing?.prompt || m.pricing?.completion ? { prompt: m.pricing.prompt ?? void 0, completion: m.pricing.completion ?? void 0 } : void 0,
      supportsTools: r.mergedParams.has("tools") || TOOL_CAPABLE_FAMILY.test(r.normId),
      supportsReasoning: r.mergedParams.has("reasoning") || r.mergedParams.has("include_reasoning"),
      featured: false
    };
  };
  const defaultCandidatesInRuleOrder = defaultCandidateIds.map((id) => reps.find((r) => r.model.id === id)).map(toCatalogModel);
  const sorted = sortModelsByFreshness(reps.map(toCatalogModel));
  const recommendedIds = /* @__PURE__ */ new Set();
  const seenProviders = /* @__PURE__ */ new Set();
  for (const model of sorted) {
    const provider = normalizeProvider(model.provider);
    if (providerRank(provider) >= PROVIDER_TIER.length) continue;
    if (seenProviders.has(provider)) continue;
    seenProviders.add(provider);
    recommendedIds.add(model.id);
    if (recommendedIds.size >= MAX_RECOMMENDED_MODELS) break;
  }
  const models = sorted.map(
    (model) => recommendedIds.has(model.id) ? { ...model, featured: true } : model
  );
  const preferred = opts?.preferredDefault;
  const defaultModelId = preferred && models.find((m) => m.id === preferred || normalizeModelId(m.id) === normalizeModelId(preferred))?.id || defaultCandidatesInRuleOrder.find((m) => m.supportsTools)?.id || models[0]?.id || null;
  return { defaultModelId, fetchedAt: (/* @__PURE__ */ new Date()).toISOString(), models };
}
var CATALOG_TTL_MS = 5 * 60 * 1e3;
var _cache = null;
async function fetchModelCatalog(cfg) {
  if (_cache && Date.now() - _cache.at < CATALOG_TTL_MS) {
    return _cache.catalog;
  }
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` }
    });
    if (!res.ok) throw new Error(`Router /models returned ${res.status}`);
    const data = await res.json();
    const catalog = buildCatalog(data.data ?? [], { preferredDefault: cfg.preferredDefault });
    _cache = { catalog, at: Date.now() };
    return catalog;
  } catch (err) {
    if (_cache) return _cache.catalog;
    throw err;
  }
}
function __resetCatalogCache() {
  _cache = null;
}

export {
  MAX_RECOMMENDED_MODELS,
  normalizeModelId,
  sortModelsByFreshness,
  isChatCapableModel,
  catalogModelForId,
  resolveCatalogModelId,
  buildCatalog,
  fetchModelCatalog,
  __resetCatalogCache
};
//# sourceMappingURL=chunk-OU3VTK3I.js.map