/**
 * Model catalogue — computed live from the Tangle Router, never hand-curated.
 * Lifted from tuner-agent so every agent app's model picker shares one
 * filter/dedupe/rank/feature pipeline instead of re-deriving it.
 *
 * The router's /models endpoint returns every routeable model (~200), which is
 * unusable as a picker list: it mixes chat models with TTS/embedding/realtime
 * endpoints, dated snapshots alias their parents, and provider-prefixed ids
 * duplicate canonical ones. This module turns that into a product catalogue:
 *
 *   filter (chat-capable, routeable) → dedupe (snapshot/prefix/:free aliases)
 *   → rank (provider tier, current generation) → recommend (bounded shortlist)
 *   → default (env override or preferred family)
 *
 * Freshness is automatic: everything is derived from the live router response,
 * so new models surface as soon as the router lists them. The only static
 * knowledge here is slow-moving: provider display order and family name
 * patterns (e.g. "claude-sonnet-*", "gpt-N"). A new release and a new family
 * both reach the first row from their versioned id with no catalogue edit.
 */

export interface RouterModel {
  id: string
  name?: string
  description?: string
  _provider?: string
  provider?: string
  pricing?: { prompt?: string | null; completion?: string | null }
  context_length?: number
  architecture?: {
    modality?: string
    input_modalities?: string[]
    output_modalities?: string[]
  }
  supported_parameters?: string[]
  routeability?: {
    status?: string
    routeable?: boolean
    provider?: string
    endpoints?: {
      chat_completions?: {
        status?: string
        routeable?: boolean
      }
    }
  }
}

/** Define the structure and capabilities of a catalog item with optional pricing and feature flags */
export interface CatalogModel {
  id: string
  name: string
  provider: string
  description?: string
  contextLength?: number
  pricing?: { prompt?: string; completion?: string }
  supportsTools: boolean
  supportsReasoning: boolean
  featured: boolean
}

/** Define a catalog containing models with a default ID and fetch timestamp */
export interface ModelCatalog {
  defaultModelId: string | null
  fetchedAt: string
  models: CatalogModel[]
}

/** Display order. Unlisted providers sort after these, alphabetically. */
const PROVIDER_TIER: string[] = [
  'anthropic',
  'openai',
  'google',
  'xai',
  'deepseek',
  'moonshot',
  'zai',
  'mistral',
  'groq',
  'nvidia',
  'cohere',
  'cerebras',
]

/** Router aliases that are one provider in a user-facing catalogue. */
function normalizeProvider(provider: string): string {
  const normalized = provider.toLowerCase()
  if (normalized === 'moonshotai') return 'moonshot'
  if (normalized === 'z-ai') return 'zai'
  if (normalized === 'x-ai') return 'xai'
  if (normalized === 'mistralai') return 'mistral'
  return normalized
}

/** Resolve provider metadata across router response versions. */
function providerForModel(model: RouterModel): string {
  const declared = model._provider ?? model.provider ?? model.routeability?.provider
  if (declared) return normalizeProvider(declared)

  const id = normalizeModelId(model.id).toLowerCase()
  if (/^claude-/.test(id)) return 'anthropic'
  if (/^(?:gpt-|o\d)/.test(id)) return 'openai'
  if (/^gemini-/.test(id)) return 'google'
  if (/^grok-/.test(id)) return 'xai'
  if (/^deepseek-/.test(id)) return 'deepseek'
  if (/^kimi-/.test(id)) return 'moonshot'
  if (/^glm-/.test(id)) return 'zai'
  if (/^mistral/.test(id)) return 'mistral'
  return 'unknown'
}

/** A short first screen, not one row for every Router provider. */
export const MAX_RECOMMENDED_MODELS = 3

/** Non-chat endpoints that pollute the router list (matched on normalized id). */
const EXCLUDED_ID = /(embedding|tts|transcribe|whisper|audio|realtime|image|lyria|sora|dall-e|moderation|content-safety|search-preview|search-api|deep-research|:batch$)/

/**
 * Default families, in preference order. Each rule finds the highest-version
 * routeable model whose normalized id matches. Patterns anchor on the family
 * name and stop before specialty suffixes (codex, nano, lite, …) so the
 * mainline model wins.
 */
