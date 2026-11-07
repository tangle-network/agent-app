---
"@tangle-network/agent-app": patch
---

Record the harness's own token cost beside the ledger charge. Sandbox 1.0.264 made `PromptResult.costUsd` the Platform ledger charge only, so a failed native turn recorded `cost_usd = null` and its model spend disappeared. `ChatTurnUsage.harnessCostUsd`, the chat-store `harness_cost_usd` column and `OperatorTurn.harnessCostUsd` now carry the harness-reported cost (step-finish `cost`, terminal `totalCostUsd`, and for a failed execution the replayed `error`/`done` frames); `costUsd`/`cost_usd` holds only the ledger charge. Apps using `createChatTables()` must add the column before adopting: `ALTER TABLE message ADD COLUMN harness_cost_usd REAL;` (the chat template ships it as `migrations/0007_harness_cost.sql`). Spend readers read `harnessCostUsd`.
