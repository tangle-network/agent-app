---
"@tangle-network/agent-app": patch
---

Turn trace export takes its wire ids and OTLP encoding from `@tangle-network/agent-trace-contract` 2.2.0. `otlpTraceId` is now the contract's `toW3CTraceId`, so a readable turn id maps to the same OTLP trace id as the Sandbox SDK, agent-eval and agent-runtime map it; turn traces exported before and after this change do not join. An all-zero trace id is no longer passed through.
