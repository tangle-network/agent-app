---
"@tangle-network/agent-app": minor
---

`agent-app-conformance --computer none` (and `checkDeployedApp({ computer: 'none' })`) runs the plain turn only and records no computer-turn result, so a post-serve first-ask check asks exactly once per run. `digest` stays the default.
