/**
 * Resolve the model config a Tangle agent's sandbox/runtime runs on.
 *
 * Every Tangle agent product resolves the SAME thing from env: the Tangle Router
 * (OpenAI-compatible, metered at the platform markup against a single
 * `TANGLE_API_KEY`) by default, with a direct-Anthropic BYOK escape hatch. The
 * shape feeds the sandbox SDK's `backend.model`. Lifted here so no product
 * hand-rolls the env parsing + the router default.
 */
export interface TangleModelConfig {
    /** The Tangle Router is OpenAI-compatible → driven via `openai-compat`.
     *  `anthropic` is the BYOK escape hatch. */
    provider: 'openai-compat' | 'anthropic';
    model: string;
    apiKey: string;
    baseUrl: string;
}
/** Define the environment context for executing Tangle operations */
export type TangleExecutionEnvironment = 'development' | 'staging' | 'production' | 'test';
/** Resolve the source of the Tangle execution key as either local environment or user input */
export type TangleExecutionKeySource = 'local-env' | 'user';
/** Define error codes for Tangle execution key issues related to API key and account connection */
export type TangleExecutionKeyErrorCode = 'local_tangle_api_key_required' | 'tangle_account_not_connected';
/** Resolve options for model configuration including environment variables and default router base URL */
export interface ResolveModelOptions {
    /** Env to read (defaults to process.env). */
    env?: Record<string, string | undefined>;
    /** Router base URL default when `TANGLE_ROUTER_BASE_URL` is unset. */
    defaultRouterBaseUrl?: string;
}
/** Resolve options for retrieving user API keys within a specific Tangle execution environment */
export interface ResolveUserTangleExecutionKeyOptions {
    /** Deployment context. Only local development may fall back to env keys. */
    environment?: TangleExecutionEnvironment;
    /** Env to read for the local-development fallback. */
    env?: Record<string, string | undefined>;
    /** App-owned lookup for the caller's linked platform API key. */
    getUserApiKey: () => string | null | undefined | Promise<string | null | undefined>;
}
/** Resolve options for retrieving a user's Tangle execution key with environment and API key access parameters */
export interface ResolveUserTangleExecutionKeyForUserOptions<UserId = string> {
    userId: UserId;
    environment?: TangleExecutionEnvironment;
    env?: Record<string, string | undefined>;
    getUserApiKey: (userId: UserId) => string | null | undefined | Promise<string | null | undefined>;
}
/** Define a resolved key combining an API key with its Tangle execution source */
export interface ResolvedTangleExecutionKey {
    apiKey: string;
    source: TangleExecutionKeySource;
}
/** Resolve options for retrieving a Tangle developer or user API key based on environment and context */
export interface ResolveTangleDevOrUserKeyOptions {
    /** Deployment context. Only local development may use the env key. */
    environment?: TangleExecutionEnvironment;
    /** Env to read for the local-development fallback. */
    env?: Record<string, string | undefined>;
    /** App-owned lookup for the caller's linked platform API key. */
    getUserApiKey: () => string | null | undefined | Promise<string | null | undefined>;
}
/** Represent HTTP error response containing status, error message, and specific error code */
export interface TangleExecutionKeyHttpError {
    status: number;
    body: {
        error: string;
        code: TangleExecutionKeyErrorCode;
    };
}
/** Define configuration options for creating a Tangle router model including API key and model details */
export interface CreateTangleRouterModelConfigOptions {
    apiKey: string;
    model: string;
    baseUrl?: string;
}
/** Define options for configuring billing enforcement environment variables and overrides */
export interface TangleBillingEnforcementOptions {
    /** Env to read (defaults to process.env). */
    env?: Record<string, string | undefined>;
    /**
     * Optional app-specific override flag, e.g. `GTM_BILLING_ENFORCEMENT`.
     * Defaults to the shared `TANGLE_BILLING_ENFORCEMENT`.
     */
    enforcementEnvVar?: string;
}
/** Provide the default base URL for the Tangle router API endpoint */
export declare const DEFAULT_TANGLE_ROUTER_BASE_URL = "https://router.tangle.tools/v1";
/** Define the default environment variable name for Tangle billing enforcement */
export declare const DEFAULT_TANGLE_BILLING_ENFORCEMENT_ENV_VAR = "TANGLE_BILLING_ENFORCEMENT";
/** Resolve a string by trimming whitespace or returning null if empty or undefined */
export declare function trimOrNull(value: string | null | undefined): string | null;
/** Represent execution key errors with specific codes and HTTP status information */
export declare class TangleExecutionKeyError extends Error {
    readonly code: TangleExecutionKeyErrorCode;
    readonly status: number;
    constructor(code: TangleExecutionKeyErrorCode, message: string, status: number);
}
/** Identify whether an error is a TangleExecutionKeyError based on its properties and type */
export declare function isTangleExecutionKeyError(error: unknown): error is TangleExecutionKeyError;
/** Resolve the current Tangle execution environment based on provided or process environment variables */
export declare function resolveTangleExecutionEnvironment(env?: Record<string, string | undefined>): TangleExecutionEnvironment;
/**
 * Shared policy for agent products that bill through the Tangle Platform.
 *
 * Local development defaults billing enforcement off so apps can use a local
 * `TANGLE_API_KEY` without requiring a browser-linked platform account. Any
 * non-development environment defaults enforcement on. Apps may pass their own
 * override flag (`FOO_BILLING_ENFORCEMENT`) while new apps can use the shared
 * `TANGLE_BILLING_ENFORCEMENT`.
 */
