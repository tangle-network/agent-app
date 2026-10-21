/**
 * Live model routing by allow-list — the positive form of `model_not_allowed`.
 *
 * A scoped key (QA keys, delegated child keys, provisioned product keys)
 * carries an allowed-model set. The router enforces it as a wall:
 *
 *   400 model_not_allowed — `Model "gpt-6-luna" is not in this key's
 *   allow-list. Allowed: glm-5.3, glm-5-turbo.`
 *
 * The refusal already NAMES the allowed set — so a product can treat the
 * allow-list as routing information instead of a dead end: parse the set,
 * pick the first preferred model it permits, and retry. Combined with the
 * router's key-info endpoint (which exposes `allowed_models` before the
 * first refusal), a product can route right the first time.
 *
 * Fail-closed by design: when no preferred model is allowed, the resolver
 * returns `status: 'refused'` with the allowed set — the caller surfaces a
 * named refusal (via {@link formatModelNotAllowedRefusal}) rather than
 * silently downgrading to an arbitrary model. A different model is a
 * different decision-maker; the product's fallback ORDER is a product
 * decision, and this module only executes it.
 */

/** Parse the allowed-model set out of a router `model_not_allowed` refusal.
 *  Both refusal shapes name the set after `Allowed:` —
 *  `Model "x" is not in this key's allow-list. Allowed: a, b, c.` and
 *  `Fallback model(s) "x" are not in this key's allow-list. Allowed: a, b.`
 *  Returns null when the message carries no set (an unexpected shape — do
 *  not guess). */
export function parseModelNotAllowed(message: string): string[] | null {
  const match = /Allowed:\s*([^\n]+?)(?:\.\s*)?$/.exec(message)
  if (!match?.[1]) return null
  const allowed = match[1].split(',').map((id) => id.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
  return allowed.length > 0 ? allowed : null
}

export interface ResolveModelWithinAllowListInput {
  /** The model the product wants to run. */
  readonly requested: string
  /** The key's allowed-model set (empty/absent = the key is unscoped; the
   *  request stands). */
  readonly allowedModels?: readonly string[] | null
  /** The product's reroute order when `requested` is blocked — tried in
   *  order, first allowed wins. */
  readonly fallbacks?: readonly string[]
}

export type ModelWithinAllowListResolution =
  | { readonly status: 'allowed'; readonly model: string; readonly rerouted: false }
  | { readonly status: 'rerouted'; readonly model: string; readonly rerouted: true; readonly blockedModel: string }
  | { readonly status: 'refused'; readonly model: null; readonly allowedModels: readonly string[] }

/** Resolve a model request against the key's allow-list:
 *  unscoped → allowed as-is; requested permitted → allowed; a fallback
 *  permitted → rerouted (named); nothing permitted → refused with the set. */
export function resolveModelWithinAllowList(input: ResolveModelWithinAllowListInput): ModelWithinAllowListResolution {
  const allowed = input.allowedModels
  if (!allowed || allowed.length === 0) {
    return { status: 'allowed', model: input.requested, rerouted: false }
  }
  if (allowed.includes(input.requested)) {
    return { status: 'allowed', model: input.requested, rerouted: false }
  }
  const fallback = (input.fallbacks ?? []).find((id) => allowed.includes(id))
  if (fallback !== undefined) {
    return { status: 'rerouted', model: fallback, rerouted: true, blockedModel: input.requested }
  }
  return { status: 'refused', model: null, allowedModels: allowed }
}

/** Format the loud, correctable refusal: the blocked model, the allowed set,
 *  and the fix. Mirrors the router's own refusal text so both layers name
 *  the same fact. */
export function formatModelNotAllowedRefusal(input: {
  requested: string
  allowedModels: readonly string[]
}): string {
  return (
    `Model "${input.requested}" is not in this key's allow-list. ` +
    `Allowed: ${input.allowedModels.join(', ')}. ` +
    'Route to an allowed model or widen the key\u2019s allow-list.'
  )
}