const DEFAULT_CANDIDATE_RULES: Array<{ providers: string[]; match: RegExp }> = [
  { providers: ['anthropic'], match: /^claude-sonnet-[\d-]+$/ },
  { providers: ['anthropic'], match: /^claude-opus-[\d-]+$/ },
  { providers: ['anthropic'], match: /^claude-haiku-[\d-]+$/ },
  { providers: ['openai'], match: /^gpt-\d+(\.\d+)?$/ },
  { providers: ['openai'], match: /^gpt-\d+(\.\d+)?-mini$/ },
  { providers: ['google'], match: /^gemini-[\d.]+-pro(-preview)?$/ },
  { providers: ['google'], match: /^gemini-[\d.]+-flash(-preview)?$/ },
  { providers: ['xai'], match: /^grok-[\d.]+$/ },
  { providers: ['deepseek'], match: /^deepseek-(chat|v[\d.]+(-\w+)?)$/ },
  { providers: ['moonshotai', 'moonshot'], match: /^kimi-k[\d.]+$/ },
  { providers: ['zai', 'z-ai'], match: /^glm-[\d.]+$/ },
  { providers: ['mistral'], match: /^mistral-(large|medium)-?[\d.-]*$/ },
]

/** Families known to support tool calls even when router metadata omits it
 *  (dated snapshots often lack the supported_parameters of their parent). */
const TOOL_CAPABLE_FAMILY = /^(claude|gpt-[45]|gpt-oss|o[134]|gemini|grok|deepseek|glm|kimi|mistral|ministral|magistral|command|nemotron|llama)/

/** Strip provider prefix, :free suffix, and trailing date stamps. */
export function normalizeModelId(id: string): string {
  let tail = id.split('/').pop() ?? id
  tail = tail.replace(/:free$/, '')
  tail = tail.replace(/-\d{8}$/, '')
  tail = tail.replace(/-\d{4}-\d{2}-\d{2}$/, '')
  return tail
}

/** All numeric groups in a normalized id, for version comparison. */
function versionOf(normId: string): number[] {
  return (normId.match(/\d+/g) ?? []).map(Number)
}

function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1)
    if (d !== 0) return d
  }
  return 0
}

/**
 * Read the generation attached to a known model family.
 *
 * This deliberately does not read every number in the id. A parameter count
 * such as `gpt-oss-120b` is not newer than GPT 5.6.
 */
function releaseVersion(id: string): number[] {
  const normalized = normalizeModelId(id).toLowerCase()
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
    /^llama-?(\d+(?:\.\d+)*)/,
  ]
  for (const pattern of patterns) {
    const match = normalized.match(pattern)
    if (match?.[1]) return match[1].split(/[.-]/).map(Number)
  }
  return []
}

/**
 * Return a copy sorted for a model menu.
 *
 * Providers keep the shared display order. Within each provider, current
 * generations come first across families. Stable ids win ties with previews.
 * Callers can sort separate sections without changing `featured` or defaults.
 */
export function sortModelsByFreshness(models: readonly CatalogModel[]): CatalogModel[] {
  return [...models].sort((a, b) => {
    const providerA = normalizeProvider(a.provider)
    const providerB = normalizeProvider(b.provider)
    const providerOrder = providerRank(providerA) - providerRank(providerB)
    if (providerOrder !== 0) return providerOrder
    if (providerA !== providerB) return providerA.localeCompare(providerB)

    const generationOrder = compareVersions(releaseVersion(b.id), releaseVersion(a.id))
    if (generationOrder !== 0) return generationOrder

    const previewOrder = Number(/preview/i.test(a.id)) - Number(/preview/i.test(b.id))
    if (previewOrder !== 0) return previewOrder
    return a.id.localeCompare(b.id)
  })
}

/** Lower = preferred representative for an alias group. */
function aliasPenalty(id: string): number {
  let p = 0
  if (id.includes('/')) p += 4
  if (/-\d{8}$|-\d{4}-\d{2}-\d{2}$/.test(id.replace(/:free$/, ''))) p += 2
  if (id.endsWith(':free')) p += 1
  return p
}

function providerRank(provider: string): number {
  const i = PROVIDER_TIER.indexOf(normalizeProvider(provider))
  return i === -1 ? PROVIDER_TIER.length : i
}