export declare function isTangleBillingEnforcementDisabled(opts?: TangleBillingEnforcementOptions): boolean;
/** Resolve and format TangleExecutionKey HTTP errors into a standardized error object or return null */
export declare function tangleExecutionKeyHttpError(error: unknown): TangleExecutionKeyHttpError | null;
/**
 * Shared dev-aware Tangle key resolution. Local development may use a server
 * `TANGLE_API_KEY`; otherwise the caller's linked platform key is used. Returns
 * null when neither resolves, so each caller can throw its own domain error
 * (e.g. model-execution 503/401 vs hub `tangle_link_required` 412).
 */
export declare function resolveTangleDevOrUserKey(opts: ResolveTangleDevOrUserKeyOptions): Promise<ResolvedTangleExecutionKey | null>;
/**
 * Resolve the user-facing Tangle API key for model execution.
 *
 * Local development may use a server env key so apps remain easy to run.
 * Deployed contexts must use the caller's linked platform key; this keeps
 * model execution, billing, and account ownership aligned across products.
 */
export declare function resolveUserTangleExecutionKey(opts: ResolveUserTangleExecutionKeyOptions): Promise<ResolvedTangleExecutionKey>;
/** Resolve the Tangle execution key for a specified user using provided environment and API key options */
export declare function resolveUserTangleExecutionKeyForUser<UserId = string>(opts: ResolveUserTangleExecutionKeyForUserOptions<UserId>): Promise<ResolvedTangleExecutionKey>;
/**
 * Build an OpenAI-compatible Tangle Router model config from an already
 * resolved execution key. This intentionally does not read TANGLE_API_KEY.
 */
export declare function createTangleRouterModelConfig(opts: CreateTangleRouterModelConfigOptions): TangleModelConfig;
/**
 * Resolve the model config from env. DEFAULT path (`MODEL_PROVIDER` unset or
 * `openai-compat`/`tangle-router`/`tcloud`): the Tangle Router, authenticated
 * with `TANGLE_API_KEY`, model from `MODEL_NAME`. BYOK path
 * (`MODEL_PROVIDER=anthropic`): direct Anthropic with `ANTHROPIC_API_KEY` +
 * `ANTHROPIC_BASE_URL`. Throws (fail-loud) on a missing required var so a
 * misconfigured deploy fails at boot, not mid-turn.
 */
export declare function resolveTangleModelConfig(opts?: ResolveModelOptions): TangleModelConfig;
