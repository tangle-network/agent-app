---
"@tangle-network/agent-app": patch
---

Accept `@tangle-network/sandbox-ui` 0.129 (peer range now `>=0.119.0 <0.130.0`), the release that forwards ui 11.28's control scale, `HelpText` and the 44px sign-in controls. `WorkspaceList` and `ApiAccessPanel` titles render through ui's `PageHeader` (30px page title, description and actions row) instead of their own `<h1>`, so these pages match every product's page titles.