/**
 * Can this router entry serve a text chat turn?
 *
 * The router lists every routeable endpoint, which is not the same list a chat
 * picker should show: measured against the live catalogue (504 entries), this
 * rejects 35 — image generators, TTS voices, embedding models, and the
 * audio-IN transcription endpoints (`whisper-1`, `gpt-4o-transcribe`, …) that
 * emit text but cannot take a text prompt.
 *
 * A model whose metadata omits either modality list is KEPT. The router is the
 * source of that metadata and it is occasionally sparse; dropping a usable
 * model because a field is missing is the worse failure of the two.
 *
 * Exported because a picker needs the same answer `buildCatalog` uses — the
 * fleet had this predicate copied into a product component, where its narrower
 * spelling let the 10 transcription endpoints through.
 */
export function isChatCapableModel(m: RouterModel): boolean {
  const arch = m.architecture
  if (!arch?.input_modalities || !arch?.output_modalities) return true
  return arch.input_modalities.includes('text') && arch.output_modalities.includes('text')
}

const isChatModel = isChatCapableModel

function isRouteable(m: RouterModel): boolean {
  const routeability = m.routeability
  if (!routeability) return true
  const chatEndpoint = routeability.endpoints?.chat_completions
  if (chatEndpoint?.routeable === false) return false
  if (chatEndpoint?.status !== undefined && chatEndpoint.status !== 'routeable') return false
  if (routeability.routeable === true || routeability.status === 'routeable') return true
  if (routeability.routeable === false) return false
  return routeability.status === undefined
}

/** Find a catalogue row by direct or provider-prefixed model id. */
export function catalogModelForId(
  models: readonly CatalogModel[],
  requestedId: string | undefined,
): CatalogModel | undefined {
  const requested = requestedId?.trim()
  if (!requested) return undefined

  const exact = models.find((model) => model.id === requested)
  if (exact) return exact

  const slash = requested.indexOf('/')
  const requestedProvider = slash > 0 ? normalizeProvider(requested.slice(0, slash)) : undefined
  const normalized = normalizeModelId(requested)
  return models.find((model) => {
    if (normalizeModelId(model.id) !== normalized) return false
    return requestedProvider === undefined || normalizeProvider(model.provider) === requestedProvider
  })
}

/**
 * Reconcile a persisted selection against the live catalogue.
 *
 * The returned id is always a catalogue id once the catalogue has entries.
 * This keeps a removed model from remaining selected while preserving the
 * current value during the brief empty/loading state.
 */
export function resolveCatalogModelId(
  models: readonly CatalogModel[],
  selectedId?: string,
  fallbackId?: string,
): string | undefined {
  if (models.length === 0) return selectedId?.trim() || fallbackId?.trim()
  return catalogModelForId(models, selectedId)?.id
    ?? catalogModelForId(models, fallbackId)?.id
    ?? models[0]?.id
}

/**
 * Pure catalogue pipeline. `preferredDefault` (typically the MODEL_NAME env
 * var) wins when it survives filtering; otherwise the first featured model.
 */
