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
 *   → rank (provider tier, family, version) → feature (best model per family)
 *   → default (env override or first featured)
 *
 * Freshness is automatic: everything is derived from the live router response,
 * so new models surface as soon as the router lists them. The only static
 * knowledge here is slow-moving: provider display order and family name
 * patterns (e.g. "claude-sonnet-*", "gpt-N"). A new Sonnet or GPT release
 * outranks its predecessor by version comparison with zero code change; only
 * a brand-new *family name* (rare) needs a one-line rule addition.
 */

export interface RouterModel {
  id: string
  name?: string
  description?: string
  _provider?: string
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
  }
}

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
  'moonshotai',
  'moonshot',
  'zai',
  'z-ai',
  'mistral',
  'groq',
  'nvidia',
  'cohere',
  'cerebras',
]

/** Non-chat endpoints that pollute the router list (matched on normalized id). */
const EXCLUDED_ID = /(embedding|tts|transcribe|whisper|audio|realtime|image|lyria|sora|dall-e|moderation|content-safety|search-preview|search-api|deep-research)/

/**
 * Featured families, in display order. Each rule surfaces the highest-version
 * routeable model whose normalized id matches. Patterns anchor on the family
 * name and stop before specialty suffixes (codex, nano, lite, …) so the
 * mainline model wins.
 */
const FEATURED_RULES: Array<{ providers: string[]; match: RegExp }> = [
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

/** Lower = preferred representative for an alias group. */
function aliasPenalty(id: string): number {
  let p = 0
  if (id.includes('/')) p += 4
  if (/-\d{8}$|-\d{4}-\d{2}-\d{2}$/.test(id.replace(/:free$/, ''))) p += 2
  if (id.endsWith(':free')) p += 1
  return p
}

function providerRank(provider: string): number {
  const i = PROVIDER_TIER.indexOf(provider)
  return i === -1 ? PROVIDER_TIER.length : i
}

function isChatModel(m: RouterModel): boolean {
  const arch = m.architecture
  if (!arch?.input_modalities || !arch?.output_modalities) return true
  return arch.input_modalities.includes('text') && arch.output_modalities.includes('text')
}

function isRouteable(m: RouterModel): boolean {
  return m.routeability?.routeable !== false && m.routeability?.status !== 'unavailable'
}

function familyOf(normId: string): string {
  return normId.replace(/[\d.]+/g, '').replace(/-+/g, '-').replace(/-$/, '')
}

/**
 * Pure catalogue pipeline. `preferredDefault` (typically the MODEL_NAME env
 * var) wins when it survives filtering; otherwise the first featured model.
 */
export function buildCatalog(raw: RouterModel[], opts?: { preferredDefault?: string }): ModelCatalog {
  // Filter to chat-capable, routeable, non-specialty models
  const candidates = raw.filter(
    (m) => m.id && isRouteable(m) && isChatModel(m) && !EXCLUDED_ID.test(normalizeModelId(m.id)),
  )

  // Dedupe alias groups (dated snapshots, provider prefixes, :free variants).
  // Within a group, merge metadata so the representative keeps the richest
  // supported_parameters claim (snapshots often omit what the parent lists).
  const groups = new Map<string, RouterModel[]>()
  for (const m of candidates) {
    const key = `${m._provider ?? ''}::${normalizeModelId(m.id)}`
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

  // Featured: best version per family rule, in rule order
  const featuredIds: string[] = []
  for (const rule of FEATURED_RULES) {
    const matches = reps.filter(
      (r) =>
        rule.providers.includes(r.model._provider ?? '') &&
        rule.match.test(r.normId) &&
        !featuredIds.includes(r.model.id),
    )
    if (!matches.length) continue
    matches.sort(
      (a, b) =>
        compareVersions(versionOf(b.normId), versionOf(a.normId)) ||
        Number(a.normId.includes('preview')) - Number(b.normId.includes('preview')) ||
        a.model.id.length - b.model.id.length,
    )
    featuredIds.push(matches[0]!.model.id)
  }

  const toCatalogModel = (r: (typeof reps)[number]): CatalogModel => {
    const m = r.model
    const provider = m._provider ?? 'unknown'
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
      featured: featuredIds.includes(m.id),
    }
  }

  // Sort: featured first (rule order), then provider tier → family → version desc
  const featured = featuredIds
    .map((id) => reps.find((r) => r.model.id === id)!)
    .map(toCatalogModel)
  const rest = reps
    .filter((r) => !featuredIds.includes(r.model.id))
    .sort((a, b) => {
      const pa = providerRank(a.model._provider ?? '')
      const pb = providerRank(b.model._provider ?? '')
      if (pa !== pb) return pa - pb
      const fa = familyOf(a.normId)
      const fb = familyOf(b.normId)
      if (fa !== fb) return fa.localeCompare(fb)
      return compareVersions(versionOf(b.normId), versionOf(a.normId)) || a.model.id.localeCompare(b.model.id)
    })
    .map(toCatalogModel)

  const models = [...featured, ...rest]

  const preferred = opts?.preferredDefault
  const defaultModelId =
    (preferred && models.find((m) => m.id === preferred || normalizeModelId(m.id) === normalizeModelId(preferred))?.id) ||
    featured.find((m) => m.supportsTools)?.id ||
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
