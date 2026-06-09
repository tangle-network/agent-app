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
  provider: 'openai-compat' | 'anthropic'
  model: string
  apiKey: string
  baseUrl: string
}

export type TangleExecutionEnvironment = 'development' | 'staging' | 'production' | 'test'
export type TangleExecutionKeySource = 'local-env' | 'user'
export type TangleExecutionKeyErrorCode =
  | 'local_tangle_api_key_required'
  | 'tangle_account_not_connected'

export interface ResolveModelOptions {
  /** Env to read (defaults to process.env). */
  env?: Record<string, string | undefined>
  /** Router base URL default when `TANGLE_ROUTER_BASE_URL` is unset. */
  defaultRouterBaseUrl?: string
}

export interface ResolveUserTangleExecutionKeyOptions {
  /** Deployment context. Only local development may fall back to env keys. */
  environment?: TangleExecutionEnvironment
  /** Env to read for the local-development fallback. */
  env?: Record<string, string | undefined>
  /** App-owned lookup for the caller's linked platform API key. */
  getUserApiKey: () => string | null | undefined | Promise<string | null | undefined>
}

export interface ResolveUserTangleExecutionKeyForUserOptions<UserId = string> {
  userId: UserId
  environment?: TangleExecutionEnvironment
  env?: Record<string, string | undefined>
  getUserApiKey: (userId: UserId) => string | null | undefined | Promise<string | null | undefined>
}

export interface ResolvedTangleExecutionKey {
  apiKey: string
  source: TangleExecutionKeySource
}

export interface TangleExecutionKeyHttpError {
  status: number
  body: {
    error: string
    code: TangleExecutionKeyErrorCode
  }
}

export interface CreateTangleRouterModelConfigOptions {
  apiKey: string
  model: string
  baseUrl?: string
}

export interface TangleBillingEnforcementOptions {
  /** Env to read (defaults to process.env). */
  env?: Record<string, string | undefined>
  /**
   * Optional app-specific override flag, e.g. `GTM_BILLING_ENFORCEMENT`.
   * Defaults to the shared `TANGLE_BILLING_ENFORCEMENT`.
   */
  enforcementEnvVar?: string
}

export const DEFAULT_TANGLE_ROUTER_BASE_URL = 'https://router.tangle.tools/v1'
export const DEFAULT_TANGLE_BILLING_ENFORCEMENT_ENV_VAR = 'TANGLE_BILLING_ENFORCEMENT'

function requireEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export class TangleExecutionKeyError extends Error {
  readonly code: TangleExecutionKeyErrorCode
  readonly status: number

  constructor(code: TangleExecutionKeyErrorCode, message: string, status: number) {
    super(message)
    this.name = 'TangleExecutionKeyError'
    this.code = code
    this.status = status
  }
}

export function isTangleExecutionKeyError(error: unknown): error is TangleExecutionKeyError {
  return error instanceof TangleExecutionKeyError
    || (
      typeof error === 'object'
      && error !== null
      && (error as { name?: unknown }).name === 'TangleExecutionKeyError'
      && typeof (error as { code?: unknown }).code === 'string'
      && typeof (error as { status?: unknown }).status === 'number'
    )
}

export function resolveTangleExecutionEnvironment(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): TangleExecutionEnvironment {
  const raw = (env.APP_ENV ?? env.NODE_ENV ?? '').trim().toLowerCase()
  if (raw === 'development' || raw === 'dev' || raw === 'local') return 'development'
  if (raw === 'staging') return 'staging'
  if (raw === 'test') return 'test'
  return 'production'
}

/**
 * Shared policy for agent products that bill through the Tangle Platform.
 *
 * Local development defaults billing enforcement off so apps can use a local
 * `TANGLE_API_KEY` without requiring a browser-linked platform account. Any
 * non-development environment defaults enforcement on. Apps may pass their own
 * override flag (`FOO_BILLING_ENFORCEMENT`) while new apps can use the shared
 * `TANGLE_BILLING_ENFORCEMENT`.
 */
export function isTangleBillingEnforcementDisabled(
  opts: TangleBillingEnforcementOptions = {},
): boolean {
  const env = opts.env ?? (process.env as Record<string, string | undefined>)
  const enforcementEnvVar = opts.enforcementEnvVar ?? DEFAULT_TANGLE_BILLING_ENFORCEMENT_ENV_VAR
  const override = env[enforcementEnvVar]?.trim().toLowerCase()

  if (override === 'disabled') return true
  if (override === 'enabled') return false

  return resolveTangleExecutionEnvironment(env) === 'development'
}

