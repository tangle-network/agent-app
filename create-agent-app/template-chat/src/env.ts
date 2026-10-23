/**
 * src/env.ts — the Cloudflare bindings + vars this worker reads.
 *
 * Locally these come from wrangler.toml `[vars]` + `.dev.vars` (secrets); in
 * production from the dashboard / `wrangler secret put`. See
 * `.dev.vars.example` for the full list with comments.
 */

import type { TurnStreamNamespaceLike, TurnStreamLocationHint } from '@tangle-network/agent-app/turn-stream'

export interface AppEnv {
  /** Shared durable workspace single-flight lock, used by every chat entrypoint. */
  TURN_STREAM?: TurnStreamNamespaceLike
  TURN_STREAM_AUTH_SECRET?: string
  /** Compiled same-origin browser assets. */
  ASSETS?: { fetch(request: Request): Promise<Response> }
  /** D1 database — run `migrations/` against it before first boot. */
  DB: D1Database
  /** Match the D1 primary region; used to place newly created lock channels. */
  D1_REGION?: TurnStreamLocationHint

  /** Absolute origin better-auth serves from (e.g. http://localhost:8787). */
  BETTER_AUTH_URL: string
  /** better-auth HMAC secret (secret; set in .dev.vars / `wrangler secret`). */
  BETTER_AUTH_SECRET: string

  /** Deployment payer opt-in. Public account signup never grants this authority. */
  OPERATOR_RUN_ENABLED?: 'true' | 'false'

  /** Overrides `config.model.default` without a redeploy. */
  MODEL_NAME?: string
  /** Tangle Router key the harness bills model calls against. */
  TANGLE_API_KEY?: string
  /** Tangle Router base URL; omit for the platform default. */
  TANGLE_ROUTER_URL?: string

  /** Ops webhook for platform-limit alarms; without it they go to the Worker log only. */
  SLACK_OPS_WEBHOOK_URL?: string

  /** Sandbox gateway credentials. Without them every turn fails loud with a
   *  clear error — there is no mock fallback. */
  SANDBOX_API_KEY?: string
  SANDBOX_GATEWAY_URL?: string

  // Optional R2 bucket for product artifacts — OFF by default. Uncomment the
  // `[[r2_buckets]]` block in wrangler.toml and this binding together.
  // ARTIFACTS: R2Bucket
}
