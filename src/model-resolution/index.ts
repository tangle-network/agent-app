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
 *   An optional `policy` (see ../policy-filters) layers product admission policy
 *   over EVERY admission path — allowlist, env, and catalog alike — so a
 *   policy-filtered deployment (e.g. HIPAA: zero-data-retention, BAA-eligible
 *   models only) cannot be bypassed through an operator-trusted lane. With a
 *   policy configured, a model carrying no policy metadata is refused.
 */

import {
  checkModelPolicy,
  type ModelPolicy,
  type ModelPolicyInfo,
} from '../policy-filters/index'

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

/** Define possible origins for the chat model configuration values */
export type ChatModelSource = 'request' | 'workspace' | 'env' | 'default'

/** Resolve a chat model with its identifier and source information */
export interface ResolvedChatModel {
  model: string
  source: ChatModelSource
}

/** Represent successful chat model validation with a true status and a validated string value */
export interface ChatModelValidationSuccess {
  succeeded: true
  value: string
}

/** Describe a failed chat model validation result with an error message */
export interface ChatModelValidationFailure {
  succeeded: false
  error: string
}

/** Resolve the outcome of validating a chat model as either success or failure */
export type ChatModelValidationResult = ChatModelValidationSuccess | ChatModelValidationFailure

/** The catalog-fetch boundary: maps a router base URL to the raw model list. */
export type LoadModels = (routerBaseUrl: string) => Promise<ModelInfo[]>

/** Resolve the effective chat model input by prioritizing request, workspace, environment, and default models */
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

/** Define input parameters for validating chat model IDs with optional allowlist and catalog access details */
export interface ValidateChatModelIdInput {
  /** Ids accepted without a catalog round-trip (defaults + operator-trusted). */
  allowlist?: Iterable<string>
  /** The operator-set env model value — always admitted (operator-trusted). */
  envModel?: string
  /** Catalog loader; required to reach the catalog path. */
  loadModels?: LoadModels
  /** Catalog endpoint base; required to reach the catalog path. */
  routerBaseUrl?: string
  /** Product admission policy, evaluated AFTER availability on EVERY admission
   *  path (allowlist, env, catalog). Fail-closed: a validated model with no
   *  policy metadata in `catalog` is refused. */
  policy?: ModelPolicy
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
  // Policy composes with availability: an id is admitted only when it is
  // available AND (no policy configured OR the policy admits it). The policy
  // runs on every lane, so the operator-trusted allowlist/env paths cannot
  // bypass a deployment's admission policy.
  const admit = async (value: string): Promise<ChatModelValidationResult> => {
    if (!input.policy) return { succeeded: true, value }
    const decision = await checkModelPolicy(value, input.policy.catalog, input.policy.filter, input.policy.context)
    if (!decision.allowed) return { succeeded: false, error: decision.reason }
    return { succeeded: true, value }
  }

  const cleaned = cleanModelId(modelId)
  if (!cleaned) return { succeeded: false, error: 'Model id must be a non-empty string.' }
  if (!isWellFormedModelId(cleaned)) return { succeeded: false, error: `Model id is malformed: ${cleaned}` }

  const allowed = new Set(input.allowlist ?? [])
  if (allowed.has(cleaned)) return admit(cleaned)

  // The operator-set env model is trusted without a catalog round-trip.
  if (cleanModelId(input.envModel) === cleaned) return admit(cleaned)

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
  if (ids.has(cleaned)) return admit(cleaned)

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
    if (matches && matches.length === 1) return admit(matches[0]!)
  }

  return { succeeded: false, error: `Model is not available: ${cleaned}` }
}

/** Resolve and return a trimmed string model ID or undefined for invalid or empty input */
export function cleanModelId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Validate if a model ID string conforms to length and character format requirements */
export function isWellFormedModelId(modelId: string): boolean {
  if (modelId.length > 200) return false
  return /^[A-Za-z0-9._/@:-]+$/.test(modelId)
}

