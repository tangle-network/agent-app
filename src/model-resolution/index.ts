/**
 * Chat-time model resolution: a precedence resolver and a fail-closed catalog
 * validator that sit on top of a product's boot-time model config.
 *
 * `resolveChatModel` picks the model id for a chat turn by precedence:
 *   request id > env MODEL_NAME > provider default > sandbox default.
 *
 * `validateChatModelId` is the fail-closed gate: it returns a typed outcome and
 * accepts an id only if it is in the constructed allowlist OR served by the live
 * router catalog (loaded through an injected boundary). A bare id with no
 * provider prefix resolves to its canonical id only when the suffix is unique
 * across the catalog, so an ambiguous suffix is rejected rather than silently
 * assigned a provider.
 *
 * The product injects one value — `modelDefaults` — and supplies the catalog
 * loader per call. `ModelInfo` is the router /v1/models wire shape and
 * `canonicalModelId` the bare->prefixed id helper, both defined locally so this
 * engine module carries no UI-package coupling.
 */

/** The router /v1/models entry shape this module reads. Minimal on purpose. */
export interface ModelInfo {
  id: string
  name?: string
  _provider?: string
  provider?: string
}

/** Canonical (provider-prefixed) id for a catalog entry: pass through an id that
 *  already carries a provider, else prefix the entry's provider when present. */
function canonicalModelId(model: ModelInfo): string {
  if (model.id.includes('/')) return model.id
  const provider = model._provider ?? model.provider
  return provider ? `${provider}/${model.id}` : model.id
}

/** Which execution path the chat turn runs on. Product-supplied per turn. */
export type ChatBackend = 'router' | 'sandbox'

export type ChatModelSource =
  | 'request'
  | 'env:MODEL_NAME'
  | 'default'
  | 'sandbox-default'

export interface ResolvedChatModel {
  backend: ChatBackend
  model?: string
  source: ChatModelSource
}

export interface ChatModelValidationSuccess {
  succeeded: true
  value: string
}

export interface ChatModelValidationFailure {
  succeeded: false
  error: string
}

export type ChatModelValidationResult = ChatModelValidationSuccess | ChatModelValidationFailure

/** The catalog-fetch boundary: maps a router base URL to the raw model list. */
export type LoadModels = (routerBaseUrl: string) => Promise<ModelInfo[]>

/**
 * The single product-injected seam.
 *
 * - `routerModel` / `sandboxOpenaiModel`: the two `DEFAULT_*` ids used by the
 *   precedence ladder and seeded into the allowlist.
 * - `routerBaseUrl`: catalog endpoint base; overridable per validate call.
 * - `extraAllowlist`: additional ids accepted without a catalog round-trip.
 */
export interface ChatModelDefaults {
  routerModel: string
  sandboxOpenaiModel: string
  routerBaseUrl?: string
  extraAllowlist?: string[]
}

export interface ResolveChatModelOptions {
  requestedModel?: string
  backend: ChatBackend
  /** Env to read (defaults to process.env). Inject for non-node runtimes. */
  env?: Record<string, string | undefined>
}

export interface ValidateChatModelIdOptions {
  routerBaseUrl?: string
  /** Catalog loader. No default body is baked in; the consumer supplies it. */
  loadModels: LoadModels
}

export interface ChatModelResolution {
  resolveChatModel: (options: ResolveChatModelOptions) => ResolvedChatModel
  validateChatModelId: (
    modelId: unknown,
    options: ValidateChatModelIdOptions,
  ) => Promise<ChatModelValidationResult>
  DEFAULT_ROUTER_MODEL: string
  DEFAULT_SANDBOX_OPENAI_MODEL: string
  DEFAULT_ROUTER_BASE_URL?: string
}

