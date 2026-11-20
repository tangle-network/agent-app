---
"@tangle-network/agent-app": patch
---

Accept `@tangle-network/agent-eval` 2: the peer range is now `^1.0.0 || ^2.0.1`, so a product can install agent-eval 2.0.1 beside the shell under strict peers. Development runs on agent-eval 2.0.1 with agent-knowledge 23.0.7 and agent-runtime 10.0.10, and both generated-app templates start on that cohort. No shell source changed: every agent-eval symbol the shell imports exists with a compatible shape in 1.0.0 and 2.0.1. `pnpm test:generated` now also installs the packed shell into bare consumers beside the release under test and the lowest release of each admitted agent-eval major, and imports every public entry there.
