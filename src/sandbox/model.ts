import { trimOrNull } from '../runtime/model'

/** Define configuration options for resolving a provider and its model with optional API keys and routing details */
export interface ProviderResolutionConfig {
  routerBaseUrl?: string
  apiKey?: string
  providerName?: string
  modelName?: string
  defaultModel?: string
  openaiApiKey?: string
  // Opt-in: a resolvable provider+model WITHOUT an api key still yields model
  // metadata (model/provider/baseUrl, no apiKey) instead of undefined. Keyless
  // metadata makes the sandbox platform mint its OWN per-user router key at
  // create (its requiresRouterKey gate), so turns bill the box's billing owner
  // instead of a product-baked shared key. Requires an explicit providerName —
  // provider inference from key presence cannot fire keyless. Default false:
  // a keyless config resolves to undefined exactly as before.
  allowKeylessModel?: boolean
}

/** Represent a fully configured model with optional API key and base URL for sandbox platform integration */
export interface ResolvedModel {
  model: string
  provider: string
  // Omitted only under `allowKeylessModel` — keyless metadata tells the
  // sandbox platform to mint its own per-user router key for the box.
  apiKey?: string
  baseUrl?: string
}

/**
 * Why a model failed to resolve into something transportable to the sandbox
 * platform. `no_provider` — a model id exists but no provider name could be
 * derived (no explicit `providerName`, and no key present to infer one from).
 * `no_api_key` — a provider AND model both resolved, but no credential is
 * configured and the caller did not opt into `allowKeylessModel`.
 */
export type ModelSelectionError = 'no_provider' | 'no_api_key'

/**
 * Which precedence slot supplied the failed/succeeded model id:
 * `override` — the caller's per-turn `{ model }` argument.
 * `config` — `provider.modelName`.
 * `default` — `provider.defaultModel` (only ever consulted for an
 * openai/openai-compat provider shape).
 */
export type ModelSelectionSource = 'override' | 'config' | 'default'

/**
 * A model id was named (by override, config, or default) but is not
 * transportable to the sandbox platform. Carries enough to explain WHY
 * without the caller re-deriving the override/config/default precedence
 * chain itself (that re-derivation is how gtm-agent#665 happened — a caller
 * guessed loudness from the wrong slot and dropped a user-selected model).
 */
export type ModelSelectionFailure =
  | { succeeded: false; error: 'no_provider'; model: string; source: ModelSelectionSource }
  | {
      succeeded: false
      error: 'no_api_key'
      model: string
      provider: string
      source: ModelSelectionSource
    }

/**
 * The three-state outcome of resolving a model: `{ succeeded: true, value:
 * undefined }` means NOTHING was requested (the legitimate box-default
 * configuration — not an error); `{ succeeded: true, value: ResolvedModel }`
 * means a fully transportable model resolved; anything else is a
 * {@link ModelSelectionFailure} — a model WAS named but can't be sent.
 */
export type ModelSelection =
  | { succeeded: true; value: ResolvedModel | undefined }
  | ModelSelectionFailure

/**
 * Resolve a provider + model configuration into a typed three-state outcome
 * that separates "nothing requested" from "something requested but
 * untransportable" — the distinction {@link resolveModel} collapses and the
 * one that caused gtm-agent#665 (a validated user-selected model silently
 * dropped, box default substituted, durable row still recording the user's
 * choice).
 *
 * Precedence (identical to the legacy `resolveModel`, byte-for-byte):
 * provider is computed first (`providerName`, else inferred `openai-compat`
 * from a present key, else inferred `openai` from a present
 * `openaiApiKey`, else unresolved); the model id is `override.model` else
 * `config.modelName` else — ONLY when the provider is `openai` or
 * `openai-compat` — `config.defaultModel`; the api key is
 * `override.modelApiKey` else `config.apiKey` else — only for provider
 * `openai` — `config.openaiApiKey`.
 *
 * Two behavioral deltas from the legacy function:
 *  1. Every string field (`routerBaseUrl`, `apiKey`, `providerName`,
 *     `modelName`, `defaultModel`, `openaiApiKey`, `override.model`,
 *     `override.modelApiKey`) is normalized through {@link trimOrNull} first,
 *     so `''` (and whitespace-only strings) are treated as absent instead of
 *     poisoning the `??` precedence chain — the issue's second stated defect.
 *     This also means a value is trimmed (`' gpt-5 '` resolves to `'gpt-5'`).
 *  2. The outcome is three-state instead of collapsing to `undefined`: no
 *     model derivable from any slot → `{ succeeded: true, value: undefined }`
 *     (still the legitimate "let the box pick its own default" case, NOT an
 *     error); a model id resolved but no provider could be derived → a
 *     `no_provider` failure; a model + provider resolved but no api key (and
 *     `allowKeylessModel` was not set) → a `no_api_key` failure. Both failure
 *     arms carry `source` so a caller can apply a loudness policy without
 *     re-deriving which precedence slot supplied the model.
 */
