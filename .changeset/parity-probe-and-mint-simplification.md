---
'@tangle-network/agent-app': minor
---

`./toolbelt` probe hardening: stdout is now read through `node:readline` (the same line discipline the probed programs use) instead of manual buffer slicing — the timeout diagnostics name every stdout line the probe consumed, not just an unprocessed tail, and the dead line accumulator is gone. `./spend` `deriveChildKeyBudgetUsd` now returns the derived `budgetUsd` directly; the two derivable flags (`derivedFromParent`, `parentRemainingUnknown`) are removed — callers that need them already hold the inputs.
