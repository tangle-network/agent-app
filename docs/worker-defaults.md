# Worker defaults

Every agent-app Worker ships with these Cloudflare settings.
`create-agent-app` writes them into new projects, and `agent-app-signoff` fails a repo whose Wrangler config, or any `[env.*]` in it, lacks them.

```toml
compatibility_date = "2026-09-01"   # or later
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
- **`nodejs_compat` and a current `compatibility_date`.** The floor is `WORKER_COMPATIBILITY_DATE_FLOOR` in `src/signoff/worker-defaults.ts`; raise it together with the templates and the Wrangler version they pin.
  2026-09-01 is the newest date the templates' Wrangler 4.126 runtime accepts in `wrangler dev`; a newer date fails local startup with "the newest date supported by this server binary is …".
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
Measured over 7 days: gtm-agent's D1 primary is in WNAM and 52% of its requests already run at LAX (median wall time 312 ms); its European colos serve a different route mix, so their 138–902 ms medians do not isolate placement.
Enable `[placement] mode = "smart"` per app only after comparing request duration against the 1% of requests Cloudflare keeps unplaced as a baseline.

## Pin the Worker beside its D1 primary

A chat turn makes tens of sequential D1 reads and writes before its first model byte, and D1 has one primary (read replication is off unless you turn it on).
A Worker that runs at the caller's colo pays a cross-country round trip for each one: Legal's `admission.history`, a single query, took 74 ms from LAX against a primary in ENAM.
Read the primary with `GET /accounts/<id>/d1/database/<id>` (`running_in_region`), then pin the Worker next to it with a targeted placement, not Smart Placement:

```toml
[placement]
mode = "targeted"
region = "aws:us-east-1"   # beside an ENAM primary
```

Measured on Legal (`agent-ask` turns, one trace each): over 6 turns before and 5 after, `admission.lock` went from 2.1 to 1.6 s, `admission.before_turn` from 1.19 to 0.71 s and the lane's setup from 1.04 to 0.75 s, and the first model byte from 10.3 to 9.3 s, while the Worker-to-Router leg grew from 0.26 to 0.66 s.
Keep that trade in view: a Worker whose time goes to a far service gains less.

Two hazards of a targeted placement on wrangler 4.127:

- Cloudflare's API cannot serialize the Worker's latest version afterwards (`GET .../workers/workers/<name>/versions/latest` answers `json: error calling MarshalJSON for type *placement.Placement: invalid placement target type`). `wrangler versions secret put` reads that version and fails with code 10013, which blocked Legal's releases until its release script stopped staging a secret that way.
  Deliver a secret with the deploy (`wrangler deploy --secrets-file`) instead of a step that reads the latest version.
- Read a served version by its id (`wrangler versions view <id>`, `wrangler deployments status`), not as `latest`.

## Checking a repo

`agent-app-signoff` runs the check as its `worker defaults` step after install, reading each config through the repo's own `wrangler`, for the top level and every `[env.*]`.
By default it checks every tracked `wrangler*.toml`, `wrangler*.json` and `wrangler*.jsonc`, including named variants such as `wrangler.health.toml`; set `workerConfigs` in `signoff.config.mjs` to name the deployed configs explicitly, for example to leave out a local-only config.
For a Vite-plugin app the check reads the source config the build copies from; whether the build emitted maps is shown by `build/server/*.map`.
The same check is exported as `checkWorkerDefaults` from `@tangle-network/agent-app/signoff`.
