---
"@tangle-network/agent-app": patch
---

`HubIntegrationsPanel` clears the selected provider and connection before a host SPA interceptor handles Back, returning to Accounts without a reload. The Back link retains its href and modified-click behavior through `@tangle-network/sandbox-ui` 1.1.10.
