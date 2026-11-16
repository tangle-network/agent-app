---
"@tangle-network/agent-app": patch
---

A workspace child key from a budgeted source can spend through the source's cap instead of reserving its own share of it. `ensureKey(identity, { budgetUsd, spendThrough: true })` mints a child with no budget of its own, so the several children a member holds while older ones finish their turns no longer reserve the same money several times over and refuse a mint the source could pay for. A spend-through child is not retired when its source is spent: Platform refuses each request, and a Router turn reports that 402 as a top-up message. Sources without a budget keep sized children.
