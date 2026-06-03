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

export interface ResolveModelOptions {
  /** Env to read (defaults to process.env). */
  env?: Record<string, string | undefined>
  /** Router base URL default when `TANGLE_ROUTER_BASE_URL` is unset. */
  defaultRouterBaseUrl?: string
}

export const DEFAULT_TANGLE_ROUTER_BASE_URL = 'https://router.tangle.tools/v1'

function requireEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
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
