---
"@tangle-network/agent-app": minor
---

`./agent-profiles` exposes `createProductSelfMount({skills, db | kv, baseline, maxMounted})` as the shared self-mount entrypoint. It owns D1/Drizzle or KV adapter selection and table construction internally; products supply their catalog, storage binding, baseline and mount bound.
