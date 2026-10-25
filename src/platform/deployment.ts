/**
 * Where this deployment reaches the Tangle platform, read from its environment
 * at call time so a Worker's bindings are current.
 */

/**
 * The platform base URL: `TANGLE_PLATFORM_URL`, or the legacy `TANGLE_SSO_URL`
 * until every environment is migrated.
 */
const env = (): Record<string, string | undefined> =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}

export function platformBaseUrlFromEnv(): string {
  const url = env().TANGLE_PLATFORM_URL ?? env().TANGLE_SSO_URL
  if (!url) throw new Error('TANGLE_PLATFORM_URL is required (or legacy TANGLE_SSO_URL)')
  return url
}

/**
 * Options for the platform's cross-site SSO client: the base URL, the app id
 * registered in the platform's trusted-apps registry (`TANGLE_PLATFORM_APP_ID`,
 * else the product's own), and a fetch the client can call as a method. A
 * Worker's `fetch` stored on an instance and called as `this.fetchImpl()`
 * throws "Illegal invocation", so the global is wrapped in a free call.
 */
export function platformAuthClientOptionsFromEnv(
  defaultAppId: string,
  overrides: { baseUrl?: string; appId?: string; fetchImpl?: typeof fetch } = {},
): { baseUrl: string; appId: string; fetchImpl: typeof fetch } {
  return {
    baseUrl: overrides.baseUrl ?? platformBaseUrlFromEnv(),
    appId: overrides.appId ?? env().TANGLE_PLATFORM_APP_ID ?? defaultAppId,
    fetchImpl: overrides.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
  }
}
