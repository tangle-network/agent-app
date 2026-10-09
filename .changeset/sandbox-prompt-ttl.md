---
"@tangle-network/agent-app": patch
---

`streamSandboxPrompt` forwards `ttlMs`, the execution time limit, to the prompt admission on both the direct and detached paths. Unset, the runtime cuts a run at its one-hour default, so a product whose agent turns run longer names the limit here. `timeoutMs` stays the shorter first-output budget.
