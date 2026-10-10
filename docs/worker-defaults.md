# Worker defaults

Every agent-app Worker ships with these Cloudflare settings.
`create-agent-app` writes them into new projects, and `agent-app-signoff` fails a repo whose Wrangler config, or any `[env.*]` in it, lacks them.

```toml
compatibility_date = "2026-09-23"   # or later
compatibility_flags = ["nodejs_compat"]
upload_source_maps = true

[observability]
enabled = true
head_sampling_rate = 1

[observability.logs]
enabled = true
head_sampling_rate = 1
invocation_logs = true

[observability.traces]
enabled = true
head_sampling_rate = 1
```

## Why each key

- **Logs and traces at a sampling rate of 1.** Production incidents are read from Workers Logs and traces.
  Agent apps carry little traffic, so a 0.1 sample mostly drops the failing turn you need.
  `observability.enabled` turns on logs only while tracing is in beta, so traces are enabled explicitly.
- **`upload_source_maps`.** Exceptions in Workers Logs and on-demand CPU and memory profiles then name source functions instead of minified bundle offsets.
- **`nodejs_compat` and a current `compatibility_date`.** The floor is `WORKER_COMPATIBILITY_DATE_FLOOR` in `src/signoff/worker-defaults.ts`; raise it together with the templates.
  Review the [compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/) that turn on between your old and new date before moving a live Worker.

## Apps built with `@cloudflare/vite-plugin`

The Vite plugin writes the deployed Wrangler config and copies `upload_source_maps` into it, but Wrangler can only upload maps the build emitted.
Emit maps for the Worker environment only, so browser assets do not publish theirs, and leave embedded sources out:

```ts
// vite.config.ts — "ssr" is the Worker environment when the plugin sets viteEnvironment: { name: 'ssr' }
environments: { ssr: { build: { sourcemap: true } } },
build: { rolldownOptions: { output: { sourcemapExcludeSources: true } } },
```

Cloudflare caps a Worker's source maps at 15 MB gzipped.
gtm-agent's server maps measured 13.3 MB with embedded sources and 2.6 MB without; mappings and names are all that symbolizing stack traces and profiles needs.
After a build, `build/server` holds `.map` files and `build/client` holds none.

## Smart placement is not a default

Smart placement moves a Worker toward the back end it calls most when that is measurably faster.
Whether it pays depends on each app's D1 region and where its callers are, which a shared default cannot know.
Measured on 2026-10-10 over 7 days: gtm-agent's D1 primary is in WNAM and 52% of its requests already run at LAX (median wall time 312 ms); its European colos serve a different route mix, so their 138–902 ms medians do not isolate placement.
Enable `[placement] mode = "smart"` per app only after comparing request duration against the 1% of requests Cloudflare keeps unplaced as a baseline.

## Checking a repo

`agent-app-signoff` runs the check as its `worker defaults` step after install, reading each config through the repo's own `wrangler` exactly as `wrangler deploy` resolves it.
By default it checks every tracked `wrangler.toml`, `wrangler.json` and `wrangler.jsonc`; set `workerConfigs` in `signoff.config.mjs` to name the deployed configs explicitly.
The same check is exported as `checkWorkerDefaults` from `@tangle-network/agent-app/signoff`.
