---
"@tangle-network/agent-app": minor
---

`./agent-profiles` ships shared self-mount storage adapters: `createDrizzleSelfMountStorage(db, table, baseline)` for D1/drizzle, `createKVSelfMountStorage(kv, prefix, baseline)` for Cloudflare KV, and the one-call `createProductSelfMount({skills, db | kv, baseline, maxMounted})` that wires catalog + storage + the verb in one call. Every product that was hand-writing a 60-line adapter (legal, creative, gtm — each with the same scope+JSON shape) is now 3 lines: import, call, register. The `selfMountTable(tableName)` helper creates the standard drizzle table.
