---
"@tangle-network/agent-app": patch
---

Accept `@tangle-network/sandbox-ui` 2.0.11. Its 2.0 break is limited to the optional charts peer and the run/trace types, which agent-app does not import; every one of the 49 names agent-app imports from its nine sandbox-ui subpaths is exported by 2.0.11. 2.0.11 is the release whose session hooks call `agents/*` and the runtime proxy path, so the Sandbox dashboard can adopt it before `/v1/sidecar-proxy` is removed.
