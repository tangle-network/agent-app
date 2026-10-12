---
"@tangle-network/agent-app": patch
---

Workspace export retries a sandbox the platform failed to resume (HTTP 5xx) instead of failing the export after three quick attempts, and spaces every deferred retry at least 30 seconds apart (up to 20, about ten minutes). An advance with nothing runnable skips reading the plan.