export function tangleExecutionKeyHttpError(error: unknown): TangleExecutionKeyHttpError | null {
  if (!isTangleExecutionKeyError(error)) return null
  return {
    status: error.status,
    body: {
      error: error.message,
      code: error.code,
    },
  }
}

/**
 * Resolve the user-facing Tangle API key for model execution.
 *
 * Local development may use a server env key so apps remain easy to run.
 * Deployed contexts must use the caller's linked platform key; this keeps
 * model execution, billing, and account ownership aligned across products.
 */
export async function resolveUserTangleExecutionKey(
  opts: ResolveUserTangleExecutionKeyOptions,
): Promise<ResolvedTangleExecutionKey> {
  const env = opts.env ?? (process.env as Record<string, string | undefined>)
  const environment = opts.environment ?? resolveTangleExecutionEnvironment(env)

  if (environment === 'development') {
    const apiKey = trimOrNull(env.TANGLE_API_KEY)
    if (apiKey) return { apiKey, source: 'local-env' }
    throw new TangleExecutionKeyError(
      'local_tangle_api_key_required',
      'TANGLE_API_KEY is required for local Tangle model execution.',
      503,
    )
  }

  const apiKey = trimOrNull(await opts.getUserApiKey())
  if (apiKey) return { apiKey, source: 'user' }

  throw new TangleExecutionKeyError(
    'tangle_account_not_connected',
    'Connect your Tangle account before invoking this agent.',
    401,
  )
}

export async function resolveUserTangleExecutionKeyForUser<UserId = string>(
  opts: ResolveUserTangleExecutionKeyForUserOptions<UserId>,
): Promise<ResolvedTangleExecutionKey> {
  return resolveUserTangleExecutionKey({
    environment: opts.environment,
    env: opts.env,
    getUserApiKey: () => opts.getUserApiKey(opts.userId),
  })
}

/**
 * Build an OpenAI-compatible Tangle Router model config from an already
 * resolved execution key. This intentionally does not read TANGLE_API_KEY.
 */
export function createTangleRouterModelConfig(
  opts: CreateTangleRouterModelConfigOptions,
): TangleModelConfig {
  const apiKey = opts.apiKey.trim()
  if (!apiKey) throw new Error('apiKey is required')
  const model = opts.model.trim()
  if (!model) throw new Error('model is required')
  return {
    provider: 'openai-compat',
    model,
    apiKey,
    baseUrl: (opts.baseUrl?.trim() || DEFAULT_TANGLE_ROUTER_BASE_URL).replace(/\/+$/, ''),
  }
}

/**
 * Resolve the model config from env. DEFAULT path (`MODEL_PROVIDER` unset or
 * `openai-compat`/`tangle-router`/`tcloud`): the Tangle Router, authenticated
 * with `TANGLE_API_KEY`, model from `MODEL_NAME`. BYOK path
 * (`MODEL_PROVIDER=anthropic`): direct Anthropic with `ANTHROPIC_API_KEY` +
 * `ANTHROPIC_BASE_URL`. Throws (fail-loud) on a missing required var so a
 * misconfigured deploy fails at boot, not mid-turn.
 */
export function resolveTangleModelConfig(opts: ResolveModelOptions = {}): TangleModelConfig {
  const env = opts.env ?? (process.env as Record<string, string | undefined>)
  const provider = env.MODEL_PROVIDER?.trim() || 'openai-compat'
  const model = requireEnv(env, 'MODEL_NAME')

  if (provider === 'openai-compat' || provider === 'tangle-router' || provider === 'tcloud') {
    return {
      provider: 'openai-compat',
      model,
      apiKey: requireEnv(env, 'TANGLE_API_KEY'),
      baseUrl: (env.TANGLE_ROUTER_BASE_URL?.trim() || opts.defaultRouterBaseUrl || DEFAULT_TANGLE_ROUTER_BASE_URL).replace(/\/+$/, ''),
    }
  }

  if (provider === 'anthropic') {
    return {
      provider,
      model,
      apiKey: requireEnv(env, 'ANTHROPIC_API_KEY'),
      baseUrl: requireEnv(env, 'ANTHROPIC_BASE_URL'),
    }
  }

  throw new Error(`Unsupported MODEL_PROVIDER: ${provider} (use openai-compat for the Tangle Router, or anthropic for BYOK)`)
}