export function buildCatalog(raw: RouterModel[], opts?: { preferredDefault?: string }): ModelCatalog {
  // Filter to chat-capable, routeable, non-specialty models
  const candidates = raw.filter(
    (m) =>
      m.id &&
      isRouteable(m) &&
      isChatModel(m) &&
      !EXCLUDED_ID.test(normalizeModelId(m.id)),
  )

  // Dedupe alias groups (dated snapshots, provider prefixes, :free variants).
  // Within a group, merge metadata so the representative keeps the richest
  // supported_parameters claim (snapshots often omit what the parent lists).
  const groups = new Map<string, RouterModel[]>()
  for (const m of candidates) {
    const key = `${providerForModel(m)}::${normalizeModelId(m.id)}`
    const g = groups.get(key)
    if (g) g.push(m)
    else groups.set(key, [m])
  }

  const reps: Array<{ model: RouterModel; normId: string; mergedParams: Set<string> }> = []
  for (const group of groups.values()) {
    group.sort((a, b) => aliasPenalty(a.id) - aliasPenalty(b.id) || a.id.length - b.id.length)
    const rep = group[0]!
    const mergedParams = new Set<string>(group.flatMap((m) => m.supported_parameters ?? []))
    reps.push({ model: rep, normId: normalizeModelId(rep.id), mergedParams })
  }

  // Resolve the default independently from menu recommendations.
  const defaultCandidateIds: string[] = []
  for (const rule of DEFAULT_CANDIDATE_RULES) {
    const matches = reps.filter(
      (r) =>
        rule.providers.map(normalizeProvider).includes(providerForModel(r.model)) &&
        rule.match.test(r.normId) &&
        !defaultCandidateIds.includes(r.model.id),
    )
    if (!matches.length) continue
    matches.sort(
      (a, b) =>
        compareVersions(versionOf(b.normId), versionOf(a.normId)) ||
        Number(a.normId.includes('preview')) - Number(b.normId.includes('preview')) ||
        a.model.id.length - b.model.id.length,
    )
    defaultCandidateIds.push(matches[0]!.model.id)
  }

  const toCatalogModel = (r: (typeof reps)[number]): CatalogModel => {
    const m = r.model
    const provider = providerForModel(m)
    return {
      id: m.id,
      name: m.name ?? m.id,
      provider,
      description: m.description ? m.description.slice(0, 160) : undefined,
      contextLength: m.context_length,
      pricing:
        m.pricing?.prompt || m.pricing?.completion
          ? { prompt: m.pricing.prompt ?? undefined, completion: m.pricing.completion ?? undefined }
          : undefined,
      supportsTools: r.mergedParams.has('tools') || TOOL_CAPABLE_FAMILY.test(r.normId),
      supportsReasoning: r.mergedParams.has('reasoning') || r.mergedParams.has('include_reasoning'),
      featured: false,
    }
  }

  // Family rules retain the intentional default preference. Display order is
  // independent: every catalogue consumer gets provider-grouped freshness,
  // even when it does not render ModelPicker.
  const defaultCandidatesInRuleOrder = defaultCandidateIds
    .map((id) => reps.find((r) => r.model.id === id)!)
    .map(toCatalogModel)
  const sorted = sortModelsByFreshness(reps.map(toCatalogModel))
  const recommendedIds = new Set<string>()
  const seenProviders = new Set<string>()
  for (const model of sorted) {
    const provider = normalizeProvider(model.provider)
    if (providerRank(provider) >= PROVIDER_TIER.length) continue
    if (seenProviders.has(provider)) continue
    seenProviders.add(provider)
    recommendedIds.add(model.id)
    if (recommendedIds.size >= MAX_RECOMMENDED_MODELS) break
  }
  const models = sorted.map((model) =>
    recommendedIds.has(model.id) ? { ...model, featured: true } : model,
  )

  const preferred = opts?.preferredDefault
  const defaultModelId =
    (preferred && models.find((m) => m.id === preferred || normalizeModelId(m.id) === normalizeModelId(preferred))?.id) ||
    defaultCandidatesInRuleOrder.find((m) => m.supportsTools)?.id ||
    models[0]?.id ||
    null

  return { defaultModelId, fetchedAt: new Date().toISOString(), models }
}

// ── Cached fetch ─────────────────────────────────────────────────────────

const CATALOG_TTL_MS = 5 * 60 * 1000

let _cache: { catalog: ModelCatalog; at: number } | null = null

/**
 * Fetch the router model list and build the catalogue, with an in-isolate
 * cache (TTL 5 min). On router failure a stale catalogue is served rather
 * than erroring the picker.
 */
export async function fetchModelCatalog(cfg: {
  baseUrl: string
  apiKey: string
  preferredDefault?: string
}): Promise<ModelCatalog> {
  if (_cache && Date.now() - _cache.at < CATALOG_TTL_MS) {
    return _cache.catalog
  }
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    })
    if (!res.ok) throw new Error(`Router /models returned ${res.status}`)
    const data = (await res.json()) as { data?: RouterModel[] }
    const catalog = buildCatalog(data.data ?? [], { preferredDefault: cfg.preferredDefault })
    _cache = { catalog, at: Date.now() }
    return catalog
  } catch (err) {
    if (_cache) return _cache.catalog
    throw err
  }
}

/** Test-only: clear the catalogue cache. */
export function __resetCatalogCache(): void {
  _cache = null
}
