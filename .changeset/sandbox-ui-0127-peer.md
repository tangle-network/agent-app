---
"@tangle-network/agent-app": patch
---

The `@tangle-network/sandbox-ui` peer range accepts 0.127, so apps can install sandbox-ui 0.127.1, whose `.tangle-prose` keeps list markers and wraps long URLs. 0.127.0 removed only helpers that agent-app never imports (`createFetchTransport`, `clampReasoningLevel`, `hasProviderLogo`). Development, tests and the chat template run against 0.127.1.
