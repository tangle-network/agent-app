/**
 * Policy filters — product-supplied admission policy over the models,
 * harnesses, and agent profiles a deployment will run.
 *
 * The engine owns the MECHANISM (a typed predicate, combinators, a fail-closed
 * enforcement seam, a catalog filter for pickers); the product owns the POLICY
 * (the metadata and the filter), supplied as data. Nothing here names a vendor,
 * a regulation, or a product — a HIPAA deployment's "zero-data-retention,
 * BAA-eligible models only" rule is one `PolicyFilter` over product-supplied
 * `ModelPolicyInfo`, and any other restriction composes the same way.
 *
 * Fail-closed contract, everywhere this module decides:
 *
 * - An item with NO policy metadata is refused (enforcement) or hidden
 *   (catalog filter). A policy that cannot classify an item does not admit it.
 * - A filter that THROWS is a refusal, never an admission — a broken policy
 *   check fails the turn instead of waving it through.
 * - Enforcement composes with availability, never replaces it: the
 *   `model-resolution` seam applies the policy AFTER its existing
 *   allowlist/env/catalog admission, on every path — a policy-filtered
 *   deployment cannot be bypassed through an operator-trusted lane.
 *
 * Browser-safe and dependency-free by construction: no imports at all, so UI
 * pickers (docs/ui-picker-canon.md) can filter the catalog they pass to
 * `ModelPicker` with the same filter the server enforces.
 */

/** Arbitrary context a product threads to its filters (workspace, user, turn). */
export type PolicyFilterContext = Record<string, unknown>

/**
 * A typed admission predicate over one catalog item. May be async (a product
 * can read its metadata from storage). Returning `false` denies; THROWING
 * denies too — enforcement treats a filter error as a refusal.
 */
export type PolicyFilter<T, C extends object = PolicyFilterContext> = (
  item: T,
  context: C,
) => boolean | Promise<boolean>

/** Admit only items every filter admits. An empty `allOf` admits everything. */
export function allOf<T, C extends object = PolicyFilterContext>(
  ...filters: Array<PolicyFilter<T, C>>
): PolicyFilter<T, C> {
  return async (item, context) => {
    for (const filter of filters) {
      if (!(await filter(item, context))) return false
    }
    return true
  }
}

/** Admit items at least one filter admits. An empty `anyOf` admits nothing. */
export function anyOf<T, C extends object = PolicyFilterContext>(
  ...filters: Array<PolicyFilter<T, C>>
): PolicyFilter<T, C> {
  return async (item, context) => {
    for (const filter of filters) {
      if (await filter(item, context)) return true
    }
    return false
  }
}

/**
 * Policy metadata for one model — DATA the product supplies (from its router
 * catalog, a compliance review, a vendor attestation), never engine policy.
 * The named fields are the common compliance dimensions; the index signature
 * carries any product-specific attribute a filter reads.
 */
export interface ModelPolicyInfo {
  id: string
  provider?: string
  /** The provider retains no prompt/response data for this model. */
  zeroDataRetention?: boolean
  /** The vendor will sign a BAA covering this model. */
  hipaaEligible?: boolean
  [attribute: string]: unknown
}

/** Policy metadata for one harness (the coding-agent CLI a sandbox drives). */
export interface HarnessPolicyInfo {
  id: string
  provider?: string
  zeroDataRetention?: boolean
  hipaaEligible?: boolean
  [attribute: string]: unknown
}

/** Policy metadata for one agent profile. */
export interface ProfilePolicyInfo {
  id: string
  model?: string
  harness?: string
  zeroDataRetention?: boolean
  hipaaEligible?: boolean
  [attribute: string]: unknown
}

/**
 * Where enforcement reads an item's metadata: an in-memory iterable, or a
 * lookup (sync or async) keyed by the item's id. Returning `undefined` means
 * UNCLASSIFIED — enforcement refuses the item.
 */
export type PolicyCatalog<T extends { id: string }> =
  | Iterable<T>
  | ((id: string) => T | undefined | Promise<T | undefined>)

/** Why a policy check refused, machine-readable on the result and on {@link PolicyDeniedError}. */
export type PolicyDeniedCode = 'policy-metadata-missing' | 'policy-denied' | 'policy-filter-error'

/** The outcome of one policy check. Admission carries the item's metadata; a refusal carries a code and a reason. */
export type PolicyCheckResult<T = unknown> =
  | { allowed: true; info: T }
  | { allowed: false; code: PolicyDeniedCode; reason: string }

/** The error {@link assertPolicy} throws on any refusal. */
export class PolicyDeniedError extends Error {
  readonly code: PolicyDeniedCode
  readonly kind: string
  readonly id: string

  constructor(code: PolicyDeniedCode, kind: string, id: string, reason: string) {
    super(reason)
    this.name = 'PolicyDeniedError'
    this.code = code
    this.kind = kind
    this.id = id
  }
}

