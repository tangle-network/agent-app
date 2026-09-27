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
    id: string;
    name?: string;
    _provider?: string;
    provider?: string;
}
/** Define possible origins for the chat model configuration values */
export type ChatModelSource = 'request' | 'workspace' | 'env' | 'default';
/** Resolve a chat model with its identifier and source information */
export interface ResolvedChatModel {
    model: string;
    source: ChatModelSource;
}
/** Represent successful chat model validation with a true status and a validated string value */
export interface ChatModelValidationSuccess {
    succeeded: true;
    value: string;
}
/** Describe a failed chat model validation result with an error message */
export interface ChatModelValidationFailure {
    succeeded: false;
    error: string;
}
/** Resolve the outcome of validating a chat model as either success or failure */
export type ChatModelValidationResult = ChatModelValidationSuccess | ChatModelValidationFailure;
/** The catalog-fetch boundary: maps a router base URL to the raw model list. */
export type LoadModels = (routerBaseUrl: string) => Promise<ModelInfo[]>;
/** Resolve the effective chat model input by prioritizing request, workspace, environment, and default models */
export interface ResolveChatModelInput {
    /** Per-request override (highest precedence). */
    requestModel?: string;
    /** Persisted workspace-pinned model. */
    workspaceModel?: string;
    /** The value the deployment's model env var holds (the product reads its own
     *  var name and passes the value — the shell stays env-var-name agnostic). */
    envModel?: string;
    /** Final fallback (the product's default, typically profile.model.default). */
    defaultModel: string;
}
/** Resolve the chat-turn model by the one canonical precedence. Blank values are
 *  treated as absent. */
export declare function resolveChatModel(input: ResolveChatModelInput): ResolvedChatModel;
/** Define input parameters for validating chat model IDs with optional allowlist and catalog access details */
export interface ValidateChatModelIdInput {
    /** Ids accepted without a catalog round-trip (defaults + operator-trusted). */
    allowlist?: Iterable<string>;
    /** The operator-set env model value — always admitted (operator-trusted). */
    envModel?: string;
    /** Catalog loader; required to reach the catalog path. */
    loadModels?: LoadModels;
    /** Catalog endpoint base; required to reach the catalog path. */
    routerBaseUrl?: string;
}
/**
 * Fail-closed model-id validation. Accepts an id only when it is well-formed AND
 * (in the allowlist, or equals the operator-set env model, or served by the live
 * catalog). A bare id (no provider prefix) resolves to its canonical id only when
 * the suffix is unique across the catalog — an ambiguous suffix is rejected
 * rather than silently assigned a provider.
 */
export declare function validateChatModelId(modelId: unknown, input: ValidateChatModelIdInput): Promise<ChatModelValidationResult>;
/** Resolve and return a trimmed string model ID or undefined for invalid or empty input */
export declare function cleanModelId(value: unknown): string | undefined;
/** Validate if a model ID string conforms to length and character format requirements */
export declare function isWellFormedModelId(modelId: string): boolean;
/** Resolve unique catalog IDs associated with a given model including its canonical form if applicable */
export declare function catalogIdsForModel(model: ModelInfo): string[];
export { isUpstreamUnavailable, readHttpStatusHint, runWithModelFailover, buildModelChain, ModelFailoverExhaustedError, UPSTREAM_UNAVAILABLE_CODES, UPSTREAM_UNAVAILABLE_STATUSES, type ModelFailoverAttempt, type ModelFailoverResult, type RunWithModelFailoverInput, } from './failover';
