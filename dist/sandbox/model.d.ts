/** Define configuration options for resolving a provider and its model with optional API keys and routing details */
export interface ProviderResolutionConfig {
    routerBaseUrl?: string;
    apiKey?: string;
    providerName?: string;
    modelName?: string;
    defaultModel?: string;
    openaiApiKey?: string;
    allowKeylessModel?: boolean;
}
/** Represent a fully configured model with optional API key and base URL for sandbox platform integration */
export interface ResolvedModel {
    model: string;
    provider: string;
    apiKey?: string;
    baseUrl?: string;
}
/**
 * Why a model failed to resolve into something transportable to the sandbox
 * platform. `no_provider` — a model id exists but no provider name could be
 * derived (no explicit `providerName`, and no key present to infer one from).
 * `no_api_key` — a provider AND model both resolved, but no credential is
 * configured and the caller did not opt into `allowKeylessModel`.
 */
export type ModelSelectionError = 'no_provider' | 'no_api_key';
/**
 * Which precedence slot supplied the failed/succeeded model id:
 * `override` — the caller's per-turn `{ model }` argument.
 * `config` — `provider.modelName`.
 * `default` — `provider.defaultModel` (only ever consulted for an
 * openai/openai-compat provider shape).
 */
export type ModelSelectionSource = 'override' | 'config' | 'default';
/**
 * A model id was named (by override, config, or default) but is not
 * transportable to the sandbox platform. Carries enough to explain WHY
 * without the caller re-deriving the override/config/default precedence
 * chain itself (that re-derivation is how gtm-agent#665 happened — a caller
 * guessed loudness from the wrong slot and dropped a user-selected model).
 */
export type ModelSelectionFailure = {
    succeeded: false;
    error: 'no_provider';
    model: string;
    source: ModelSelectionSource;
} | {
    succeeded: false;
    error: 'no_api_key';
    model: string;
    provider: string;
    source: ModelSelectionSource;
};
/**
 * The three-state outcome of resolving a model: `{ succeeded: true, value:
 * undefined }` means NOTHING was requested (the legitimate box-default
 * configuration — not an error); `{ succeeded: true, value: ResolvedModel }`
 * means a fully transportable model resolved; anything else is a
 * {@link ModelSelectionFailure} — a model WAS named but can't be sent.
 */
export type ModelSelection = {
    succeeded: true;
    value: ResolvedModel | undefined;
} | ModelSelectionFailure;
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
export declare function resolveModelSelection(config: ProviderResolutionConfig | undefined, override?: {
    model?: string;
    modelApiKey?: string;
}): ModelSelection;
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
export declare function resolveModel(config: ProviderResolutionConfig | undefined, override?: {
    model?: string;
    modelApiKey?: string;
}): ResolvedModel | undefined;
/**
 * Thrown by {@link requireTransportableModel} when a model that was
 * EXPLICITLY requested via a per-turn `{ model }` override cannot be
 * transported to the sandbox platform. The message names the model, which
 * precedence slot supplied it, what's missing, and the fix, and states
 * plainly that the requested model was NOT sent to the box (the failure mode
 * this error exists to make impossible to miss — gtm-agent#665 silently
 * substituted the box default instead of a user-selected model).
 *
 * The error class itself carries no opinion about *when* it should be
 * thrown — it is constructed from any {@link ModelSelectionFailure},
 * regardless of `source`. A caller wanting a stricter policy (e.g. also
 * fail-loud on an untransportable configured `provider.modelName`) can call
 * {@link resolveModelSelection} directly and throw this itself.
 */
export declare class SandboxModelResolutionError extends Error {
    readonly code: ModelSelectionError;
    readonly model: string;
    readonly provider?: string;
    readonly source: ModelSelectionSource;
    constructor(failure: ModelSelectionFailure, context: string);
}
/**
 * Shared fail-loud policy for the sandbox platform's three internal model
 * callers (`ensureWorkspaceSandbox`'s `backendModelAtCreate`,
 * `streamSandboxPrompt`, `driveSandboxTurn`): a `ModelSelection` in, a plain
 * `ResolvedModel | undefined` out, so downstream code is unchanged from
 * before this fix.
 *
 * The policy: success delegates straight through. A failure whose `source`
 * is `'override'` means a PER-TURN model was explicitly selected THIS turn
 * (a live, user-driven choice — passed as `{ model }`) and could not be
 * sent; substituting the box default there is exactly the gtm-agent#665
 * defect, so it throws {@link SandboxModelResolutionError} rather than
 * silently falling back.
 *
 * A failure whose `source` is `'config'` or `'default'` means a
 * *configured* `provider.modelName` / `provider.defaultModel` couldn't
 * resolve — nobody made a choice this turn; the value came from board
 * config that may simply describe "the platform supplies the credential."
 * Shipped consumers rely on exactly that: tax-agent ships a shell with
 * `provider: { providerName: 'openai-compat', modelName, routerBaseUrl }`
 * and no `apiKey`/`allowKeylessModel`, with a contract test asserting
 * `ensureWorkspaceSandbox` creation SUCCEEDS with the model silently
 * dropped so the sandbox platform mints its own in-container credential
 * (`apps/web/tests/sandbox-service-contract.test.ts`). A config-loud policy
 * here would break every fresh tax sandbox provisioning and every tax turn.
 * So both `'config'` and `'default'` keep the pre-#302 logged-skip
 * behavior: `console.error` and drop, letting the box use its own default.
 * A product wanting strict enforcement of a configured `provider.modelName`
 * can call {@link resolveModelSelection} directly and apply its own policy.
 */
export declare function requireTransportableModel(selection: ModelSelection, context: string): ResolvedModel | undefined;