export function resolveModelSelection(
  config: ProviderResolutionConfig | undefined,
  override?: { model?: string; modelApiKey?: string },
): ModelSelection {
  const c = config ?? {}
  const explicitBaseUrl = trimOrNull(c.routerBaseUrl)
  const explicitApiKey = trimOrNull(override?.modelApiKey) ?? trimOrNull(c.apiKey)
  const providerName = trimOrNull(c.providerName)
  const openaiApiKey = trimOrNull(c.openaiApiKey)
  const provider =
    providerName ?? (explicitApiKey ? 'openai-compat' : openaiApiKey ? 'openai' : undefined)

  const overrideModel = trimOrNull(override?.model)
  const configModel = trimOrNull(c.modelName)
  const defaultModel = trimOrNull(c.defaultModel)
  const modelName =
    overrideModel ??
    configModel ??
    (provider === 'openai' || provider === 'openai-compat' ? defaultModel : null)

  if (!modelName) return { succeeded: true, value: undefined }

  const source: ModelSelectionSource = overrideModel ? 'override' : configModel ? 'config' : 'default'

  if (!provider) return { succeeded: false, error: 'no_provider', model: modelName, source }

  const apiKey = explicitApiKey ?? (provider === 'openai' ? openaiApiKey : undefined)
  if (!apiKey && !c.allowKeylessModel) {
    return { succeeded: false, error: 'no_api_key', model: modelName, provider, source }
  }

  return {
    succeeded: true,
    value: {
      model: modelName,
      provider,
      ...(apiKey ? { apiKey } : {}),
      ...(explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {}),
    },
  }
}

/**
 * Resolve and return the appropriate model configuration based on provider
 * settings and optional overrides.
 *
 * Migration note (intentionally NOT tagged `@deprecated`): this is a thin,
 * source-compatible wrapper over {@link resolveModelSelection} that collapses
 * its three-state outcome back down to `ResolvedModel | undefined`, exactly
 * as before. It stays correct for the common case (no explicit model requested, or a
 * fully-transportable one), but it CANNOT distinguish "nothing was
 * requested" from "a named model could not be transported" — the ambiguity
 * that caused gtm-agent#665. Prefer {@link resolveModelSelection} directly,
 * or {@link requireTransportableModel} for the fail-loud-on-explicit-model
 * policy the internal sandbox callers use. Not tagged `@deprecated`: it
 * remains the correct call for a caller that never sets an explicit
 * override and only wants "the box's default is fine" semantics; a hard
 * deprecation is a later-major decision, not this fix's.
 *
 * The only behavior change on this entry point versus before is the
 * empty-string bugfix that comes free through delegation (issue #302's
 * second defect) — every signature and the `undefined` return semantics are
 * unchanged.
 */
export function resolveModel(
  config: ProviderResolutionConfig | undefined,
  override?: { model?: string; modelApiKey?: string },
): ResolvedModel | undefined {
  const selection = resolveModelSelection(config, override)
  return selection.succeeded ? selection.value : undefined
}

/**
 * Thrown by {@link requireTransportableModel} when a model that was
 * EXPLICITLY requested — via a per-turn override or a configured
 * `provider.modelName` — cannot be transported to the sandbox platform. The
 * message names the model, which precedence slot supplied it, what's
 * missing, and the fix, and states plainly that the requested model was NOT
 * sent to the box (the failure mode this error exists to make impossible to
 * miss — gtm-agent#665 silently substituted the box default instead).
 */
export class SandboxModelResolutionError extends Error {
  readonly code: ModelSelectionError
  readonly model: string
  readonly provider?: string
  readonly source: ModelSelectionSource

  constructor(failure: ModelSelectionFailure, context: string) {
    const missing =
      failure.error === 'no_provider'
        ? 'no provider could be resolved for it'
        : `provider "${failure.provider}" resolved but no API key is configured`
    const fix =
      failure.error === 'no_provider'
        ? 'set providerName explicitly (provider cannot be inferred without one)'
        : 'set apiKey (or openaiApiKey when provider is "openai"), or pass allowKeylessModel:true to mint a keyless box'
    super(
      `${context}: model "${failure.model}" (from ${failure.source}) is not transportable — ` +
        `${missing}. Fix: ${fix}. The requested model was NOT sent to the box.`,
    )
    this.name = 'SandboxModelResolutionError'
    this.code = failure.error
    this.model = failure.model
    if (failure.error === 'no_api_key') this.provider = failure.provider
    this.source = failure.source
  }
}

/**
 * Shared fail-loud policy for the sandbox platform's three internal model
 * callers (`ensureWorkspaceSandbox`'s `backendModelAtCreate`,
 * `streamSandboxPrompt`, `driveSandboxTurn`): a `ModelSelection` in, a plain
 * `ResolvedModel | undefined` out, so downstream code is unchanged from
 * before this fix.
 *
 * The policy: success delegates straight through. A failure whose `source`
 * is `'override'` or `'config'` means a model was EXPLICITLY named this turn
 * (or explicitly configured) and could not be sent — that is exactly the
 * silent-substitution defect this fix closes, so it throws
 * {@link SandboxModelResolutionError} rather than letting the caller
 * silently fall back to the box's own default. A failure whose `source` is
 * `'default'` means only a stale `provider.defaultModel` board default
 * couldn't resolve — nobody asked for that model THIS turn, so the
 * historical silent-skip behavior is preserved: it's logged via
 * `console.error` and dropped, letting the box use its own default.
 */
export function requireTransportableModel(
  selection: ModelSelection,
  context: string,
): ResolvedModel | undefined {
  if (selection.succeeded) return selection.value
  if (selection.source === 'default') {
    const reason =
      selection.error === 'no_api_key'
        ? `provider "${selection.provider}" has no api key`
        : 'no provider resolved'
    console.error(
      `[sandbox] ${context}: dropping provider.defaultModel "${selection.model}" (${reason}); using the box default`,
    )
    return undefined
  }
  throw new SandboxModelResolutionError(selection, context)
}