/** Input to one policy check: what is being admitted, from which catalog, under which filter. */
export interface PolicyCheckInput<T extends { id: string }, C extends object = PolicyFilterContext> {
  /** What is being admitted ('model' | 'harness' | 'profile' | …) — names the refusal. */
  kind: string
  /** The id being admitted. */
  id: string
  /** The product's policy metadata. */
  catalog: PolicyCatalog<T>
  /** The product's admission filter. */
  filter: PolicyFilter<T, C>
  /** Threaded to the filter unchanged. */
  context?: C
}

async function lookupPolicyInfo<T extends { id: string }>(
  catalog: PolicyCatalog<T>,
  id: string,
): Promise<T | undefined> {
  if (typeof catalog === 'function') return catalog(id)
  for (const entry of catalog) {
    if (entry.id === id) return entry
  }
  return undefined
}

function refusal<T>(kind: string, id: string, code: PolicyDeniedCode, detail: string): PolicyCheckResult<T> {
  return { allowed: false, code, reason: `${kind} "${id}" is not admitted by policy: ${detail}` }
}

/**
 * Fail-closed policy check. Admits only when the catalog classifies the id AND
 * the filter accepts it. Unclassified ids and filter errors refuse.
 */
export async function checkPolicy<T extends { id: string }, C extends object = PolicyFilterContext>(
  input: PolicyCheckInput<T, C>,
): Promise<PolicyCheckResult<T>> {
  const context = input.context ?? ({} as C)
  let info: T | undefined
  try {
    info = await lookupPolicyInfo(input.catalog, input.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return refusal(input.kind, input.id, 'policy-filter-error', `the policy catalog could not be read (${message})`)
  }
  if (!info) return refusal(input.kind, input.id, 'policy-metadata-missing', 'no policy metadata classifies it')
  let admitted: boolean
  try {
    admitted = await input.filter(info, context)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return refusal(input.kind, input.id, 'policy-filter-error', `the policy filter errored (${message})`)
  }
  return admitted
    ? { allowed: true, info }
    : refusal(input.kind, input.id, 'policy-denied', 'the policy filter rejected it')
}

/**
 * The throwing form of {@link checkPolicy} for enforcement seams that fail by
 * exception. Resolves with the item's metadata on admission; throws
 * {@link PolicyDeniedError} on any refusal.
 */
export async function assertPolicy<T extends { id: string }, C extends object = PolicyFilterContext>(
  input: PolicyCheckInput<T, C>,
): Promise<T> {
  const result = await checkPolicy(input)
  if (!result.allowed) throw new PolicyDeniedError(result.code, input.kind, input.id, result.reason)
  return result.info
}

/** Policy check over a model id. See {@link checkPolicy}. */
export function checkModelPolicy<C extends object = PolicyFilterContext>(
  id: string,
  catalog: PolicyCatalog<ModelPolicyInfo>,
  filter: PolicyFilter<ModelPolicyInfo, C>,
  context?: C,
): Promise<PolicyCheckResult<ModelPolicyInfo>> {
  return checkPolicy({ kind: 'model', id, catalog, filter, context })
}

/** Policy check over a harness id. See {@link checkPolicy}. */
export function checkHarnessPolicy<C extends object = PolicyFilterContext>(
  id: string,
  catalog: PolicyCatalog<HarnessPolicyInfo>,
  filter: PolicyFilter<HarnessPolicyInfo, C>,
  context?: C,
): Promise<PolicyCheckResult<HarnessPolicyInfo>> {
  return checkPolicy({ kind: 'harness', id, catalog, filter, context })
}

/** Policy check over an agent-profile id. See {@link checkPolicy}. */
export function checkProfilePolicy<C extends object = PolicyFilterContext>(
  id: string,
  catalog: PolicyCatalog<ProfilePolicyInfo>,
  filter: PolicyFilter<ProfilePolicyInfo, C>,
  context?: C,
): Promise<PolicyCheckResult<ProfilePolicyInfo>> {
  return checkPolicy({ kind: 'profile', id, catalog, filter, context })
}

/**
 * Browser-safe catalog filter for pickers: keep only items the policy admits.
 * Items the catalog does not classify are dropped — a picker offers exactly
 * what a turn would run, and no more. Per docs/ui-picker-canon.md the picker
 * itself still reconciles an absent SAVED value under its own name; this
 * filter shapes the offered list, never the saved value.
 */
export async function filterItemsByPolicy<
  Item extends { id: string },
  Info extends { id: string },
  C extends object = PolicyFilterContext,
>(
  items: readonly Item[],
  catalog: PolicyCatalog<Info>,
  filter: PolicyFilter<Info, C>,
  context?: C,
): Promise<Item[]> {
  const admitted: Item[] = []
  for (const item of items) {
    const result = await checkPolicy({ kind: 'catalog item', id: item.id, catalog, filter, context })
    if (result.allowed) admitted.push(item)
  }
  return admitted
}
