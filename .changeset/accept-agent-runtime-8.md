---
"@tangle-network/agent-app": patch
---

Accept `@tangle-network/agent-runtime` 8.0.0 as a peer, keeping the 1, 2 and 3 lines. 8.0.0 only adds the optional `checkPlacement` to `RunGraphOptions`, which `src/signoff/schedule.ts` uses, and requires `resources` on a known `ProfileMaterializationReceipt`, which agent-app does not construct.