/** Resolve unique catalog IDs associated with a given model including its canonical form if applicable */
export function catalogIdsForModel(model: ModelInfo): string[] {
  const ids = new Set<string>()
  if (typeof model.id === 'string' && model.id.trim()) ids.add(model.id.trim())
  if (typeof model.id === 'string' && model.id.trim() && !model.id.includes('/')) {
    const canonical = canonicalModelId(model)
    if (canonical.includes('/')) ids.add(canonical)
  }
  return [...ids]
}

/**
 * A router `/v1/models` row carrying the compliance flags
 * {@link modelPolicyCatalogFromRouter} reads. The router spells them
 * snake_case; the policy catalog spells them camelCase (`ModelPolicyInfo`).
 */
export interface RouterModelPolicyRow extends ModelInfo {
  /** The provider retains no prompt/response data for this model. */
  zdr?: boolean
  /** The vendor will sign a BAA covering this model. */
  hipaa_eligible?: boolean
}

/**
 * Map router `/v1/models` rows to a {@link ModelPolicyInfo} catalog: snake_case
 * `zdr` / `hipaa_eligible` become `zeroDataRetention` / `hipaaEligible`, and
 * `provider` comes from the row's `_provider`/`provider`.
 *
 * GRANULARITY: the flags are trusted VERBATIM, per row, at whatever
 * granularity the router publishes them. A ZDR/BAA attestation is commonly a
 * provider-wide vendor fact, but this mapper never infers one model's
 * eligibility from a sibling's — a row that omits a flag yields `undefined`
 * for it, and a filter reading `=== true` refuses that row (fail closed). If
 * your attestation is provider-wide, publish it on every row upstream rather
 * than asking the mapper to guess.
 *
 * ID KEYING: one entry is emitted per spelling {@link catalogIdsForModel}
 * yields (the bare id AND its provider-prefixed canonical form), so a turn
 * carrying either spelling classifies — lookups in `/policy-filters` are
 * exact-string and never normalize. Rows with a blank/non-string id are
 * skipped. Duplicate ids across rows are a product bug (see
 * `indexPolicyCatalog`).
 */
export function modelPolicyCatalogFromRouter(rows: Iterable<RouterModelPolicyRow>): ModelPolicyInfo[] {
  const catalog: ModelPolicyInfo[] = []
  for (const row of rows) {
    if (typeof row.id !== 'string' || !row.id.trim()) continue
    const provider = row._provider ?? row.provider
    const flags = {
      ...(typeof row.zdr === 'boolean' ? { zeroDataRetention: row.zdr } : {}),
      ...(typeof row.hipaa_eligible === 'boolean' ? { hipaaEligible: row.hipaa_eligible } : {}),
    }
    for (const id of catalogIdsForModel(row)) {
      catalog.push({ id, ...(provider ? { provider } : {}), ...flags })
    }
  }
  return catalog
}

// Live model routing by allow-list: the positive form of model_not_allowed.
// Parse the set the router's refusal already names, reroute within the
// product's fallback order, or refuse loudly naming the set.
export {
  parseModelNotAllowed,
  resolveModelWithinAllowList,
  formatModelNotAllowedRefusal,
  type ResolveModelWithinAllowListInput,
  type ModelWithinAllowListResolution,
} from './allow-list'

// Reactive failover for the case validation cannot catch: a model that IS in the
// catalog but whose upstream is down. Catalog membership is not liveness.
export {
  isUpstreamUnavailable,
  readHttpStatusHint,
  runWithModelFailover,
  buildModelChain,
  ModelFailoverExhaustedError,
  UPSTREAM_UNAVAILABLE_CODES,
  UPSTREAM_UNAVAILABLE_STATUSES,
  type ModelFailoverAttempt,
  type ModelFailoverResult,
  type RunWithModelFailoverInput,
} from './failover'
