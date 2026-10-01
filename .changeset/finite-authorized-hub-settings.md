---
"@tangle-network/agent-app": minor
---

Add `createHubSettingsRoutes` to the platform subpath: a finite Hub SDK settings boundary with per-operation application authorization and caller-account credential binding. Support provider discovery, owned connections, OAuth parameters, API-key metadata, revoke/health, provider actions, and exact single-action policy list/set/reset. Reject arbitrary paths, identity overrides, credential-source mismatches, and bulk permission changes. Preserve SDK error status/code without reflecting secrets. Existing `createHubProxyRoutes` and scaffolding are unchanged.
