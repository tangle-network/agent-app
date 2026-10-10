---
"@tangle-network/agent-app": patch
---

Ship every agent-app Worker with the shared Cloudflare defaults: logs and traces at a sampling rate of 1, uploaded source maps, `nodejs_compat` and a 2026-09-23 compatibility date. `create-agent-app` templates now write them, and `agent-app-signoff` runs a built-in `worker defaults` step that fails a repo whose Wrangler config or any of its environments lacks them. See docs/worker-defaults.md.
