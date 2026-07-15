/**
 * Example `preflight.config.mjs` — legal-agent's four secret-liveness probes.
 *
 * Copy this to a product's repo root. The deploy workflow runs
 * `agent-app-preflight` (added by this package's `bin`) as a step before
 * `wrangler deploy`; a dead secret fails the deploy with a message naming
 * exactly which secret to rotate.
 *
 * Each probe below guards a secret from the 2026-07-15 incident — four secrets
 * dead in one production day, all present in `wrangler secret list`, none
 * checked for liveness anywhere:
 *   1. routerChatProbe  → LITELLM_API_KEY (dead key) + LITELLM_BASE_URL (dead url)
 *   2. sandboxAuthProbe → SANDBOX_API_KEY (dead key) + SANDBOX_API_URL (stale url)
 *   3. httpHeadProbe    → TANGLE_PLATFORM_URL reachability (stale platform url)
 *   4. httpHeadProbe    → session-gateway reachability (non-critical: warn only)
 *
 * The config reads nothing but `process.env`, so the same file runs in the
 * deploy environment, a smoke test, or a local check.
 */
import { httpHeadProbe, routerChatProbe, sandboxAuthProbe } from '@tangle-network/agent-app/preflight'

const env = process.env

const trimSlash = (url) => (url ?? '').replace(/\/+$/, '')

export default [
  routerChatProbe({
    name: 'router-chat',
    baseUrl: env.LITELLM_BASE_URL,
    apiKey: env.LITELLM_API_KEY,
    model: env.PREFLIGHT_ROUTER_MODEL ?? 'gpt-4o-mini',
    keySecret: 'LITELLM_API_KEY',
    urlSecret: 'LITELLM_BASE_URL',
  }),
  sandboxAuthProbe({
    name: 'sandbox-auth',
    baseUrl: env.SANDBOX_API_URL,
    apiKey: env.SANDBOX_API_KEY,
    keySecret: 'SANDBOX_API_KEY',
    urlSecret: 'SANDBOX_API_URL',
  }),
  httpHeadProbe({
    name: 'tangle-platform',
    url: `${trimSlash(env.TANGLE_PLATFORM_URL)}/health`,
    urlSecret: 'TANGLE_PLATFORM_URL',
  }),
  httpHeadProbe({
    name: 'session-gateway',
    url: `${trimSlash(env.SESSION_GATEWAY_URL)}/health`,
    urlSecret: 'SESSION_GATEWAY_URL',
    // A degraded gateway should warn the operator, not block a deploy that fixes
    // other secrets — the interactive stream reconnects when it recovers.
    critical: false,
  }),
]
