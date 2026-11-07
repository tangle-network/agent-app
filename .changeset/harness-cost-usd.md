---
"@tangle-network/agent-app": patch
---

Record the harness's own token cost beside the ledger charge. Sandbox 1.0.264 made `PromptResult.costUsd` the Platform ledger charge only, so a failed native turn recorded `cost_usd = null` and its model spend disappeared. `ChatTurnUsage.harnessCostUsd` and `OperatorTurn.harnessCostUsd` carry the harness-reported cost; `costUsd` holds only the ledger charge. The chat-store column is optional: a table that declares `harnessCostColumns()` in `messageExtraColumns` (after `ALTER TABLE message ADD COLUMN harness_cost_usd REAL;`, shipped in the chat template as `migrations/0007_harness_cost.sql`) stores it, and a table without it keeps working unchanged.
