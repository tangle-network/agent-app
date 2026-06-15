/**
 * Canonical chat-model resolution — identical across every agent app.
 *
 * The ONLY per-app inputs are DATA, never logic: the default model, the
 * allowlist, the env value the deployment set, and the catalog-fetch loader.
 * The logic is one precedence ladder + one fail-closed validator that every
 * product uses the same way — there is no per-product variant, no env-var name
 * baked in, and no backend dimension (router-vs-sandbox is the harness/dispatch
 * concern, not model resolution; a sandbox's provider default lives in the
 * sandbox subpath).
 *
 * - resolveChatModel: request > workspace > env > default. The product reads its
 *   own deploy env var and passes the VALUE as `envModel`; the shell knows no
 *   env-var names. Source is canonical: 'request' | 'workspace' | 'env' | 'default'.
 * - validateChatModelId: fail-closed. Admit an id that is in the allowlist, or
 *   equals the operator-set env model, or is served by the live router catalog
 *   (exact, or a bare id resolved to its canonical id when the suffix is unique).
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

export type ChatModelSource = 'request' | 'workspace' | 'env' | 'default'

export interface ResolvedChatModel {
  model: string
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

export interface ResolveChatModelInput {
  /** Per-request override (highest precedence). */
  requestModel?: string
  /** Persisted workspace-pinned model. */
  workspaceModel?: string
  /** The value the deployment's model env var holds (the product reads its own
   *  var name and passes the value — the shell stays env-var-name agnostic). */
  envModel?: string
  /** Final fallback (the product's default, typically profile.model.default). */
  defaultModel: string
}

/** Resolve the chat-turn model by the one canonical precedence. Blank values are
 *  treated as absent. */
export function resolveChatModel(input: ResolveChatModelInput): ResolvedChatModel {
  const request = cleanModelId(input.requestModel)
  if (request) return { model: request, source: 'request' }
  const workspace = cleanModelId(input.workspaceModel)
  if (workspace) return { model: workspace, source: 'workspace' }
  const env = cleanModelId(input.envModel)
  if (env) return { model: env, source: 'env' }
  return { model: input.defaultModel, source: 'default' }
}

export interface ValidateChatModelIdInput {
  /** Ids accepted without a catalog round-trip (defaults + operator-trusted). */
  allowlist?: Iterable<string>
  /** The operator-set env model value — always admitted (operator-trusted). */
  envModel?: string
  /** Catalog loader; required to reach the catalog path. */
  loadModels?: LoadModels
  /** Catalog endpoint base; required to reach the catalog path. */
  routerBaseUrl?: string
}

/**
 * Fail-closed model-id validation. Accepts an id only when it is well-formed AND
 * (in the allowlist, or equals the operator-set env model, or served by the live
 * catalog). A bare id (no provider prefix) resolves to its canonical id only when
 * the suffix is unique across the catalog — an ambiguous suffix is rejected
 * rather than silently assigned a provider.
 */
export async function validateChatModelId(
  modelId: unknown,
  input: ValidateChatModelIdInput,
): Promise<ChatModelValidationResult> {
  const cleaned = cleanModelId(modelId)
  if (!cleaned) return { succeeded: false, error: 'Model id must be a non-empty string.' }
  if (!isWellFormedModelId(cleaned)) return { succeeded: false, error: `Model id is malformed: ${cleaned}` }

  const allowed = new Set(input.allowlist ?? [])
  if (allowed.has(cleaned)) return { succeeded: true, value: cleaned }

  // The operator-set env model is trusted without a catalog round-trip.
  if (cleanModelId(input.envModel) === cleaned) return { succeeded: true, value: cleaned }

  if (!input.loadModels || typeof input.routerBaseUrl !== 'string' || input.routerBaseUrl.length === 0) {
    return { succeeded: false, error: `Model is not available: ${cleaned}` }
  }

  let catalog: ModelInfo[]
  try {
    catalog = await input.loadModels(input.routerBaseUrl)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { succeeded: false, error: `Could not validate model catalog: ${message}` }
  }

  const ids = new Set(catalog.flatMap(catalogIdsForModel))
  if (ids.has(cleaned)) return { succeeded: true, value: cleaned }

  if (!cleaned.includes('/')) {
    const canonicalBySuffix = new Map<string, string[]>()
    for (const model of catalog) {
      if (typeof model.id !== 'string' || !model.id.trim()) continue
      const canonical = canonicalModelId(model)
      if (!canonical.includes('/')) continue
      const suffix = canonical.split('/').slice(1).join('/')
      const entries = canonicalBySuffix.get(suffix)
      if (entries) entries.push(canonical)
      else canonicalBySuffix.set(suffix, [canonical])
    }
    const matches = canonicalBySuffix.get(cleaned)
    if (matches && matches.length === 1) return { succeeded: true, value: matches[0]! }
  }

  return { succeeded: false, error: `Model is not available: ${cleaned}` }
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
  return [...ids]
}
