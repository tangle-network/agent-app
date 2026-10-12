---
"@tangle-network/agent-app": patch
---

`agent-app-signoff` browser checks keep Chromium's HTTP cache and fail an over-budget run. 0.60.141 aborted `/cdn-cgi/speculation` with `context.route`, and Playwright turns the HTTP cache off for any context with a route, so every page reload re-downloaded every asset (creative production smoke: 1900 requests, busiest 10 s 373 against a budget of 250). The route is gone; the Chromium flags already ignore speculation rules. `shell-alignment`, `workspace-surface` and `surface-ladder` now exit 3 (`NETWORK_OVER_BUDGET_EXIT`) when the pages pass but the busiest 10 s went over the budget, and print `FAIL network: …`. New exports: `isOverBudget`, `networkExitCode`, `NETWORK_OVER_BUDGET_EXIT`.
