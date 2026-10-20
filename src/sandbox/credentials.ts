import { type TangleExecutionEnvironment, trimOrNull, resolveTangleExecutionEnvironment } from '../runtime/model'

/** Define client credentials for accessing the sandbox environment with API key and base URL */
export interface SandboxClientCredentials {
  apiKey: string
  baseUrl: string
}

/**
 * Sandbox credential policy reuses the canonical execution-environment union
 * (development/test/staging/production) so env classification stays in one place
 * (see resolveTangleExecutionEnvironment in runtime/model).
 */
export type SandboxCredentialEnvironment = TangleExecutionEnvironment

/** Resolve options for obtaining sandbox client credentials from environment variables and classification */
export interface ResolveSandboxClientCredentialsOptions {
  /**
   * Environment object to read from. Defaults to process.env when available.
   */
  env?: Record<string, string | undefined>
  /**
   * Explicit environment classification. Defaults to APP_ENV/NODE_ENV derived
   * behavior: local/development/test use direct env credentials; staging/prod
   * require the provision callback unless allowDirectEnvCredentials opts in.
   */
  environment?: SandboxCredentialEnvironment
  /**
   * Env names that may carry a sandbox-compatible bearer. The first non-empty
   * value wins when direct env credentials are allowed.
   */
  directKeyNames?: readonly string[]
  /**
   * Env names that may carry the sandbox gateway URL. The first non-empty value
   * wins, then defaultBaseUrl.
   */
  baseUrlNames?: readonly string[]
  /**
   * Base URL used when none of baseUrlNames are present.
   */
  defaultBaseUrl?: string
  /**
   * Whether direct env credentials are allowed for this environment. Defaults
   * to true in development/test and false in staging/production.
   */
  allowDirectEnvCredentials?: boolean | ((environment: SandboxCredentialEnvironment) => boolean)
  /**
   * Product-owned provision path, usually minting a per-user sandbox key from a
   * linked platform account. Called before direct env credentials in
   * staging/production and after direct env credentials in development/test.
   */
  provision?: (
    context: {
      environment: SandboxCredentialEnvironment
      env: Record<string, string | undefined>
    },
  ) => SandboxClientCredentials | null | undefined | Promise<SandboxClientCredentials | null | undefined>
}

const DEFAULT_SANDBOX_DIRECT_KEY_NAMES = [
  'TCLOUD_SANDBOX_API_KEY',
  'SANDBOX_API_KEY',
  'TANGLE_API_KEY',
] as const

const DEFAULT_SANDBOX_BASE_URL_NAMES = ['SANDBOX_GATEWAY_URL', 'SANDBOX_API_URL'] as const

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/v1\/?$/, '').replace(/\/+$/, '')
}

function processEnv(): Record<string, string | undefined> {
  return typeof process === 'undefined' ? {} : process.env
}

function directEnvCredentialsAllowed(
  environment: SandboxCredentialEnvironment,
  allow: ResolveSandboxClientCredentialsOptions['allowDirectEnvCredentials'],
): boolean {
  if (typeof allow === 'function') return allow(environment)
  if (typeof allow === 'boolean') return allow
  return environment === 'development' || environment === 'test'
}

function resolveSandboxBaseUrl(
  env: Record<string, string | undefined>,
  names: readonly string[],
  defaultBaseUrl: string | undefined,
): string {
  for (const name of names) {
    const value = trimOrNull(env[name])
    if (value) return normalizeBaseUrl(value)
  }
  const value = trimOrNull(defaultBaseUrl)
  if (value) return normalizeBaseUrl(value)
  throw new Error(
    `Sandbox base URL is required (set one of ${names.join(', ')} or pass defaultBaseUrl).`,
  )
}

function resolveDirectSandboxCredentials(
  env: Record<string, string | undefined>,
  keyNames: readonly string[],
  baseUrlNames: readonly string[],
  defaultBaseUrl: string | undefined,
): SandboxClientCredentials | null {
  for (const name of keyNames) {
    const apiKey = trimOrNull(env[name])
    if (!apiKey) continue
    return {
      apiKey,
      baseUrl: resolveSandboxBaseUrl(env, baseUrlNames, defaultBaseUrl),
    }
  }
  return null
}

/** Resolve sandbox client credentials based on environment and provided options asynchronously */
export async function resolveSandboxClientCredentials(
  options: ResolveSandboxClientCredentialsOptions = {},
): Promise<SandboxClientCredentials> {
  const env = options.env ?? processEnv()
  const environment = options.environment ?? resolveTangleExecutionEnvironment(env)
  const keyNames = options.directKeyNames ?? DEFAULT_SANDBOX_DIRECT_KEY_NAMES
  const baseUrlNames = options.baseUrlNames ?? DEFAULT_SANDBOX_BASE_URL_NAMES
  const directAllowed = directEnvCredentialsAllowed(environment, options.allowDirectEnvCredentials)
  const direct = () =>
    directAllowed
      ? resolveDirectSandboxCredentials(env, keyNames, baseUrlNames, options.defaultBaseUrl)
      : null

  if (environment === 'development' || environment === 'test') {
    const credentials = direct()
    if (credentials) return credentials
  }

  const provisioned = await options.provision?.({ environment, env })
  if (provisioned) {
    return {
      apiKey: provisioned.apiKey,
      baseUrl: normalizeBaseUrl(provisioned.baseUrl),
    }
  }

  const credentials = direct()
  if (credentials) return credentials

  const directHint = directAllowed
    ? ` or set one of ${keyNames.join(', ')}`
    : ''
  throw new Error(
    `Sandbox credentials are required for ${environment} (provide a provision callback${directHint}).`,
  )
}
