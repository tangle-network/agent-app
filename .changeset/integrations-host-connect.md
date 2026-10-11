---
"@tangle-network/agent-app": minor
---

`HubIntegrationsPanel` and `useHubIntegrations` accept `hostConnect: { providerIds, onConnect }` for providers the app connects itself, such as a number it provisions. Those catalog rows stay visible and connectable, and choosing one calls `onConnect` instead of starting the Hub API-key or OAuth flow. Apps no longer have to hide such providers from the catalog.
