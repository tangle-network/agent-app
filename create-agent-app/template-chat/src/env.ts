/**
 * src/env.ts — the Cloudflare bindings + vars this worker reads.
 *
 * Locally these come from wrangler.toml `[vars]` + `.dev.vars` (secrets); in
 * production from the dashboard / `wrangler secret put`. See
 * `.dev.vars.example` for the full list with comments.
 */

export interface AppEnv {
  /** D1 database — run `migrations/` against it before first boot. */
  DB: D1Database

  /** Absolute origin better-auth serves from (e.g. http://localhost:8787). */
  BETTER_AUTH_URL: string
  /** better-auth HMAC secret (secret; set in .dev.vars / `wrangler secret`). */
  BETTER_AUTH_SECRET: string

  /** Overrides `config.model.default` without a redeploy. */
  MODEL_NAME?: string
  /** Tangle Router key the harness bills model calls against. */
  TANGLE_API_KEY?: string
  /** Tangle Router base URL; omit for the platform default. */
  TANGLE_ROUTER_URL?: string

  /** Sandbox gateway credentials. Without them every turn fails loud with a
   *  clear error — there is no mock fallback. */
  SANDBOX_API_KEY?: string
  SANDBOX_GATEWAY_URL?: string

  // Optional R2 bucket for product artifacts — OFF by default. Uncomment the
  // `[[r2_buckets]]` block in wrangler.toml and this binding together.
  // ARTIFACTS: R2Bucket
}
