---
"@tangle-network/agent-app": patch
---

Sandbox backends carry the turn model as the nested `model: { model, provider, apiKey?, apiKeyEnv?, baseUrl? }` object again. Sandbox SDK 1.0.75 and later drop flat `modelId`/`provider`/`apiKey`/`baseUrl` in `normalizeRuntimeBackendConfig`, so since #1456 a turn ran on the box defaults and a per-turn delegated key never arrived. `backendModelFields` and `resolveSandboxPromptBackend` now return `model`; read `backend.model.model` instead of `backend.modelId`.