export function createChatModelResolution(defaults: ChatModelDefaults): ChatModelResolution {
  const DEFAULT_ROUTER_MODEL = defaults.routerModel
  const DEFAULT_SANDBOX_OPENAI_MODEL = defaults.sandboxOpenaiModel
  const DEFAULT_ROUTER_BASE_URL = defaults.routerBaseUrl

  const allowlist = new Set(
    [
      DEFAULT_ROUTER_MODEL,
      DEFAULT_SANDBOX_OPENAI_MODEL,
      ...(defaults.extraAllowlist ?? []),
    ].filter((model): model is string => typeof model === 'string' && model.length > 0),
  )

  function resolveChatModel({
    requestedModel,
    backend,
    env = process.env,
  }: ResolveChatModelOptions): ResolvedChatModel {
    const selectedModel = cleanModelId(requestedModel)
    if (selectedModel) return { backend, model: selectedModel, source: 'request' }

    if (backend === 'router') {
      const routerModel = cleanModelId(env.MODEL_NAME)
      return {
        backend,
        model: routerModel ?? DEFAULT_ROUTER_MODEL,
        source: routerModel ? 'env:MODEL_NAME' : 'default',
      }
    }

    const sandboxModel = cleanModelId(env.MODEL_NAME)
    if (sandboxModel) return { backend, model: sandboxModel, source: 'env:MODEL_NAME' }

    const modelProvider = env.MODEL_PROVIDER
      ?? (env.TANGLE_API_KEY ? 'openai-compat' : env.OPENAI_API_KEY ? 'openai' : undefined)
    if (modelProvider === 'openai' || modelProvider === 'openai-compat') {
      return { backend, model: DEFAULT_SANDBOX_OPENAI_MODEL, source: 'default' }
    }

    return { backend, source: 'sandbox-default' }
  }

  async function validateChatModelId(
    modelId: unknown,
    {
      routerBaseUrl = DEFAULT_ROUTER_BASE_URL,
      loadModels,
    }: ValidateChatModelIdOptions,
  ): Promise<ChatModelValidationResult> {
    const cleaned = cleanModelId(modelId)
    if (!cleaned) {
      return { succeeded: false, error: 'Model id must be a non-empty string.' }
    }
    if (!isWellFormedModelId(cleaned)) {
      return { succeeded: false, error: `Model id is malformed: ${cleaned}` }
    }
    if (allowlist.has(cleaned)) {
      return { succeeded: true, value: cleaned }
    }
    if (typeof routerBaseUrl !== 'string' || routerBaseUrl.length === 0) {
      return { succeeded: false, error: 'Router base URL is required to validate against the catalog.' }
    }

    let catalog: ModelInfo[]
    try {
      catalog = await loadModels(routerBaseUrl)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { succeeded: false, error: `Could not validate model catalog: ${message}` }
    }

    // Exact match against any id the catalog serves (canonical or bare).
    const ids = new Set(catalog.flatMap(catalogIdsForModel))
    if (ids.has(cleaned)) {
      return { succeeded: true, value: cleaned }
    }

    // A bare request id (no provider prefix) may name a model the catalog only
    // serves under a provider-prefixed id (e.g. request "gpt-5" -> catalog
    // "openai/gpt-5"). Resolve it to the canonical id the router serves, but only
    // when the bare suffix is unique across the catalog -- an ambiguous suffix
    // (e.g. "openai/x" vs "vertex/x") stays rejected so we never silently pick a
    // provider for the caller.
    if (!cleaned.includes('/')) {
      const canonicalBySuffix = new Map<string, string[]>()
      for (const model of catalog) {
        const canonical = canonicalModelIdOrUndefined(model)
        if (!canonical || !canonical.includes('/')) continue
        const suffix = canonical.split('/').slice(1).join('/')
        const entries = canonicalBySuffix.get(suffix)
        if (entries) entries.push(canonical)
        else canonicalBySuffix.set(suffix, [canonical])
      }
      const matches = canonicalBySuffix.get(cleaned)
      const only = matches && matches.length === 1 ? matches[0] : undefined
      if (only) {
        return { succeeded: true, value: only }
      }
    }

    return { succeeded: false, error: `Model is not available: ${cleaned}` }
  }

  return {
    resolveChatModel,
    validateChatModelId,
    DEFAULT_ROUTER_MODEL,
    DEFAULT_SANDBOX_OPENAI_MODEL,
    DEFAULT_ROUTER_BASE_URL,
  }
}

export function cleanModelId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function isWellFormedModelId(modelId: string): boolean {
  if (modelId.length > 200) return false
  return /^[A-Za-z0-9._/@:-]+$/.test(modelId)
}

export function catalogIdsForModel(model: ModelInfo): string[] {
  const ids = new Set<string>()
  if (typeof model.id === 'string' && model.id.trim()) ids.add(model.id.trim())

  if (typeof model.id === 'string' && model.id.trim() && !model.id.includes('/')) {
    const canonical = canonicalModelId(model)
    if (canonical.includes('/')) ids.add(canonical)
  }

  // The bare suffix of a provider-prefixed id (e.g. "openai/gpt-5" -> "gpt-5")
  // is NOT added here: a bare request id resolves to its canonical id only
  // through the uniqueness-gated path in validateChatModelId, so an ambiguous
  // suffix never slips through as an exact match.
  return [...ids]
}

/** The canonical id for a catalog entry, or undefined when the entry has no id. */
function canonicalModelIdOrUndefined(model: ModelInfo): string | undefined {
  if (typeof model.id !== 'string' || !model.id.trim()) return undefined
  return canonicalModelId(model)
}
